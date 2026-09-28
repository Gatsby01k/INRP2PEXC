'use server';

import { revalidatePath } from 'next/cache';
import type { FiatRail } from '@inrp2p/db';
import { revealBankAccount } from '@inrp2p/clients';
import { executeCommand } from '@inrp2p/commands';
import { confirmRouteSettlement, recordRouteSettlement } from '@inrp2p/settlement';
import {
  approveTrader, assignRequest, configureTraderProgram, confirmReserveWithdrawal, confirmRewardPayout, failRewardPayout, pauseTrader, reconcileOrderNow,
  recordReserveWithdrawalSent, recordRewardPayout, rejectReserveWithdrawal, rejectTrader, releaseOrder, resumeTrader, setTraderAssignments, setTraderLimits,
  setTraderRequiredReserve, setTraderReward, setTraderSettlementDetails,
} from '@inrp2p/traders';
import { type CommandResult, failure, runCommand } from '../command.ts';
import { operatorContext } from '../operator.ts';
import { protectorForWeb } from '../quotes.ts';

/**
 * The desk's trader controls, as server actions. Each runs one command that authorizes itself (traders:view to
 * see, traders:assign to route, traders:pause / traders:configure / trader_payout:* for decisions — step-up where
 * SECURITY §3 says so) and writes its own audit event. Nothing here decides anything.
 */
function refresh(): void {
  revalidatePath('/', 'layout');
}

async function run<P, R>(name: string, build: Parameters<typeof runCommand<P, R>>[0], payload: P, key: string): Promise<CommandResult<R>> {
  const out = await runCommand(build, payload, { name, idempotencyKey: key });
  if (out.ok) refresh();
  return out;
}

export async function configureProgramAction(
  input: { expectedVersion: number; defaultRequiredReserve?: string | null; rewardBps?: number | null; offerTtlSeconds?: number; holdTtlSeconds?: number; autoAssign?: boolean; collectionAccountId?: string | null; reason: string },
  key: string,
): Promise<CommandResult<{ version: number }>> {
  return run('trader_program.configure', (ctx) => configureTraderProgram(ctx.actor), input, key);
}

export async function approveTraderAction(
  input: { traderId: string; requiredReserve?: string | null; rewardBps?: number | null; maxOrderInr?: string | null; maxOrderUsdt?: string | null; maxCapacityInr?: string | null; maxCapacityUsdt?: string | null; note?: string | null },
  key: string,
): Promise<CommandResult<unknown>> {
  return run('trader.approve', (ctx) => approveTrader(ctx.actor), input, key);
}

