import { sql } from 'kysely';
import { DomainError, formatTrx, normalizeTronAddress, requireText, requireUuid } from '@inrp2p/kernel';
import type { ChainSendBearer, ChainSendPurpose, ChainSendStatus, Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, authorizeOperator, operatorCommand } from '@inrp2p/identity';
import { lockTrader } from '@inrp2p/trader-core';
import { lockFunder, networkAvailable, networkBudgetWallet } from './budget.ts';

/**
 * A send is one on-chain transfer the exchange's signer will make (ADR 0017 §4): planned here, inside the command that
 * decides it, and signed, broadcast and followed to its end by the worker (`@inrp2p/onchain`). What it pays, from where
 * and to whom is checked by the database against its business (IX106): a payout leg's own destination, a trader's
 * registered wallet, the trade's own top-up.
 */

/** The custody HD account in force, if the exchange runs one. */
export async function custodyHdAccount(ex: Executor) {
  return ex.selectFrom('custody_hd_account').selectAll().executeTakeFirst();
}

/** The derivation path of a deposit address the custody HD account issued — the signer can send from it — or null. */
export async function signablePathOf(ex: Executor, address: string): Promise<string | null> {
  const a = normalizeTronAddress(address);
  const d = await ex
    .selectFrom('deposit_address as d')
    .innerJoin('custody_hd_account as h', 'h.provider', 'd.provider')
    .select('d.custody_reference')
    .where('d.network', '=', 'TRON')
    .where('d.address', '=', a)
    .where('d.source', '=', 'DERIVED')
    .executeTakeFirst();
  if (d) return d.custody_reference;
  const fee = await ex.selectFrom('custody_hd_account').select('fee_wallet_path').where('fee_wallet_address', '=', a).executeTakeFirst();
  return fee?.fee_wallet_path ?? null;
}

export interface PlanSendInput {
  readonly purpose: ChainSendPurpose;
  readonly asset: 'USDT' | 'TRX';
  readonly tradeId?: string | null;
  readonly legId?: string | null;
  readonly routeObligationId?: string | null;
  readonly parentSendId?: string | null;
  readonly withdrawalId?: string | null;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amountMinor: bigint;
  readonly feeEstimateSun?: bigint;
  readonly funder: string | null;
  readonly bearer: ChainSendBearer;
  readonly needsApproval: boolean;
  readonly requestedBy: string;
  /** Set when the person planning it is the second person the send needs (a refund planned by its approver). */
  readonly approvedBy?: string | null;
}

export async function planChainSend(ctx: TxContext, input: PlanSendInput): Promise<{ sendId: string; ref: string; status: ChainSendStatus }> {
  const path = await signablePathOf(ctx.tx, input.fromAddress);
  if (!path) throw new DomainError('CUSTODY_PATH_REFUSED', `${input.fromAddress} is not an address the exchange's signer holds`);
  const awaiting = input.needsApproval && !input.approvedBy;
  const row = await ctx.tx
    .insertInto('chain_send')
    .values({
      asset: input.asset,
      purpose: input.purpose,
      trade_id: input.tradeId ?? null,
      settlement_leg_id: input.legId ?? null,
      route_obligation_id: input.routeObligationId ?? null,
      parent_send_id: input.parentSendId ?? null,
      withdrawal_id: input.withdrawalId ?? null,
      from_address: normalizeTronAddress(input.fromAddress),
      from_path: path,
      to_address: normalizeTronAddress(input.toAddress),
      amount_minor: input.amountMinor,
      fee_estimate_sun: input.feeEstimateSun ?? 0n,
      funder_trader_id: input.funder,
      bearer: input.bearer,
      status: awaiting ? 'AWAITING_APPROVAL' : 'PLANNED',
      needs_approval: input.needsApproval,
      requested_by: input.requestedBy,
      approved_by: input.approvedBy ?? null,
      approved_at: input.approvedBy ? sql<Date>`inrp2p_now()` : null,
    })
    .returning(['id', 'ref', 'status'])
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'chain_send.planned', entityType: 'chain_send', entityId: row.id,
    after: {
      ref: row.ref, purpose: input.purpose, asset: input.asset, amount: input.asset === 'TRX' ? `${formatTrx(input.amountMinor)} TRX` : input.amountMinor.toString(),
      from: input.fromAddress, to: input.toAddress, trade_id: input.tradeId ?? null, bearer: input.bearer, status: row.status, approved_by: input.approvedBy ?? null,
    },
  });
  await enqueueOutbox(ctx, { type: 'chain_send.planned', aggregateType: 'chain_send', aggregateId: row.id, payload: { sendId: row.id, status: row.status } });
  return { sendId: row.id, ref: row.ref, status: row.status };
}

