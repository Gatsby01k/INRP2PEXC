import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type ClientActor, type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { Accounts, accountBalance } from '@inrp2p/ledger';
import { allocateTraderReserveAddress } from '@inrp2p/treasury';
import { lockMovement, postMovement, recordCryptoTransfer, verifyCryptoTransfer } from '@inrp2p/settlement';
import { lockTrader, lockTraderOfClient, traderClientCommand, type TraderDeps } from '@inrp2p/trader-core';

/**
 * The Security Reserve, from the ledger and nothing else.
 *
 * - `balance` — what the ledger owes the trader on `LIAB:TRADER_RESERVE` (deposits confirmed on chain, less
 *   withdrawals confirmed on chain).
 * - `locked` — the required amount, while the trader provides liquidity or has an order open: it protects those
 *   orders and anything still unresolved on them. Switching off does not unlock it until the last order finishes.
 * - `pendingRelease` — a withdrawal on its way back to the trader's registered wallet.
 * - `available` — what may be withdrawn now: the balance less what is locked and what is already on its way.
 * - `shortfall` — how much is missing for the trader to receive new orders.
 *
 * No figure here is computed in the browser, estimated, or taken from anywhere but the ledger and the rows.
 */
export interface ReserveFigures {
  readonly balance: Money<'USDT'>;
  readonly required: Money<'USDT'> | null;
  readonly locked: Money<'USDT'>;
  readonly pendingRelease: Money<'USDT'>;
  readonly available: Money<'USDT'>;
  readonly shortfall: Money<'USDT'>;
  /** True while the reserve is locked because the trader is online or has an order open. */
  readonly engaged: boolean;
  readonly openOrders: number;
}

export async function reserveBalance(ex: Executor, traderId: string): Promise<Money<'USDT'>> {
  const net = await accountBalance(ex, Accounts.traderReserve(traderId));
  // A liability is a credit balance: DR − CR is negative when the exchange owes the trader.
  return Money.ofMinor(-net, 'USDT');
}

export async function reserveFigures(ex: Executor, traderId: string): Promise<ReserveFigures> {
  const id = requireUuid(traderId, 'traderId');
  const profile = await ex.selectFrom('trader_profile').select(['available', 'required_reserve_minor']).where('id', '=', id).executeTakeFirstOrThrow();
  const balance = await reserveBalance(ex, id);
  const counts = await sql<{ open: string; withdrawing: string }>`
    select
      (select count(*) from trader_order where trader_id = ${id} and status in ('ACCEPTED', 'IN_PROGRESS'))::text as open,
      (select coalesce(sum(amount_minor), 0) from trader_reserve_withdrawal where trader_id = ${id} and status in ('REQUESTED', 'SENT'))::text as withdrawing`.execute(ex);
  const openOrders = Number.parseInt(counts.rows[0]!.open, 10);
  const withdrawing = BigInt(counts.rows[0]!.withdrawing);
  const required = profile.required_reserve_minor;
  const engaged = profile.available || openOrders > 0;
  const free = balance.minor - withdrawing;
  const locked = engaged && required !== null ? (free < required ? (free > 0n ? free : 0n) : required) : 0n;
  const available = free - locked;
  const shortfall = required !== null && free < required ? required - free : 0n;
  return {
    balance,
    required: required === null ? null : Money.ofMinor(required, 'USDT'),
    locked: Money.ofMinor(locked, 'USDT'),
    pendingRelease: Money.ofMinor(withdrawing, 'USDT'),
    available: Money.ofMinor(available > 0n ? available : 0n, 'USDT'),
    shortfall: Money.ofMinor(shortfall, 'USDT'),
    engaged,
    openOrders,
  };
}

/** True when the reserve covers the requirement (after anything already on its way out). */
export function reserveFunded(f: ReserveFigures): boolean {
  return f.required !== null && f.shortfall.isZero();
}

/**
 * `trader.reserve_address` — a user who can commit for the trader. The trader's own reserve deposit address,
 * issued once through the custody provider and kept open: USDT that reaches it from the trader's registered wallet
 * is credited to the reserve when the chain makes it final. Attribution is the address alone (D-02).
 */