export async function rejectTraderAction(input: { traderId: string; note: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader.reject', (ctx) => rejectTrader(ctx.actor), input, key);
}

export async function pauseTraderAction(input: { traderId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader.pause', (ctx) => pauseTrader(ctx.actor), input, key);
}

export async function resumeTraderAction(input: { traderId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader.resume', (ctx) => resumeTrader(ctx.actor), input, key);
}

export async function setAssignmentsAction(input: { traderId: string; enabled: boolean; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader.set_assignments', (ctx) => setTraderAssignments(ctx.actor), input, key);
}

export async function setLimitsAction(
  input: { traderId: string; maxOrderInr?: string | null; maxOrderUsdt?: string | null; maxCapacityInr?: string | null; maxCapacityUsdt?: string | null; reason: string },
  key: string,
): Promise<CommandResult<unknown>> {
  return run('trader.set_limits', (ctx) => setTraderLimits(ctx.actor), input, key);
}

export async function setRequiredReserveAction(input: { traderId: string; requiredReserve: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader.set_required_reserve', (ctx) => setTraderRequiredReserve(ctx.actor), input, key);
}

export async function setRewardAction(input: { traderId: string; rewardBps: number | null; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader.set_reward', (ctx) => setTraderReward(ctx.actor), input, key);
}

export async function setSettlementDetailsAction(input: { traderId: string; bankAccountId: string; walletId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader.set_settlement_details', (ctx) => setTraderSettlementDetails(ctx.actor), input, key);
}

/** Route a request to the best eligible trader. The refusal, when nobody can take it, carries why. */
export async function assignRequestAction(input: { requestId: string; plannedClientRate?: string | null }, key: string): Promise<CommandResult<{ ref: string; traderRef: string; rate: string; base: string; inr: string; offerExpiresAt: string }>> {
  return run('trader_order.assign', (ctx) => assignRequest(ctx.actor), input, key);
}

export async function releaseOrderAction(input: { orderId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_order.release', (ctx) => releaseOrder(ctx.actor), input, key);
}

/**
 * INRP2P's own side of a trader order, and the confirmation of either side: the route-settlement commands the
 * desk already uses (`route_settlement:record`, `route_settlement:confirm` ⧗), followed by bringing the order up
 * to date at once instead of waiting for the next sweep.
 */
export async function recordOrderSettlementAction(
  input: {
    routeObligationId: string; flow: 'FROM_ROUTE_TO_EXCHANGE' | 'TO_ROUTE'; amount: string;
    rail?: FiatRail; utr?: string; inrAccountId?: string | null; txHash?: string; logIndex?: number; fromAddress?: string; treasuryWalletId?: string | null;
  },
  key: string,
): Promise<CommandResult<unknown>> {
  return run('route_settlement.record', (ctx, deps) => recordRouteSettlement(ctx.actor, deps), input, key);
}

export async function confirmOrderSettlementAction(input: { orderId: string; routeSettlementId: string }, key: string): Promise<CommandResult<unknown>> {
  const out = await runCommand((ctx, deps) => confirmRouteSettlement(ctx.actor, deps), { routeSettlementId: input.routeSettlementId }, { name: 'route_settlement.confirm', idempotencyKey: key });
  if (!out.ok) return out;
  try {
    const ctx = await operatorContext();
    await reconcileOrderNow(ctx.db, input.orderId);
  } catch (e) {
    // The settlement is confirmed either way; the sweep brings the order up to date if this step failed.
    return failure(e);
  } finally {
    refresh();
  }
  return out;
}

export async function recordWithdrawalSentAction(input: { withdrawalId: string; txHash: string; logIndex?: number }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_reserve.record_withdrawal_sent', (ctx, deps) => recordReserveWithdrawalSent(ctx.actor, { chain: deps.chain }), input, key);
}

export async function confirmWithdrawalAction(input: { withdrawalId: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_reserve.confirm_withdrawal', (ctx, deps) => confirmReserveWithdrawal(ctx.actor, { chain: deps.chain }), input, key);
}

export async function rejectWithdrawalAction(input: { withdrawalId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_reserve.reject_withdrawal', (ctx) => rejectReserveWithdrawal(ctx.actor), input, key);
}

export async function recordRewardPayoutAction(input: { traderId: string; amount: string; inrAccountId: string; rail: FiatRail; utr: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_reward.record_payout', (ctx) => recordRewardPayout(ctx.actor), input, key);
}

export async function confirmRewardPayoutAction(input: { payoutId: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_reward.confirm_payout', (ctx) => confirmRewardPayout(ctx.actor), input, key);
}

export async function failRewardPayoutAction(input: { payoutId: string; reason: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_reward.fail_payout', (ctx) => failRewardPayout(ctx.actor), input, key);
}

/**
 * Reveals a trader's registered bank account number (`bank_account:reveal`, ⧗, audited). Deliberately run with no
 * idempotency key: the command refuses one, because a stored command result would keep the plaintext.
 */
export async function revealBankAccountAction(input: { bankAccountId: string }): Promise<CommandResult<{ accountNumber: string }>> {
  try {
    const ctx = await operatorContext();
    const out = await executeCommand(ctx.db, revealBankAccount(ctx.actor, protectorForWeb()), {
      name: 'bank_account.reveal',
      actor: { type: 'USER', id: ctx.actor.userId, surface: 'OPERATOR', sessionId: ctx.actor.sessionId },
      payload: { bankAccountId: input.bankAccountId, purpose: 'trader settlement details review' },
      financial: false,
    });
    return { ok: true, result: out.result };
  } catch (e) {
    return failure(e);
  }
}
