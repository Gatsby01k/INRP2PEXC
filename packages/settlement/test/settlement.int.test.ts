import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { effectiveObligations } from '@inrp2p/trades';
import {
  approveAdjustment, cancelTrade, confirmRefundLeg, createRefundLeg, effectiveTerms, openException, pnlSummary, refundAndCancel, rejectAdjustment, requestAdjustment,
  routeObligationMismatches, runReconciliation, runSettlementSla,
} from '../src/index.ts';
import { balanceOf, clientDepositAddressOf, createWorld, observe, openTrade, payClient, settleFirstLeg, type World } from './world.ts';

let w: World;
beforeAll(async () => { w = await createWorld('settlement'); });
afterAll(async () => w.close());

const fundedSale = async (baseUsdt: string) => {
  const trade = await openTrade(w, { baseUsdt, clientRate: '102.000000' });
  await settleFirstLeg(w, trade.tradeId);
  return trade;
};
const netPerCurrency = async (tradeId: string) => (await sql<{ currency: string; net: string }>`
  select currency, sum(case direction when 'DR' then amount_minor else -amount_minor end)::text as net
  from ledger_entry where trade_id = ${tradeId} group by currency`.execute(w.app)).rows;

describe('cancellation and refunds (T9, T10)', () => {
  it('exit: cancelling releases the deposit address and the route obligation, and reverses the accept journal', async () => {
    const trade = await openTrade(w, { baseUsdt: '1000', clientRate: '102.000000' });
    const assignment = await w.app.selectFrom('deposit_assignment').select(['deposit_address_id']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client asked to stand down before sending' });

    const row = await w.app.selectFrom('trade').select(['lifecycle_state', 'cancelled_at']).where('id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(row.lifecycle_state).toBe('CANCELLED');
    expect((await w.app.selectFrom('route_obligation').select('status').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    expect((await w.app.selectFrom('deposit_address').select('status').where('id', '=', assignment.deposit_address_id).executeTakeFirstOrThrow()).status).toBe('COOLDOWN');
    const journals = await w.app.selectFrom('ledger_journal').select('posting_key').where('trade_id', '=', trade.tradeId).orderBy('posted_at').execute();
    expect(journals.map((j) => j.posting_key)).toEqual([`trade:${trade.tradeId}:accept`, `trade:${trade.tradeId}:cancel`]);
    for (const r of await netPerCurrency(trade.tradeId)) expect({ c: r.currency, net: r.net }).toEqual({ c: r.currency, net: '0' });
  });

  it('a trade with confirmed client funds cannot be cancelled — it needs a refund first (T10)', async () => {
    const trade = await fundedSale('100');
    const deposit = await clientDepositAddressOf(w, trade.tradeId);
    await expect(runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client changed their mind' }))
      .rejects.toMatchObject({ code: 'FUNDS_ALREADY_RECEIVED' });

    const opened = await runAs(w.app, openException(w.dealer.actor), w.dealer.ref, 'exception.open', {
      type: 'TRADE_CANCELLATION' as const, subjectType: 'TRADE' as const, subjectId: trade.tradeId, tradeId: trade.tradeId, notes: 'client asked to unwind after paying',
    });
    // The client's USDT goes back from where it is (D-16). Creating a refund needs `settlement:create_payout`; approving
    // it needs `refund:approve` from someone else.
    await observe(w, deposit.address);
    const refund = await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, sourceDepositAddressId: deposit.id });
    expect(refund.amount).toBe('100.000000');
    const back = w.chain.add({ from: deposit.address, to: w.clientSourceAddress, amountMinor: Money.parse('100', 'USDT').minor });
    await expect(runAs(w.app, confirmRefundLeg(w.owner.actor, w.settlementDeps), w.owner.ref, 'refund_leg.confirm', { legId: refund.legId, txHash: back.txHash, logIndex: back.logIndex }))
      .rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(runAs(w.app, confirmRefundLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'refund_leg.confirm', { legId: refund.legId, txHash: back.txHash, logIndex: back.logIndex }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId: refund.legId, txHash: back.txHash, logIndex: back.logIndex });
    await runAs(w.app, refundAndCancel(w.owner.actor), w.owner.ref, 'exception.refund_and_cancel', { tradeId: trade.tradeId, exceptionId: opened.exceptionId, reason: 'refunded and closed' });

    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('CANCELLED');
    expect((await w.app.selectFrom('exception_case').select('status').where('id', '=', opened.exceptionId).executeTakeFirstOrThrow()).status).toBe('RESOLVED');
    for (const r of await netPerCurrency(trade.tradeId)) expect({ c: r.currency, net: r.net }).toEqual({ c: r.currency, net: '0' });
    expect(await balanceOf(w.app, 'ASSET:CLIENT_RECEIVABLE', 'USDT', { tradeId: trade.tradeId })).toBe(0n);
  });

  it('a client’s rupees are not refunded from here: they went straight to its trader', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', baseUsdt: '10' });
    await expect(runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, sourceDepositAddressId: trade.tradeId }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('financial adjustments (FI-12, FI-43)', () => {
  it('exit: an adjustment leaves the frozen terms untouched, posts its journal, and moves both sides of the rupees alike', async () => {
    const trade = await fundedSale('1000');
    const before = await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    const requested = await runAs(w.app, requestAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'AMOUNT_CORRECTION' as const, deltaClientInr: '-2000.00', reason: 'the client agreed to settle ₹2,000 less with its trader',
    });
    // The requester cannot approve their own adjustment, and a DEALER has no approval permission at all.
    await expect(runAs(w.app, approveAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }))
      .rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(runAs(w.app, approveAdjustment(w.dealer.actor), w.dealer.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId });

    expect(await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow()).toEqual(before);
    expect((await effectiveObligations(w.app, trade.tradeId)).payout.toDecimalString()).toBe('100000.00');
    expect(await w.app.selectFrom('ledger_journal').select('posting_key').where('posting_key', '=', `adj:${requested.adjustmentId}`).executeTakeFirstOrThrow()).toBeTruthy();
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'INR', { tradeId: trade.tradeId })).toBe(-Money.parse('100000.00', 'INR').minor);
    // No rupee is INRP2P's: none is deferred or realized as margin, before or after the deal completes.
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(0n);

    // The trader owes the corrected amount, and paying it completes the deal.
    await payClient(w, trade);
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    expect((await effectiveTerms(w.app, trade.tradeId)).clientInr.toDecimalString()).toBe('100000.00');
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'USDT', { tradeId: trade.tradeId })).toBe(0n);
  });

  it('a rejected adjustment posts nothing and cannot be approved afterwards', async () => {
    const trade = await fundedSale('100');
    const requested = await runAs(w.app, requestAdjustment(w.dealer.actor), w.dealer.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'WRITE_OFF' as const, deltaClientInr: '-100.00', reason: 'desk proposed a goodwill write-off of ₹100',
    });
    await runAs(w.app, rejectAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.reject', { adjustmentId: requested.adjustmentId, reason: 'not supported by evidence' });
    expect(await w.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `adj:${requested.adjustmentId}`).execute()).toEqual([]);
    await expect(runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await effectiveObligations(w.app, trade.tradeId)).payout.toDecimalString()).toBe('10200.00');
  });

  it('an adjustment cannot shrink the obligation below what is already committed', async () => {
    const trade = await fundedSale('100');
    await payClient(w, trade, { confirm: false });
    await expect(runAs(w.app, requestAdjustment(w.dealer.actor), w.dealer.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'AMOUNT_CORRECTION' as const, deltaClientInr: '-200.00', reason: 'attempt to shrink a settled trade below what it paid',
    })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });
});

