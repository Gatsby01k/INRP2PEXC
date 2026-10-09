import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type ClientActor, type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { Accounts, accountBalance } from '@inrp2p/ledger';
import { lockMovement, postMovement, recordClientDeposit, recordCryptoTransfer, reserveSenderOf, verifyCryptoTransfer } from '@inrp2p/settlement';
import { lockTrader, lockTraderOfClient, traderClientCommand, type TraderDeps } from '@inrp2p/trader-core';

/**
 * The Security Reserve, from the ledger and nothing else.
 *
 * - `balance` — what the ledger owes the trader on `LIAB:TRADER_RESERVE` (deposits confirmed on chain, less
 *   withdrawals confirmed on chain).
 * - `locked` — the required amount, while the trader provides liquidity or has an order open: it protects those
 *   orders and anything still unresolved on them. Switching off does not unlock it until the last order finishes.
 * - `pendingRelease` — a withdrawal on its way back to the trader's registered wallet.
 * - `applying` — reserve the desk has approved applying to an order the trader did not deliver, not yet moved
 *   (TD-21); it is no longer the trader's to withdraw.
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
  readonly applying: Money<'USDT'>;
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
  const counts = await sql<{ open: string; withdrawing: string; applying: string }>`
    select
      (select count(*) from trader_order where trader_id = ${id} and status in ('ACCEPTED', 'IN_PROGRESS'))::text as open,
      (select coalesce(sum(amount_minor), 0) from trader_reserve_withdrawal where trader_id = ${id} and status in ('REQUESTED', 'SENT'))::text as withdrawing,
      (select coalesce(sum(amount_minor), 0) from trader_reserve_application where trader_id = ${id} and status in ('APPROVED', 'SENT'))::text as applying`.execute(ex);
  const openOrders = Number.parseInt(counts.rows[0]!.open, 10);
  const withdrawing = BigInt(counts.rows[0]!.withdrawing);
  const applying = BigInt(counts.rows[0]!.applying);
  const required = profile.required_reserve_minor;
  const engaged = profile.available || openOrders > 0;
  const free = balance.minor - withdrawing - applying;
  const locked = engaged && required !== null ? (free < required ? (free > 0n ? free : 0n) : required) : 0n;
  const available = free - locked;
  const shortfall = required !== null && free < required ? required - free : 0n;
  return {
    balance,
    required: required === null ? null : Money.ofMinor(required, 'USDT'),
    locked: Money.ofMinor(locked, 'USDT'),
    pendingRelease: Money.ofMinor(withdrawing, 'USDT'),
    applying: Money.ofMinor(applying, 'USDT'),
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
 * The one Security Reserve address every trader sends to (migration 0035, D-17): an exchange wallet watched like any
 * other, never a key the application holds. `null` only while none is active — the page then says so rather than
 * showing an address that would not be credited.
 */
export async function sharedReserveAddress(ex: Executor): Promise<{ readonly walletId: string; readonly address: string } | null> {
  const row = await ex
    .selectFrom('treasury_wallet')
    .select(['id', 'address'])
    .where('network', '=', 'TRON')
    .where('role', '=', 'TRADER_RESERVE')
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();
  return row ? { walletId: row.id, address: row.address } : null;
}

/** One reserve deposit the trader handed in, as the chain and the records now stand. */
export interface ClaimedDeposit {
  readonly txHash: string;
  readonly logIndex: number;
  readonly amount: string;
  /** CONFIRMING until the chain makes it final; CREDITED once the reserve holds it. */
  readonly status: 'CONFIRMING' | 'CREDITED' | 'FAILED';
}

const TX_HASH = /^[0-9a-f]{64}$/;

/**
 * `trader_reserve.claim_deposit` — any member of the trader's account, whatever its review state: topping up the
 * reserve is not admission to trading (D-17). The trader hands in the hash of a transfer it made to the shared reserve
 * address; the scanner finds the same transfers on its own, so this only lets the trader see its own sooner.
 *
 * Nothing here takes the trader's word for anything. The transaction is read from the configured providers; only
 * USDT on the configured contract into the shared address counts; and a transfer is this trader's only when the
 * sender is its registered wallet, on file before the transfer happened — the rule the scanner and the database
 * apply too (`reserveSenderOf`, IX102). A hash someone else's wallet paid, or one paid from a wallet nobody had on file
 * at the time, is refused with the same answer whoever it belongs to, and nothing is written. A transfer already
 * recorded is not recorded again (one row per transfer, FI-23); handing it in twice returns where it stands.
 */
