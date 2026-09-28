import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor, FiatRail } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { Accounts, accountBalance } from '@inrp2p/ledger';
import { consumeReservation, releaseReservation, reserveCapacity } from '@inrp2p/inr-accounts';
import { lockMovement, markFiatFailed, maskedBankDestination, postMovement, recordFiatTransfer } from '@inrp2p/settlement';
import { lockTrader } from '@inrp2p/trader-core';

export interface Earnings {
  /** Whether INRP2P pays this trader a reward at all right now (trader override, else programme). */
  readonly rewardBps: number | null;
  /** Rewards accrued on orders that completed today (IST). */
  readonly today: Money<'INR'>;
  /** Accrued and not yet paid out or being paid out. */
  readonly available: Money<'INR'>;
  /** Payouts recorded and not yet confirmed. */
  readonly payingOut: Money<'INR'>;
  /** Rewards fixed on orders still in progress — earned when they complete. */
  readonly pending: Money<'INR'>;
  readonly paidOut: Money<'INR'>;
  readonly completedOrders: number;
  /** Total volume of completed orders, in USDT and in INR at the trader's rates. */
  readonly completedUsdt: Money<'USDT'>;
  readonly completedInr: Money<'INR'>;
}

export async function earnings(ex: Executor, traderId: string): Promise<Earnings> {
  const id = requireUuid(traderId, 'traderId');
  const profile = await ex.selectFrom('trader_profile').select('reward_bps').where('id', '=', id).executeTakeFirstOrThrow();
  const program = await ex.selectFrom('trader_program').select('reward_bps').where('id', '=', 1).executeTakeFirstOrThrow();
  const payable = -(await accountBalance(ex, Accounts.traderRewardPayable(id)));
  const r = await sql<{ today: string; paying: string; paid: string; pending: string; completed: string; usdt: string; inr: string }>`
    select
      (select coalesce(sum(e.amount_minor), 0) from ledger_entry e
         join ledger_journal j on j.id = e.journal_id
         join ledger_account a on a.id = e.account_id
       where a.code = ${Accounts.traderRewardPayable(id).code} and e.direction = 'CR' and j.event_type = 'trader_reward.accrued'
         and (j.posted_at at time zone 'Asia/Kolkata')::date = (inrp2p_now() at time zone 'Asia/Kolkata')::date)::text as today,
      (select coalesce(sum(amount_minor), 0) from trader_reward_payout where trader_id = ${id} and status = 'RECORDED')::text as paying,
      (select coalesce(sum(amount_minor), 0) from trader_reward_payout where trader_id = ${id} and status = 'CONFIRMED')::text as paid,
      (select coalesce(sum(reward_inr_minor), 0) from trader_order where trader_id = ${id} and status = 'IN_PROGRESS')::text as pending,
      (select count(*) from trader_order where trader_id = ${id} and status = 'COMPLETED')::text as completed,
      (select coalesce(sum(base_minor), 0) from trader_order where trader_id = ${id} and status = 'COMPLETED')::text as usdt,
      (select coalesce(sum(inr_minor), 0) from trader_order where trader_id = ${id} and status = 'COMPLETED')::text as inr`.execute(ex);
  const row = r.rows[0]!;
  const paying = BigInt(row.paying);
  const available = payable - paying;
  return {
    rewardBps: profile.reward_bps ?? program.reward_bps,
    today: Money.ofMinor(BigInt(row.today), 'INR'),
    available: Money.ofMinor(available > 0n ? available : 0n, 'INR'),
    payingOut: Money.ofMinor(paying, 'INR'),
    pending: Money.ofMinor(BigInt(row.pending), 'INR'),
    paidOut: Money.ofMinor(BigInt(row.paid), 'INR'),
    completedOrders: Number.parseInt(row.completed, 10),
    completedUsdt: Money.ofMinor(BigInt(row.usdt), 'USDT'),
    completedInr: Money.ofMinor(BigInt(row.inr), 'INR'),
  };
}

/**
 * `trader_reward.record_payout` — `trader_payout:record`. INR paid from an exchange account to the trader's
 * registered bank account, with its UTR: at most what is accrued and not already being paid, and drawing on the
 * account's daily capacity like any other payment out (FI-30). Nothing posts until it is confirmed.
 */
