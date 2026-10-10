'use server';

import { revalidatePath } from 'next/cache';
import type { FiatRail, TraderSide } from '@inrp2p/db';
import {
  type ApplyPayload, type ProposeSettlementPayload, acceptOrder, applyAsTrader, cancelReserveWithdrawal, declineOrder, orderDeliveryAddress, proposeSettlementChange,
  type ClaimedDeposit, claimReserveDeposit, requestReserveWithdrawal, setAvailability, submitOrderPayment, updateBlock,
} from '@inrp2p/traders';
import { hitRateLimit } from '@inrp2p/commands';
import { type CommandResult, failure } from '../command.ts';
import { runWorkspaceCommand, workspaceContext } from '../client.ts';
import { chainForWeb } from '../chain.ts';

/**
 * What a trader can do, as server actions. Each one runs a trader command as the signed-in person: the client comes
 * from the membership inside the transaction (or, for a new applicant's first application, is created by it), the
 * command checks the authority it needs (an admin to apply or submit settlement details, someone who can commit for
 * everything that binds money), and nothing here decides anything. The Exchange's gate is not these commands' gate:
 * a trader applicant and a client that provides capacity only have no Exchange.
 */
function refresh(): void {
  revalidatePath('/traders', 'layout');
}

/** Codes whose domain wording is right for a trader and the desk's shared phrasing is not. */
const TRADER_WORDING: ReadonlySet<string> = new Set(['CAPACITY_INSUFFICIENT', 'INVALID_TRANSITION']);

async function run<P, R>(name: string, build: Parameters<typeof runWorkspaceCommand<P, R>>[0], payload: P, key: string): Promise<CommandResult<R>> {
  const out = await runWorkspaceCommand(build, payload, { name, idempotencyKey: key, keepMessages: TRADER_WORDING });
  if (out.ok) refresh();
  return out;
}

/** The application: the applicant's details, what they provide, and their own bank account and wallet for review. */
export async function applyAsTraderAction(input: ApplyPayload, key: string): Promise<CommandResult<{ ref: string }>> {
  return run('trader.apply', (_ctx, deps) => applyAsTrader(_ctx.actor, { protector: deps.protector }), input, key);
}

/** A new bank account or wallet for the desk to review; the registered one keeps working until it approves (TD-24). */
export async function proposeSettlementChangeAction(input: ProposeSettlementPayload, key: string): Promise<CommandResult<{ bankStatus: string | null; walletStatus: string | null }>> {
  return run('trader.propose_settlement_change', (ctx, deps) => proposeSettlementChange(ctx.actor, { protector: deps.protector }), input, key);
}

/** Switching on or off. No sound, no notification: the trader did it and is looking at it. */
export async function setAvailabilityAction(input: { available: boolean }, key: string): Promise<CommandResult<{ available: boolean; offersWithdrawn: number }>> {
  return run('trader.set_availability', (ctx) => setAvailability(ctx.actor), input, key);
}

export async function updateBlockAction(
  input: { side: TraderSide; expectedVersion: number; capacity?: string; rate?: string; minOrder?: string; maxOrder?: string; status?: 'ACTIVE' | 'PAUSED' },
  key: string,
): Promise<CommandResult<{ version: number; offersWithdrawn: number }>> {
  return run('trader.update_block', (ctx) => updateBlock(ctx.actor), input, key);
}

export async function acceptOrderAction(input: { ref: string }, key: string): Promise<CommandResult<{ holdUntil: string }>> {
  return run('trader_order.accept', (ctx) => acceptOrder(ctx.actor), input, key);
}

export async function declineOrderAction(input: { ref: string; reason?: string | null }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_order.decline', (ctx) => declineOrder(ctx.actor), input, key);
}

export async function submitOrderPaymentAction(input: { ref: string; rail: FiatRail; utr: string; amount?: string }, key: string): Promise<CommandResult<{ settlementRef: string }>> {
  return run('trader_order.submit_payment', (ctx) => submitOrderPayment(ctx.actor, { chain: chainForWeb() }), input, key);
}

export async function orderDeliveryAddressAction(input: { ref: string }, key: string): Promise<CommandResult<{ address: string; amount: string }>> {
  return run('trader_order.delivery_address', (ctx, deps) => orderDeliveryAddress(ctx.actor, { custody: deps.custody }), input, key);
}

/**
 * The hash of a transfer the trader made to the shared reserve address (D-17). Counted per person before anything
 * is read from the chain: a hash costs provider calls, and nobody needs more than a few a minute.
 */
export async function claimDepositAction(input: { txHash: string }, key: string): Promise<CommandResult<{ deposits: readonly ClaimedDeposit[] }>> {
  try {
    const ctx = await workspaceContext();
    await hitRateLimit(ctx.db, { bucket: 'trader_reserve_claim', subject: ctx.actor.userId, limit: 10, windowSeconds: 600 });
  } catch (e) {
    return failure(e);
  }
  return run('trader_reserve.claim_deposit', (ctx) => claimReserveDeposit(ctx.actor, { chain: chainForWeb() }), input, key);
}

export async function requestWithdrawalAction(input: { amount: string }, key: string): Promise<CommandResult<{ ref: string }>> {
  return run('trader_reserve.request_withdrawal', (ctx) => requestReserveWithdrawal(ctx.actor), input, key);
}

export async function cancelWithdrawalAction(input: { ref: string }, key: string): Promise<CommandResult<unknown>> {
  return run('trader_reserve.cancel_withdrawal', (ctx) => cancelReserveWithdrawal(ctx.actor), input, key);
}