export function traderReserveAddress(actor: ClientActor, deps: Pick<TraderDeps, 'custody'>) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, _p: Record<string, never>, member) => {
    const trader = await lockTraderOfClient(ctx, member.clientId);
    if (trader.status !== 'APPROVED' && trader.status !== 'PAUSED') throw new DomainError('TRADER_NOT_APPROVED', 'your application has not been approved yet');
    if (trader.required_reserve_minor === null) throw new DomainError('TRADER_RESERVE_NOT_SET', 'the Security Reserve has not been set');
    const allocation = await allocateTraderReserveAddress(ctx, deps.custody, {
      network: 'TRON', traderId: trader.id, traderRef: trader.ref, expectedAmount: Money.ofMinor(trader.required_reserve_minor, 'USDT'),
    });
    await appendAudit(ctx, { action: 'trader_reserve.address_issued', entityType: 'trader_profile', entityId: trader.id, after: { deposit_address_id: allocation.depositAddressId } });
    return { address: allocation.address };
  });
}

/**
 * `trader_reserve.request_withdrawal` — a user who can commit. At most what is available now (never the locked
 * part, never what is already on its way), to the trader's registered wallet as it is at this moment. One open
 * withdrawal at a time. The amount is held at once, so it cannot also be counted towards switching on.
 */
export function requestReserveWithdrawal(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { amount: string }, member) => {
    const amount = Money.parse(p.amount, 'USDT');
    if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'enter an amount to withdraw');
    const trader = await lockTraderOfClient(ctx, member.clientId);
    const open = await ctx.tx.selectFrom('trader_reserve_withdrawal').select('ref').where('trader_id', '=', trader.id).where('status', 'in', ['REQUESTED', 'SENT']).executeTakeFirst();
    if (open) throw new DomainError('TRADER_WITHDRAWAL_OPEN', `withdrawal ${open.ref} is already on its way`);
    const figures = await reserveFigures(ctx.tx, trader.id);
    if (amount.minor > figures.available.minor) {
      throw new DomainError('TRADER_WITHDRAWAL_EXCEEDS_AVAILABLE', `you can withdraw up to ${figures.available.toDecimalString()} USDT now`, { available: figures.available.toDecimalString() });
    }
    const wallet = await ctx.tx.selectFrom('crypto_wallet').select(['address', 'status']).where('id', '=', trader.wallet_id).executeTakeFirstOrThrow();
    if (wallet.status !== 'ACTIVE') throw new DomainError('TRADER_DESTINATION_INVALID', 'your registered wallet is no longer active; ask the desk to review your settlement details');
    const row = await ctx.tx
      .insertInto('trader_reserve_withdrawal')
      .values({ trader_id: trader.id, amount_minor: amount.minor, destination_address: wallet.address, requested_by: member.userId })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'trader_reserve.withdrawal_requested', entityType: 'trader_reserve_withdrawal', entityId: row.id, after: { ref: row.ref, amount, trader_id: trader.id } });
    await enqueueOutbox(ctx, { type: 'trader.withdrawal_requested', aggregateType: 'trader_reserve_withdrawal', aggregateId: row.id, payload: { withdrawalId: row.id, traderId: trader.id } });
    return { withdrawalId: row.id, ref: row.ref };
  });
}

/** `trader_reserve.cancel_withdrawal` — a user who can commit, while nothing has been sent yet. */
export function cancelReserveWithdrawal(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string }, member) => {
    const trader = await lockTraderOfClient(ctx, member.clientId);
    const w = await ctx.tx.selectFrom('trader_reserve_withdrawal').select(['id', 'status']).where('trader_id', '=', trader.id).where('ref', '=', requireText(p.ref, 'ref', 20)).forUpdate().executeTakeFirst();
    if (!w) throw new DomainError('NOT_FOUND', 'withdrawal not found');
    if (w.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `the withdrawal is ${w.status}`);
    await ctx.tx
      .updateTable('trader_reserve_withdrawal')
      .set({ status: 'CANCELLED', closed_at: sql<Date>`inrp2p_now()`, closed_by: member.userId, close_reason: 'cancelled by the trader' })
      .where('id', '=', w.id)
      .execute();
    await appendAudit(ctx, { action: 'trader_reserve.withdrawal_cancelled', entityType: 'trader_reserve_withdrawal', entityId: w.id, before: { status: 'REQUESTED' }, after: { status: 'CANCELLED' } });
    return { status: 'CANCELLED' as const };
  });
}