export async function lockSend(ctx: TxContext, sendId: string) {
  const row = await ctx.tx.selectFrom('chain_send').selectAll().where('id', '=', requireUuid(sendId, 'sendId')).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'send not found');
  return row;
}

/** The send paying a leg, if the signer pays it (any state but cancelled). */
export async function sendOfLeg(ex: Executor, legId: string) {
  return ex.selectFrom('chain_send').selectAll().where('settlement_leg_id', '=', legId).where('status', '<>', 'CANCELLED').executeTakeFirst();
}

/** The live route payment of an obligation, if one is planned or under way. */
export async function liveRoutePaymentOf(ex: Executor, routeObligationId: string) {
  return ex.selectFrom('chain_send').selectAll().where('route_obligation_id', '=', routeObligationId).where('purpose', '=', 'ROUTE_PAYMENT')
    .where('status', 'not in', ['CONFIRMED', 'CANCELLED']).executeTakeFirst();
}

/**
 * `chain_send.approve` — `chain_send:approve` (⧗✱): the second person a send above the payout threshold needs, never
 * the one who asked for it (SECURITY §4, C1). A refund send is approved through `refund:approve` when it is planned.
 */
export function approveChainSend(actor: OperatorActor) {
  return operatorCommand(actor, 'chain_send:approve', async (ctx, p: { sendId: string }) => {
    const send = await lockSend(ctx, p.sendId);
    if (send.status !== 'AWAITING_APPROVAL') throw new DomainError('INVALID_TRANSITION', `send ${send.ref} is ${send.status.toLowerCase()}`);
    const approver = ctx.actor.id ?? 'SYSTEM';
    if (approver === send.requested_by || approver === 'SYSTEM') throw new DomainError('SECOND_APPROVER_REQUIRED', 'a send is approved by someone other than the person who asked for it');
    if (send.purpose === 'REFUND') await authorizeOperator(ctx.tx, actor, 'refund:approve');
    await ctx.tx.updateTable('chain_send').set({ status: 'PLANNED', approved_by: approver, approved_at: sql<Date>`inrp2p_now()`, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    await appendAudit(ctx, { action: 'chain_send.approved', entityType: 'chain_send', entityId: send.id, before: { status: 'AWAITING_APPROVAL' }, after: { status: 'PLANNED', approved_by: approver } });
    await enqueueOutbox(ctx, { type: 'chain_send.planned', aggregateType: 'chain_send', aggregateId: send.id, payload: { sendId: send.id, status: 'PLANNED' } });
    return { status: 'PLANNED' as const, ref: send.ref };
  });
}

/**
 * `network_withdrawal.decide` — `network_withdrawal:decide` (⧗). Approving plans the send of the TRX to the trader's
 * registered wallet from the budget wallet (the signer makes it); rejecting closes the request with the reason.
 */
export function decideNetworkWithdrawal(actor: OperatorActor) {
  return operatorCommand(actor, 'network_withdrawal:decide', async (ctx, p: { withdrawalId: string; approve: boolean; reason?: string }) => {
    const peek = await ctx.tx.selectFrom('network_deposit_withdrawal').select('trader_id').where('id', '=', requireUuid(p.withdrawalId, 'withdrawalId')).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', 'withdrawal not found');
    const trader = await lockTrader(ctx, peek.trader_id);
    const w = await ctx.tx.selectFrom('network_deposit_withdrawal').selectAll().where('id', '=', p.withdrawalId).forUpdate().executeTakeFirstOrThrow();
    if (w.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `withdrawal ${w.ref} is ${w.status.toLowerCase()}`);
    const by = ctx.actor.id ?? 'SYSTEM';
    if (!p.approve) {
      const reason = requireText(p.reason, 'reason', 500);
      await ctx.tx.updateTable('network_deposit_withdrawal').set({ status: 'REJECTED', decided_by: by, decided_at: sql<Date>`inrp2p_now()`, closed_at: sql<Date>`inrp2p_now()`, close_reason: reason }).where('id', '=', w.id).execute();
      await appendAudit(ctx, { action: 'network.withdrawal_rejected', entityType: 'trader_profile', entityId: trader.id, after: { ref: w.ref, reason } });
      return { status: 'REJECTED' as const };
    }
    const wallet = await ctx.tx.selectFrom('crypto_wallet').select(['address', 'status']).where('id', '=', trader.wallet_id).executeTakeFirstOrThrow();
    if (wallet.status !== 'ACTIVE' || wallet.address !== w.to_address) throw new DomainError('TRADER_DESTINATION_INVALID', 'the trader’s registered wallet changed since the request; ask it to request again');
    const budget = await networkBudgetWallet(ctx.tx);
    if (!budget) throw new DomainError('WALLET_NOT_ACTIVE', 'no network budget wallet is active');
    await lockFunder(ctx, trader.id);
    // The request already holds its amount and fee (IX108): it stays covered from request to send.
    if ((await networkAvailable(ctx.tx, trader.id)) < 0n) throw new DomainError('NETWORK_BUDGET_INSUFFICIENT', 'the trader’s deposit no longer covers this withdrawal');
    await ctx.tx.updateTable('network_deposit_withdrawal').set({ status: 'APPROVED', decided_by: by, decided_at: sql<Date>`inrp2p_now()` }).where('id', '=', w.id).execute();
    const send = await planChainSend(ctx, {
      purpose: 'DEPOSIT_WITHDRAWAL', asset: 'TRX', withdrawalId: w.id, fromAddress: budget.address, toAddress: w.to_address, amountMinor: w.amount_sun,
      feeEstimateSun: w.fee_estimate_sun, funder: trader.id, bearer: 'TRADER', needsApproval: false, requestedBy: by,
    });
    await appendAudit(ctx, { action: 'network.withdrawal_approved', entityType: 'trader_profile', entityId: trader.id, after: { ref: w.ref, send: send.ref } });
    return { status: 'APPROVED' as const, sendRef: send.ref };
  });
}

export interface SendRow {
  readonly id: string;
  readonly ref: string;
  readonly purpose: ChainSendPurpose;
  readonly asset: 'USDT' | 'TRX';
  readonly status: ChainSendStatus;
  readonly tradeId: string | null;
  readonly amountMinor: bigint;
  readonly from: string;
  readonly to: string;
  readonly bearer: ChainSendBearer;
  readonly funder: string | null;
  readonly needsApproval: boolean;
  readonly approvedBy: string | null;
  readonly blockedReason: string | null;
  readonly lastError: string | null;
  readonly failedAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly attempts: readonly {
    readonly seq: number; readonly txid: string; readonly status: string; readonly broadcasts: number; readonly expiration: Date; readonly feeSun: bigint | null;
    readonly energyUsed: bigint | null; readonly result: string | null; readonly blockNumber: bigint | null; readonly lastBroadcastResult: string | null;
  }[];
}

/** Sends with their attempts, newest first — for the desk, by trade or across the exchange. */
export async function listSends(ex: Executor, filter: { tradeId?: string; open?: boolean; limit?: number } = {}): Promise<SendRow[]> {
  let q = ex.selectFrom('chain_send').selectAll().orderBy('created_at', 'desc').limit(filter.limit ?? 100);
  if (filter.tradeId) q = q.where('trade_id', '=', requireUuid(filter.tradeId, 'tradeId'));
  if (filter.open) q = q.where('status', 'not in', ['CONFIRMED', 'CANCELLED']);
  const sends = await q.execute();
  if (sends.length === 0) return [];
  const attempts = await ex.selectFrom('chain_send_attempt').selectAll().where('send_id', 'in', sends.map((s) => s.id)).orderBy('seq').execute();
  return sends.map((s) => ({
    id: s.id, ref: s.ref, purpose: s.purpose, asset: s.asset, status: s.status, tradeId: s.trade_id, amountMinor: s.amount_minor, from: s.from_address, to: s.to_address,
    bearer: s.bearer, funder: s.funder_trader_id, needsApproval: s.needs_approval, approvedBy: s.approved_by, blockedReason: s.blocked_reason, lastError: s.last_error,
    failedAttempts: s.failed_attempts, createdAt: s.created_at, updatedAt: s.updated_at,
    attempts: attempts.filter((a) => a.send_id === s.id).map((a) => ({
      seq: a.seq, txid: a.txid, status: a.status, broadcasts: a.broadcasts, expiration: a.expiration, feeSun: a.fee_sun, energyUsed: a.energy_used, result: a.result,
      blockNumber: a.block_number, lastBroadcastResult: a.last_broadcast_result,
    })),
  }));
}
