'use server';

import { revalidatePath } from 'next/cache';
import type { FiatRail, TraderSide } from '@inrp2p/db';
import {
  type ApplyPayload, type ProposeSettlementPayload, acceptOrder, applyAsTrader, cancelReserveWithdrawal, confirmOrderPaymentReceived, declineOrder, orderDeliveryAddress, proposeSettlementChange,
  type ClaimedDeposit, claimReserveDeposit, requestReserveWithdrawal, setAvailability, submitOrderPayment, updateBlock, answerOrderDispute, disputeOrderPayment,
} from '@inrp2p/traders';
import type { P2pDisputeReason } from '@inrp2p/settlement';
import { cancelNetworkWithdrawal, claimNetworkDeposit, requestNetworkWithdrawal } from '@inrp2p/network';
import type { TrxTransferFacts } from '@inrp2p/adapters';
import { DomainError } from '@inrp2p/kernel';
import { hitRateLimit } from '@inrp2p/commands';
import { type CommandResult, failure } from '../command.ts';
import { runWorkspaceCommand, workspaceContext } from '../client.ts';
import { chainForWeb, sendNetworkForWeb } from '../chain.ts';

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
const TRADER_WORDING: ReadonlySet<string> = new Set(['CAPACITY_INSUFFICIENT', 'INVALID_TRANSITION', 'DISPUTE_EXISTS', 'NOT_THE_PAYEE', 'NOT_THE_PAYER', 'P2P_PAYMENT_WINDOW_CLOSED']);

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

/**
 * ADR 0019, a P2P sell: the buyer's rupees reached the trader's own account, and its bank shows who sent them. The
 * verdict comes back as it is — a name that is not the buyer's is not counted, and the screen says so.
 */
export async function confirmOrderPaymentReceivedAction(
  input: { ref: string; senderName: string; senderAccount?: string | null },
  key: string,
): Promise<CommandResult<{ verdict: string; confirmed: boolean }>> {
  const out = await run('trader_order.confirm_received', (ctx) => confirmOrderPaymentReceived(ctx.actor, { chain: chainForWeb() }), input, key);
  return out.ok ? { ok: true, result: { verdict: out.result.verdict, confirmed: out.result.confirmed } } : out;
}

/** A P2P Sell USDT order whose buyer's rupees did not arrive (block 9): the deal stops, INRP2P decides from the trader's bank. */
export async function disputeOrderPaymentAction(input: { ref: string; reason: P2pDisputeReason; note?: string | null }, key: string): Promise<CommandResult<{ ref: string }>> {
  return run('trader_order.dispute', (ctx) => disputeOrderPayment(ctx.actor), input, key);
}

/** The trader's side, for INRP2P, when the seller says the trader's rupees did not arrive. */
export async function answerOrderDisputeAction(input: { ref: string; note: string }, key: string): Promise<CommandResult<{ ref: string }>> {
  return run('trader_order.answer_dispute', (ctx) => answerOrderDispute(ctx.actor), input, key);
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

/**
 * The hash of a TRX transfer the trader made to the network budget wallet (ADR 0017 §2). Read from the providers
 * before the command, final or refused; the command credits it only if the trader's registered wallet sent it.
 */
export async function claimNetworkDepositAction(input: { txHash: string }, key: string): Promise<CommandResult<{ credited: boolean; amount: string }>> {
  let facts: TrxTransferFacts;
  try {
    const ctx = await workspaceContext();
    await hitRateLimit(ctx.db, { bucket: 'trader_network_claim', subject: ctx.actor.userId, limit: 10, windowSeconds: 600 });
    const hash = input.txHash.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new DomainError('INVALID_ARGUMENT', 'a transaction hash is 64 hexadecimal characters');
    const read = await sendNetworkForWeb().trxTransfer(hash);
    if (read.status !== 'FINAL') throw new DomainError('NETWORK_DEPOSIT_NOT_FOUND', read.status === 'NOT_A_TRX_TRANSFER' ? read.reason : 'TRON has not made this transaction final yet; try again in a minute');
    facts = read.transfer;
  } catch (e) {
    return failure(e);
  }
  return run('network_deposit.claim', (ctx) => claimNetworkDeposit(ctx.actor, facts), input, key);
}

export async function requestNetworkWithdrawalAction(input: { amount: string }, key: string): Promise<CommandResult<{ withdrawalId: string; ref: string }>> {
  return run('network_withdrawal.request', (ctx) => requestNetworkWithdrawal(ctx.actor), input, key);
}

export async function cancelNetworkWithdrawalAction(input: { withdrawalId: string }, key: string): Promise<CommandResult<{ status: 'CANCELLED' }>> {
  return run('network_withdrawal.cancel', (ctx) => cancelNetworkWithdrawal(ctx.actor), input, key);
}