export function recordRewardPayout(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_payout:record', async (ctx, p: { traderId: string; amount: string; inrAccountId: string; rail: FiatRail; utr: string }) => {
    const amount = Money.parse(p.amount, 'INR');
    if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'a payout must be positive');
    const trader = await lockTrader(ctx, p.traderId);
    const figures = await earnings(ctx.tx, trader.id);
    if (amount.minor > figures.available.minor) {
      throw new DomainError('TRADER_REWARD_EXCEEDS_PAYABLE', `only ${figures.available.toDecimalString()} INR is accrued and unpaid`, { available: figures.available.toDecimalString() });
    }
    const bank = await ctx.tx.selectFrom('bank_account').select(['id', 'status']).where('id', '=', trader.bank_account_id).executeTakeFirstOrThrow();
    if (bank.status !== 'ACTIVE') throw new DomainError('TRADER_DESTINATION_INVALID', "the trader's registered bank account is no longer active");
    const inrAccountId = requireUuid(p.inrAccountId, 'inrAccountId');
    const movement = await recordFiatTransfer(ctx, {
      rail: requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const),
      utr: p.utr,
      amount,
      payerType: 'EXCHANGE_ACCOUNT',
      payerId: inrAccountId,
      payeeType: 'TRADER',
      payeeId: trader.id,
      destinationMasked: await maskedBankDestination(ctx.tx, bank.id),
    });
    const row = await ctx.tx
      .insertInto('trader_reward_payout')
      .values({ trader_id: trader.id, amount_minor: amount.minor, inr_account_id: inrAccountId, fiat_transfer_id: movement.transferId, destination_bank_account_id: bank.id, recorded_by: actorLabel(ctx) })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    const reserved = await reserveCapacity(ctx, { accountId: inrAccountId, amount, subject: { purpose: 'TRADER_REWARD_PAYOUT', traderRewardPayoutId: row.id } });
    await ctx.tx.updateTable('trader_reward_payout').set({ capacity_reservation_id: reserved.reservationId }).where('id', '=', row.id).execute();
    await appendAudit(ctx, { action: 'trader_reward.payout_recorded', entityType: 'trader_reward_payout', entityId: row.id, after: { ref: row.ref, trader_id: trader.id, amount, inr_account_id: inrAccountId } });
    return { payoutId: row.id, ref: row.ref };
  });
}

/**
 * `trader_reward.confirm_payout` — `trader_payout:confirm` (⧗), once the payment is seen leaving the account. The
 * one movement journal posts (`Dr TRADER_REWARD_PAYABLE / Cr INR_SETTLEMENT`) and the capacity is used.
 */
export function confirmRewardPayout(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_payout:confirm', async (ctx, p: { payoutId: string }) => {
    const peek = await ctx.tx.selectFrom('trader_reward_payout').select('trader_id').where('id', '=', requireUuid(p.payoutId, 'payoutId')).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', 'payout not found');
    await lockTrader(ctx, peek.trader_id);
    const payout = await ctx.tx.selectFrom('trader_reward_payout').selectAll().where('id', '=', p.payoutId).forUpdate().executeTakeFirstOrThrow();
    if (payout.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payout is ${payout.status}`);
    await lockMovement(ctx, 'FIAT', payout.fiat_transfer_id);
    const f = await ctx.tx.selectFrom('fiat_transfer').select('status').where('id', '=', payout.fiat_transfer_id).executeTakeFirstOrThrow();
    if (f.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payment reference is ${f.status}`);
    await ctx.tx.updateTable('fiat_transfer').set({ status: 'CONFIRMED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', payout.fiat_transfer_id).execute();
    const amount = Money.ofMinor(payout.amount_minor, 'INR');
    await postMovement(ctx, {
      kind: 'FIAT',
      movementId: payout.fiat_transfer_id,
      amount,
      from: { kind: 'EXCHANGE_ACCOUNT', inrAccountId: payout.inr_account_id },
      to: { kind: 'TRADER', traderId: payout.trader_id },
      tradeId: null,
      purpose: 'TRADER_REWARD_PAYOUT',
    });
    if (payout.capacity_reservation_id) await consumeReservation(ctx, payout.capacity_reservation_id, amount);
    await ctx.tx.updateTable('trader_reward_payout').set({ status: 'CONFIRMED', confirmed_by: actorLabel(ctx), confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', payout.id).execute();
    await appendAudit(ctx, { action: 'trader_reward.payout_confirmed', entityType: 'trader_reward_payout', entityId: payout.id, before: { status: 'RECORDED' }, after: { status: 'CONFIRMED', amount } });
    return { status: 'CONFIRMED' as const };
  });
}

/** `trader_reward.fail_payout` — `trader_payout:confirm` (⧗). The payment never left; the capacity is given back. */
export function failRewardPayout(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_payout:confirm', async (ctx, p: { payoutId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const peek = await ctx.tx.selectFrom('trader_reward_payout').select('trader_id').where('id', '=', requireUuid(p.payoutId, 'payoutId')).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', 'payout not found');
    await lockTrader(ctx, peek.trader_id);
    const payout = await ctx.tx.selectFrom('trader_reward_payout').selectAll().where('id', '=', p.payoutId).forUpdate().executeTakeFirstOrThrow();
    if (payout.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payout is ${payout.status}`);
    await lockMovement(ctx, 'FIAT', payout.fiat_transfer_id);
    await markFiatFailed(ctx, payout.fiat_transfer_id, reason);
    if (payout.capacity_reservation_id) await releaseReservation(ctx, payout.capacity_reservation_id, 'TRADER_PAYOUT_FAILED');
    await ctx.tx.updateTable('trader_reward_payout').set({ status: 'FAILED', failed_at: sql<Date>`inrp2p_now()`, failure_reason: reason }).where('id', '=', payout.id).execute();
    await appendAudit(ctx, { action: 'trader_reward.payout_failed', entityType: 'trader_reward_payout', entityId: payout.id, before: { status: 'RECORDED' }, after: { status: 'FAILED', reason } });
    return { status: 'FAILED' as const };
  });
}