/**
 * `trader_reserve.record_withdrawal_sent` — `trader_payout:record`. The desk sent the USDT from a treasury wallet in
 * the custody provider's own tooling and hands over the transaction hash. The facts are read from the chain, not
 * typed: the transfer must exist, be USDT on the configured contract, leave an ACTIVE treasury wallet, and pay the
 * requested amount to the trader's registered wallet — otherwise nothing is written.
 */
export function recordReserveWithdrawalSent(actor: OperatorActor, deps: Pick<TraderDeps, 'chain'>) {
  return operatorCommand(actor, 'trader_payout:record', async (ctx, p: { withdrawalId: string; txHash: string; logIndex?: number }) => {
    const w0 = await ctx.tx.selectFrom('trader_reserve_withdrawal').select('trader_id').where('id', '=', requireUuid(p.withdrawalId, 'withdrawalId')).executeTakeFirst();
    if (!w0) throw new DomainError('NOT_FOUND', 'withdrawal not found');
    await lockTrader(ctx, w0.trader_id);
    const w = await ctx.tx.selectFrom('trader_reserve_withdrawal').selectAll().where('id', '=', p.withdrawalId).forUpdate().executeTakeFirstOrThrow();
    if (w.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `the withdrawal is ${w.status}`);
    const txHash = requireText(p.txHash, 'txHash', 66).toLowerCase().replace(/^0x/, '');
    const logIndex = p.logIndex ?? 0;
    const receipt = await deps.chain.lookupTransfer('TRON', txHash, logIndex);
    if (!receipt) throw new DomainError('NOT_FOUND', 'the chain does not know this transfer');
    if (receipt.tokenContract !== deps.chain.tokenContract) throw new DomainError('INVALID_ARGUMENT', 'this transfer is not USDT on the configured contract');
    if (receipt.toAddress !== w.destination_address) throw new DomainError('INVALID_ARGUMENT', "this transfer does not pay the trader's registered wallet");
    if (receipt.amountMinor !== w.amount_minor) throw new DomainError('INVALID_AMOUNT', 'this transfer does not pay the requested amount');
    const wallet = await ctx.tx.selectFrom('treasury_wallet').select(['id', 'status']).where('network', '=', 'TRON').where('address', '=', receipt.fromAddress).executeTakeFirst();
    if (!wallet || wallet.status !== 'ACTIVE') throw new DomainError('TREASURY_WALLET_NOT_ACTIVE', 'this transfer does not leave an active treasury wallet');
    const recorded = await recordCryptoTransfer(ctx, {
      txHash, logIndex, tokenContract: receipt.tokenContract, fromAddress: receipt.fromAddress, toAddress: receipt.toAddress,
      amount: Money.ofMinor(receipt.amountMinor, 'USDT'),
      payerType: 'EXCHANGE_TREASURY', payerId: wallet.id, payeeType: 'TRADER', payeeId: w.trader_id, source: 'OPERATOR_SUBMITTED',
    });
    if (recorded.existing) throw new DomainError('DUPLICATE_TX_HASH', 'that transaction is already recorded');
    await ctx.tx
      .updateTable('trader_reserve_withdrawal')
      .set({ status: 'SENT', treasury_wallet_id: wallet.id, crypto_transfer_id: recorded.transferId, sent_recorded_by: actorLabel(ctx), sent_at: sql<Date>`inrp2p_now()` })
      .where('id', '=', w.id)
      .execute();
    await appendAudit(ctx, { action: 'trader_reserve.withdrawal_sent', entityType: 'trader_reserve_withdrawal', entityId: w.id, before: { status: 'REQUESTED' }, after: { status: 'SENT', transfer_id: recorded.transferId } });
    return { status: 'SENT' as const };
  });
}

/**
 * `trader_reserve.confirm_withdrawal` — `trader_payout:confirm` (⧗). Once the chain has made the transfer final, the
 * one movement journal posts (`Dr TRADER_RESERVE / Cr TREASURY_USDT`) and the withdrawal completes.
 */