describe('P&L, reconciliation and SLA (FI-43, FI-44, FI-64)', () => {
  it('exit: P&L counts realized margin of completed trades only', async () => {
    const pnlWorld = await createWorld('settlement_pnl');
    try {
      const completed = await openTrade(pnlWorld, { baseUsdt: '1000', clientRate: '102.000000' });
      await settleFirstLeg(pnlWorld, completed.tradeId);
      await payClient(pnlWorld, completed);
      // A second, unfinished trade contributes nothing to realized margin.
      const open = await openTrade(pnlWorld, { baseUsdt: '2000', clientRate: '102.000000' });
      await settleFirstLeg(pnlWorld, open.tradeId);

      const today = (await sql<{ d: string }>`select to_char(inrp2p_now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as d`.execute(pnlWorld.app)).rows[0]!.d;
      const pnl = await pnlSummary(pnlWorld.app, { from: today, to: today });
      const margin = (await pnlWorld.app.selectFrom('trade_economics').select('gross_margin_base_minor').where('trade_id', '=', completed.tradeId).executeTakeFirstOrThrow()).gross_margin_base_minor!;
      expect(pnl.completionMarginUsdt.minor).toBe(margin);
      expect(pnl.completedVolume.toDecimalString()).toBe('1000.000000');
      expect(pnl.completedTrades).toBe(1);
      expect(pnl.openTrades).toBe(1);
      expect(pnl.openExpectedMarginUsdt.isPositive()).toBe(true);
    } finally {
      await pnlWorld.close();
    }
  });

  it('reconciliation finds no mismatch, and the SLA sweep opens cases for stale payouts', async () => {
    const trade = await fundedSale('100');
    const { legRef } = await payClient(w, trade, { confirm: false });
    const leg = await w.app.selectFrom('settlement_leg').select('id').where('ref', '=', legRef).executeTakeFirstOrThrow();
    expect(await routeObligationMismatches(w.app)).toEqual([]);
    expect(await runReconciliation(w.t.worker)).toEqual({ routeMismatches: 0, currencyImbalances: [], failures: [] });

    await sql`update settlement_leg set sent_at = inrp2p_now() - interval '4 hours' where id = ${leg.id}`.execute(w.t.owner);
    const swept = await runSettlementSla(w.t.worker, { payoutMinutes: 120, obligationHours: 48 });
    expect(swept.delayedPayouts).toBeGreaterThanOrEqual(1);
    const opened = await w.app.selectFrom('exception_case').select(['type', 'severity', 'status']).where('subject_id', '=', leg.id).executeTakeFirstOrThrow();
    expect(opened).toMatchObject({ type: 'INR_PAYOUT_DELAYED', severity: 'WARNING', status: 'OPEN' });
    // A warning does not put the trade on hold.
    expect((await w.app.selectFrom('trade').select('hold').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).hold).toBe(false);
    // Running it again does not duplicate the case.
    await runSettlementSla(w.t.worker, { payoutMinutes: 120, obligationHours: 48 });
    expect(await w.app.selectFrom('exception_case').select('id').where('subject_id', '=', leg.id).execute()).toHaveLength(1);
  });

  it('the ledger is append-only and no journal can be unbalanced (FI-40, FI-41)', async () => {
    const trade = await fundedSale('100');
    const journal = await w.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `trade:${trade.tradeId}:accept`).executeTakeFirstOrThrow();
    await expect(sql`update ledger_entry set amount_minor = 1 where journal_id = ${journal.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`delete from ledger_journal where id = ${journal.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    expect(await w.app.selectFrom('ledger_global_imbalance').selectAll().execute()).toEqual([]);
  });
});