export function claimReserveDeposit(actor: ClientActor, deps: Pick<TraderDeps, 'chain'>) {
  return traderClientCommand(actor, 'VIEW', async (ctx, p: { txHash: string }, member): Promise<{ deposits: readonly ClaimedDeposit[] }> => {
    const txHash = (typeof p.txHash === 'string' ? p.txHash.trim() : '').toLowerCase().replace(/^0x/, '');
    if (!TX_HASH.test(txHash)) throw new DomainError('INVALID_ARGUMENT', 'a transaction hash is 64 hexadecimal characters', { field: 'txHash' });
    const trader = await lockTraderOfClient(ctx, member.clientId);
    const shared = await sharedReserveAddress(ctx.tx);
    if (!shared) throw new DomainError('TRADER_RESERVE_ADDRESS_UNAVAILABLE', 'the reserve address is not available right now; ask the desk');
    // A network that cannot be read is said plainly: the transfer is still found and credited without the hash.
    const tx = await deps.chain.transactionTransfers('TRON', txHash).catch(() => {
      throw new DomainError('CHAIN_PROVIDER_ERROR', 'the network cannot be read right now; your transfer will still be found and credited on its own');
    });
    if (tx.status === 'NOT_FOUND') throw new DomainError('NOT_FOUND', 'the network does not show this transaction yet; try again in a minute');
    if (tx.status === 'TX_FAILED') throw new DomainError('INVALID_ARGUMENT', 'this transaction failed on the network; it moved no USDT');
    const intoReserve = tx.transfers.filter((t) => t.tokenContract === deps.chain.tokenContract && t.toAddress === shared.address && t.amountMinor > 0n);
    if (intoReserve.length === 0) throw new DomainError('TRADER_DEPOSIT_NOT_FOUND', 'this transaction sends no USDT (TRC20) to the reserve address');

    const deposits: ClaimedDeposit[] = [];
    for (const t of intoReserve) {
      const recorded = await ctx.tx
        .selectFrom('crypto_transfer')
        .select(['payer_type', 'payer_id', 'state'])
        .where('network', '=', 'TRON')
        .where('tx_hash', '=', txHash)
        .where('log_index', '=', t.logIndex)
        .executeTakeFirst();
      if (recorded) {
        if (recorded.payer_type === 'TRADER' && recorded.payer_id === trader.id) deposits.push({ txHash, logIndex: t.logIndex, amount: Money.ofMinor(t.amountMinor, 'USDT').toDecimalString(), status: depositStatus(recorded.state) });
        continue;
      }
      const sender = await reserveSenderOf(ctx.tx, t.fromAddress, t.blockTime);
      if (sender.traderId !== trader.id) continue;
      await recordClientDeposit(ctx, {
        txHash, logIndex: t.logIndex, tokenContract: t.tokenContract, fromAddress: t.fromAddress, toAddress: t.toAddress,
        amount: Money.ofMinor(t.amountMinor, 'USDT'), source: 'CLIENT_SUBMITTED', blockTime: t.blockTime,
      });
      deposits.push({ txHash, logIndex: t.logIndex, amount: Money.ofMinor(t.amountMinor, 'USDT').toDecimalString(), status: 'CONFIRMING' });
    }
    await appendAudit(ctx, {
      action: 'trader_reserve.deposit_claimed', entityType: 'trader_profile', entityId: trader.id,
      after: { tx_hash: txHash, accepted: deposits.map((d) => d.logIndex), refused: intoReserve.length - deposits.length },
    });
    if (deposits.length === 0) {
      throw new DomainError('TRADER_DEPOSIT_NOT_YOURS', 'this transfer was not sent from your registered wallet before it was made, so it cannot be credited to you; if you sent it, contact the desk');
    }
    return { deposits };
  });
}

function depositStatus(state: string): ClaimedDeposit['status'] {
  if (state === 'CONFIRMED') return 'CREDITED';
  if (state === 'DETECTED') return 'CONFIRMING';
  return 'FAILED';
}

/**
 * `trader_reserve.request_withdrawal` — the account's administrator or a user who can commit. At most what is available now (never the locked
 * part, never what is already on its way), to the trader's registered wallet as it is at this moment. One open
 * withdrawal at a time. The amount is held at once, so it cannot also be counted towards switching on.
 */
export function requestReserveWithdrawal(actor: ClientActor) {
  return traderClientCommand(actor, 'VIEW', async (ctx, p: { amount: string }, member) => {
    // Its own money, back to its own verified wallet: the account's administrator may ask for it even before the trader
    // is approved — a reserve topped up during review (D-17) must not be stranded by a rejection.
    if (!member.canCommit && member.role !== 'CLIENT_ADMIN') throw new DomainError('TRADER_ACTION_NOT_PERMITTED', 'this needs your account administrator, or someone who can accept quotes for your account');
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

/** `trader_reserve.cancel_withdrawal` — the account's administrator or a user who can commit, while nothing has been sent yet. */
export function cancelReserveWithdrawal(actor: ClientActor) {
  return traderClientCommand(actor, 'VIEW', async (ctx, p: { ref: string }, member) => {
    if (!member.canCommit && member.role !== 'CLIENT_ADMIN') throw new DomainError('TRADER_ACTION_NOT_PERMITTED', 'this needs your account administrator, or someone who can accept quotes for your account');
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
    const tx = await deps.chain.transactionTransfers('TRON', txHash);
    if (tx.status === 'NOT_FOUND') throw new DomainError('NOT_FOUND', 'the chain does not know this transfer');
    if (tx.status === 'TX_FAILED') throw new DomainError('INVALID_ARGUMENT', 'this transaction failed on chain; it moved no USDT');
    // The log that pays this withdrawal — never "the first log" of a transaction that may move USDT several times.
    const candidates = tx.transfers.filter((t) => (p.logIndex === undefined || p.logIndex === null || t.logIndex === p.logIndex));
    const usdt = candidates.filter((t) => t.tokenContract === deps.chain.tokenContract);
    if (usdt.length === 0) throw new DomainError('INVALID_ARGUMENT', 'this transfer is not USDT on the configured contract');
    const paying = usdt.filter((t) => t.toAddress === w.destination_address);
    if (paying.length === 0) throw new DomainError('INVALID_ARGUMENT', "this transfer does not pay the trader's registered wallet");
    const exact = paying.filter((t) => t.amountMinor === w.amount_minor);
    if (exact.length === 0) throw new DomainError('INVALID_AMOUNT', 'this transfer does not pay the requested amount');
    if (exact.length > 1) throw new DomainError('INVALID_ARGUMENT', 'this transaction pays the registered wallet that amount more than once; name the log', { logIndexes: exact.map((t) => t.logIndex) });
    const receipt = exact[0]!;
    const logIndex = receipt.logIndex;
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