export function confirmReserveWithdrawal(actor: OperatorActor, deps: Pick<TraderDeps, 'chain'>) {
  return operatorCommand(actor, 'trader_payout:confirm', async (ctx, p: { withdrawalId: string }) => {
    const w0 = await ctx.tx.selectFrom('trader_reserve_withdrawal').select('trader_id').where('id', '=', requireUuid(p.withdrawalId, 'withdrawalId')).executeTakeFirst();
    if (!w0) throw new DomainError('NOT_FOUND', 'withdrawal not found');
    await lockTrader(ctx, w0.trader_id);
    const w = await ctx.tx.selectFrom('trader_reserve_withdrawal').selectAll().where('id', '=', p.withdrawalId).forUpdate().executeTakeFirstOrThrow();
    if (w.status !== 'SENT' || !w.crypto_transfer_id || !w.treasury_wallet_id) throw new DomainError('INVALID_TRANSITION', `the withdrawal is ${w.status}`);
    await lockMovement(ctx, 'CRYPTO', w.crypto_transfer_id);
    const verified = await verifyCryptoTransfer(ctx, { chain: deps.chain }, w.crypto_transfer_id);
    if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason);
    await postMovement(ctx, {
      kind: 'CRYPTO',
      movementId: w.crypto_transfer_id,
      amount: Money.ofMinor(w.amount_minor, 'USDT'),
      from: { kind: 'EXCHANGE_TREASURY', walletId: w.treasury_wallet_id },
      to: { kind: 'TRADER', traderId: w.trader_id },
      tradeId: null,
      purpose: 'TRADER_RESERVE',
    });
    await ctx.tx.updateTable('trader_reserve_withdrawal').set({ status: 'COMPLETED', completed_at: sql<Date>`inrp2p_now()`, closed_at: sql<Date>`inrp2p_now()`, closed_by: actorLabel(ctx) }).where('id', '=', w.id).execute();
    await appendAudit(ctx, { action: 'trader_reserve.withdrawal_completed', entityType: 'trader_reserve_withdrawal', entityId: w.id, before: { status: 'SENT' }, after: { status: 'COMPLETED', amount: Money.ofMinor(w.amount_minor, 'USDT') } });
    return { status: 'COMPLETED' as const };
  });
}

/**
 * `trader_reserve.reject_withdrawal` — `trader_payout:confirm` (⧗), with a reason the trader sees. Before anything
 * was sent, or when the recorded transfer failed on chain; never for USDT the chain says actually left — that is
 * confirmed, not rejected. The held amount is released.
 */
export function rejectReserveWithdrawal(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_payout:confirm', async (ctx, p: { withdrawalId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const w0 = await ctx.tx.selectFrom('trader_reserve_withdrawal').select('trader_id').where('id', '=', requireUuid(p.withdrawalId, 'withdrawalId')).executeTakeFirst();
    if (!w0) throw new DomainError('NOT_FOUND', 'withdrawal not found');
    await lockTrader(ctx, w0.trader_id);
    const w = await ctx.tx.selectFrom('trader_reserve_withdrawal').selectAll().where('id', '=', p.withdrawalId).forUpdate().executeTakeFirstOrThrow();
    if (w.status !== 'REQUESTED' && w.status !== 'SENT') throw new DomainError('INVALID_TRANSITION', `the withdrawal is ${w.status}`);
    if (w.status === 'SENT' && w.crypto_transfer_id) {
      const t = await ctx.tx.selectFrom('crypto_transfer').select('state').where('id', '=', w.crypto_transfer_id).executeTakeFirstOrThrow();
      if (t.state !== 'FAILED' && t.state !== 'ORPHANED') throw new DomainError('INVALID_TRANSITION', 'the recorded transfer has not failed on chain; confirm it once it is final');
    }
    await ctx.tx.updateTable('trader_reserve_withdrawal').set({ status: 'REJECTED', closed_at: sql<Date>`inrp2p_now()`, closed_by: actorLabel(ctx), close_reason: reason }).where('id', '=', w.id).execute();
    await appendAudit(ctx, { action: 'trader_reserve.withdrawal_rejected', entityType: 'trader_reserve_withdrawal', entityId: w.id, before: { status: w.status }, after: { status: 'REJECTED', reason } });
    await enqueueOutbox(ctx, { type: 'trader.reserve_issue', aggregateType: 'trader_profile', aggregateId: w.trader_id, payload: { traderId: w.trader_id, reason: 'WITHDRAWAL_REJECTED', note: reason } });
    return { status: 'REJECTED' as const };
  });
}

export type { TxContext };
