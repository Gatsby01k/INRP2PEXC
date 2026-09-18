import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { getAccountDay } from '@inrp2p/inr-accounts';
import { effectiveObligations } from '@inrp2p/trades';
import {
  approveAdjustment, cancelTrade, confirmPayout, confirmRefundLeg, createPayoutLeg, createRefundLeg, effectiveTerms, failPayoutLeg,
  obligationRemaining, openException, pnlSummary, recordLegEvidence, refundAndCancel, rejectAdjustment, requestAdjustment,
  resolveException, routeObligationMismatches, runReconciliation, runSettlementSla, sendPayoutLeg,
} from '../src/index.ts';
import { balanceOf, createWorld, newUtr, openTrade, settleFirstLeg, type World } from './world.ts';

let w: World;
beforeAll(async () => { w = await createWorld('settlement_core', { capacityInr: '500000000.00' }); });
afterAll(async () => w.close());

async function exchangeTrade(opts: { baseUsdt?: string; clientRate?: string; routeRate?: string } = {}) {
  const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: opts.baseUsdt ?? '1000', clientRate: opts.clientRate ?? '102.000000', routeRate: opts.routeRate ?? '104.200000' });
  await settleFirstLeg(w, trade.tradeId);
  return trade;
}

async function payoutLeg(tradeId: string, amount: string, opts: { confirm?: boolean; utr?: string } = {}) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  const utr = opts.utr ?? newUtr();
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr });
  if (opts.confirm !== false) await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
  return { ...leg, utr };
}

describe('client settlement in several legs (T5–T8)', () => {
  it('settles in three legs: SETTLING, PARTIALLY_SETTLED, then COMPLETED', async () => {
    const trade = await exchangeTrade({ baseUsdt: '1000' }); // client is owed ₹102,000.00
    await payoutLeg(trade.tradeId, '50000.00');
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('PARTIALLY_SETTLED');
    await payoutLeg(trade.tradeId, '50000.00');
    const mid = await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(mid.lifecycle_state).toBe('PARTIALLY_SETTLED');
    const last = await payoutLeg(trade.tradeId, '2000.00');
    expect(last.remainingAfter).toBe('0.00');
    const done = await w.app.selectFrom('trade').select(['lifecycle_state', 'completed_at']).where('id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(done.lifecycle_state).toBe('COMPLETED');
    expect(done.completed_at).not.toBeNull();
    const transitions = await w.app.selectFrom('trade_transition').select('to_state').where('trade_id', '=', trade.tradeId).orderBy('id').execute();
    expect(transitions.map((t) => t.to_state)).toEqual(['AWAITING_FIRST_LEG', 'FIRST_LEG_DETECTED', 'FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED', 'COMPLETED']);
  });

  it('exit: FI-62 — a trade completes while its route obligation is still OPEN', async () => {
    const trade = await exchangeTrade({ baseUsdt: '1000' });
    await payoutLeg(trade.tradeId, '102000.00');
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    const obligation = await w.app.selectFrom('route_obligation').select('status').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    expect(obligation.status).toBe('OPEN');
    const remaining = await obligationRemaining(w.app, trade.routeObligationId);
    expect(remaining.routeDelivers.toDecimalString()).toBe('104200.00');
  });

  it('exit: over-allocation is blocked, including when two operators create legs concurrently', async () => {
    const trade = await exchangeTrade({ baseUsdt: '1000' });
    await expect(runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '102000.01', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId }))
      .rejects.toMatchObject({ code: 'OVER_ALLOCATION' });

    const race = await exchangeTrade({ baseUsdt: '1000' });
    const attempt = (op: World['settlementOp']) =>
      runAs(w.app, createPayoutLeg(op.actor, {}), op.ref, 'payout_leg.create', { tradeId: race.tradeId, amount: '60000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    const results = await Promise.allSettled([attempt(w.settlementOp), attempt(w.settlementOp2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const legs = await w.app.selectFrom('settlement_leg').select('amount_minor').where('trade_id', '=', race.tradeId).where('side', '=', 'EXCHANGE_TO_CLIENT').execute();
    expect(legs.reduce((a, l) => a + l.amount_minor, 0n)).toBeLessThanOrEqual(Money.parse('102000.00', 'INR').minor);
  });

  it('exit: a failed leg returns its capacity and a replacement leg reserves again', async () => {
    const trade = await exchangeTrade({ baseUsdt: '1000' });
    const before = await getAccountDay(w.app, w.inrAccountId);
    const leg = await payoutLeg(trade.tradeId, '102000.00', { confirm: false });
    const sent = await getAccountDay(w.app, w.inrAccountId);
    expect(sent.used.minor - before.used.minor).toBe(Money.parse('102000.00', 'INR').minor);

    await runAs(w.app, failPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.fail', { legId: leg.legId, reason: 'beneficiary bank rejected the credit' });
    const failed = await getAccountDay(w.app, w.inrAccountId);
    expect(failed.used.minor).toBe(before.used.minor);
    expect(failed.remaining.minor).toBe(before.remaining.minor);
    const movement = await w.app.selectFrom('fiat_transfer').select('status').where('utr', '=', leg.utr).executeTakeFirstOrThrow();
    expect(movement.status).toBe('FAILED');

    // The exception blocks further payouts until it is resolved, then a replacement leg completes the trade.
    const exception = await w.app.selectFrom('exception_case').select(['id', 'type']).where('subject_id', '=', leg.legId).executeTakeFirstOrThrow();
    await expect(payoutLeg(trade.tradeId, '102000.00')).rejects.toMatchObject({ code: 'TRADE_ON_HOLD' });
    await runAs(w.app, resolveException(w.settlementOp.actor), w.settlementOp.ref, 'exception.resolve', { exceptionId: exception.id, resolution: 'create_replacement_leg' as const, notes: 'client confirmed new IFSC; replacement leg created' });
    expect((await w.app.selectFrom('trade').select('hold').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).hold).toBe(false);
    await payoutLeg(trade.tradeId, '102000.00');
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
  });

  it('a BUY trade pays the client USDT from treasury and consumes its reservation', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '500', clientRate: '106.000000', routeRate: '104.200000' });
    await settleFirstLeg(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '500', payer: 'EXCHANGE_ACCOUNT' as const, treasuryWalletId: w.treasuryWalletId });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    const wallet = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const clientWallet = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
    const receipt = w.chain.add({ from: wallet.address, to: clientWallet.address, amountMinor: Money.parse('500', 'USDT').minor });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: receipt.txHash, logIndex: receipt.logIndex, fromAddress: wallet.address });
    const result = await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    expect(result.completed).toBe(true);
    const reservation = await w.app.selectFrom('treasury_reservation').select(['status', 'consumed_minor']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(reservation).toMatchObject({ status: 'CONSUMED', consumed_minor: Money.parse('500', 'USDT').minor });
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'USDT', { tradeId: trade.tradeId })).toBe(0n);
  });

  it('an unsolidified or failed transfer never confirms a payout (FI-24)', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '106.000000' });
    await settleFirstLeg(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '10', payer: 'EXCHANGE_ACCOUNT' as const, treasuryWalletId: w.treasuryWalletId });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    const wallet = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const clientWallet = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
    const pending = w.chain.add({ from: wallet.address, to: clientWallet.address, amountMinor: Money.parse('10', 'USDT').minor, solidified: false });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: pending.txHash, logIndex: pending.logIndex, fromAddress: wallet.address });
    await expect(confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'TRANSFER_NOT_CONFIRMED' });
    w.chain.solidifyAll();
    const ok = await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    expect(ok.completed).toBe(true);
  });
});

describe('cancellation and refunds (T9, T10)', () => {
  it('exit: cancelling releases capacity, the deposit address and the route obligation, and reverses the accept journal', async () => {
    const trade = await openTrade(w, { executionMode: 'DIRECT_TO_CLIENT', baseUsdt: '1000', clientRate: '102.000000', routeRate: '104.200000' });
    const assignment = await w.app.selectFrom('deposit_assignment').select(['deposit_address_id']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client asked to stand down before sending' });

    const row = await w.app.selectFrom('trade').select(['lifecycle_state', 'cancelled_at']).where('id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(row.lifecycle_state).toBe('CANCELLED');
    expect((await w.app.selectFrom('route_obligation').select('status').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    const address = await w.app.selectFrom('deposit_address').select('status').where('id', '=', assignment.deposit_address_id).executeTakeFirstOrThrow();
    expect(address.status).toBe('COOLDOWN');
    const journals = await w.app.selectFrom('ledger_journal').select('posting_key').where('trade_id', '=', trade.tradeId).orderBy('posted_at').execute();
    expect(journals.map((j) => j.posting_key)).toEqual([`trade:${trade.tradeId}:accept`, `trade:${trade.tradeId}:cancel`]);
    const perCurrency = await sql<{ currency: string; net: string }>`
      select currency, sum(case direction when 'DR' then amount_minor else -amount_minor end)::text as net
      from ledger_entry where trade_id = ${trade.tradeId} group by currency`.execute(w.app);
    for (const r of perCurrency.rows) expect({ c: r.currency, net: r.net }).toEqual({ c: r.currency, net: '0' });
  });

  it('a trade with confirmed client funds cannot be cancelled — it needs a refund first (T10)', async () => {
    const trade = await exchangeTrade({ baseUsdt: '100' });
    await expect(runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client changed their mind' }))
      .rejects.toMatchObject({ code: 'FUNDS_ALREADY_RECEIVED' });

    const opened = await runAs(w.app, openException(w.dealer.actor), w.dealer.ref, 'exception.open', {
      type: 'TRADE_CANCELLATION' as const, subjectType: 'TRADE' as const, subjectId: trade.tradeId, tradeId: trade.tradeId, notes: 'client asked to unwind after paying',
    });
    // A SELL client sent USDT, so the refund goes back in USDT from treasury.
    // Creating a refund needs `settlement:create_payout`; approving it needs `refund:approve` from someone else.
    const refund = await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, treasuryWalletId: w.treasuryWalletId });
    expect(refund.amount).toBe('100.000000');
    const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const back = w.chain.add({ from: treasury.address, to: w.clientSourceAddress, amountMinor: Money.parse('100', 'USDT').minor });
    await expect(runAs(w.app, confirmRefundLeg(w.owner.actor, w.settlementDeps), w.owner.ref, 'refund_leg.confirm', { legId: refund.legId, txHash: back.txHash, logIndex: back.logIndex }))
      .rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(runAs(w.app, confirmRefundLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'refund_leg.confirm', { legId: refund.legId, txHash: back.txHash, logIndex: back.logIndex }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId: refund.legId, txHash: back.txHash, logIndex: back.logIndex });
    await runAs(w.app, refundAndCancel(w.owner.actor), w.owner.ref, 'exception.refund_and_cancel', { tradeId: trade.tradeId, exceptionId: opened.exceptionId, reason: 'refunded in full and cancelled' });

    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('CANCELLED');
    expect((await w.app.selectFrom('exception_case').select('status').where('id', '=', opened.exceptionId).executeTakeFirstOrThrow()).status).toBe('RESOLVED');
    const perCurrency = await sql<{ currency: string; net: string }>`
      select currency, sum(case direction when 'DR' then amount_minor else -amount_minor end)::text as net
      from ledger_entry where trade_id = ${trade.tradeId} group by currency`.execute(w.app);
    for (const r of perCurrency.rows) expect({ c: r.currency, net: r.net }).toEqual({ c: r.currency, net: '0' });
    expect(await balanceOf(w.app, 'ASSET:CLIENT_RECEIVABLE', 'USDT', { tradeId: trade.tradeId })).toBe(0n);
  });
});

describe('financial adjustments (FI-12, FI-43)', () => {
  it('exit: an adjustment leaves the original economics untouched and posts a compensating journal', async () => {
    const trade = await exchangeTrade({ baseUsdt: '1000' });
    const before = await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    const requested = await runAs(w.app, requestAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'AMOUNT_CORRECTION' as const, deltaClientInr: '-2000.00', deltaRouteInr: '0.00',
      reason: 'client short-paid by ₹2,000 and the desk agreed to settle the smaller amount',
    });
    // The requester cannot approve their own adjustment, and a DEALER has no approval permission at all.
    await expect(runAs(w.app, approveAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }))
      .rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(runAs(w.app, approveAdjustment(w.dealer.actor), w.dealer.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId });

    const after = await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(after).toEqual(before);
    const effective = await effectiveObligations(w.app, trade.tradeId);
    expect(effective.payout.toDecimalString()).toBe('100000.00');
    const journal = await w.app.selectFrom('ledger_journal').select('posting_key').where('posting_key', '=', `adj:${requested.adjustmentId}`).executeTakeFirstOrThrow();
    expect(journal.posting_key).toBe(`adj:${requested.adjustmentId}`);
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'INR', { tradeId: trade.tradeId })).toBe(-Money.parse('100000.00', 'INR').minor);
    // The margin grew by the amount the client no longer receives, and is still deferred until completion.
    // Accept deferred ₹2,200; the ₹2,000 the client no longer receives becomes margin, still deferred.
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(-Money.parse('4200.00', 'INR').minor);

    await payoutLeg(trade.tradeId, '100000.00');
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    const terms = await effectiveTerms(w.app, trade.tradeId);
    expect(terms.clientInr.toDecimalString()).toBe('100000.00');
    expect(terms.grossMargin.toDecimalString()).toBe('4200.00');
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(-Money.parse('4200.00', 'INR').minor);
  });

  it('a rejected adjustment posts nothing and cannot be approved afterwards', async () => {
    const trade = await exchangeTrade({ baseUsdt: '100' });
    const requested = await runAs(w.app, requestAdjustment(w.dealer.actor), w.dealer.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'WRITE_OFF' as const, deltaClientInr: '-100.00', deltaRouteInr: '0.00', reason: 'desk proposed a goodwill write-off of ₹100',
    });
    await runAs(w.app, rejectAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.reject', { adjustmentId: requested.adjustmentId, reason: 'not supported by evidence' });
    expect(await w.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `adj:${requested.adjustmentId}`).execute()).toEqual([]);
    await expect(runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await effectiveObligations(w.app, trade.tradeId)).payout.toDecimalString()).toBe('10200.00');
  });

  it('an adjustment cannot shrink the obligation below what is already committed', async () => {
    const trade = await exchangeTrade({ baseUsdt: '100' });
    await payoutLeg(trade.tradeId, '10200.00');
    await expect(runAs(w.app, requestAdjustment(w.dealer.actor), w.dealer.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'AMOUNT_CORRECTION' as const, deltaClientInr: '-200.00', deltaRouteInr: '0.00', reason: 'attempt to shrink a settled trade below what was paid',
    })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });
});

describe('P&L, reconciliation and SLA (FI-43, FI-44, FI-64)', () => {
  it('exit: P&L counts realized margin of completed trades only', async () => {
    const pnlWorld = await createWorld('settlement_pnl', { capacityInr: '500000000.00' });
    try {
      const completed = await openTrade(pnlWorld, { executionMode: 'TO_EXCHANGE', baseUsdt: '1000', clientRate: '102.000000', routeRate: '104.200000' });
      await settleFirstLeg(pnlWorld, completed.tradeId);
      const leg = await runAs(pnlWorld.app, createPayoutLeg(pnlWorld.settlementOp.actor, {}), pnlWorld.settlementOp.ref, 'payout_leg.create', { tradeId: completed.tradeId, amount: '102000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: pnlWorld.inrAccountId });
      await runAs(pnlWorld.app, sendPayoutLeg(pnlWorld.settlementOp.actor), pnlWorld.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
      await runAs(pnlWorld.app, recordLegEvidence(pnlWorld.settlementOp.actor, pnlWorld.settlementDeps), pnlWorld.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
      await confirmPayout(pnlWorld.app, pnlWorld.settlementOp.actor, pnlWorld.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
      // A second, unfinished trade contributes nothing to realized margin.
      const open = await openTrade(pnlWorld, { executionMode: 'TO_EXCHANGE', baseUsdt: '2000', clientRate: '102.000000', routeRate: '104.200000' });
      await settleFirstLeg(pnlWorld, open.tradeId);

      const today = (await sql<{ d: string }>`select to_char(inrp2p_now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as d`.execute(pnlWorld.app)).rows[0]!.d;
      const pnl = await pnlSummary(pnlWorld.app, { from: today, to: today });
      expect(pnl.realizedGrossMargin.toDecimalString()).toBe('2200.00');
      expect(pnl.completedVolume.toDecimalString()).toBe('1000.000000');
      expect(pnl.completedTrades).toBe(1);
      expect(pnl.openExpectedMargin.toDecimalString()).toBe('4400.00');
    } finally {
      await pnlWorld.close();
    }
  });

  it('reconciliation finds no mismatch, and the SLA sweep opens cases for stale payouts', async () => {
    const trade = await exchangeTrade({ baseUsdt: '100' });
    const leg = await payoutLeg(trade.tradeId, '10200.00', { confirm: false });
    expect(await routeObligationMismatches(w.app)).toEqual([]);
    expect(await runReconciliation(w.t.worker)).toEqual({ routeMismatches: 0, currencyImbalances: [] });

    await sql`update settlement_leg set sent_at = inrp2p_now() - interval '4 hours' where id = ${leg.legId}`.execute(w.t.owner);
    const swept = await runSettlementSla(w.t.worker, { payoutMinutes: 120, obligationHours: 48 });
    expect(swept.delayedPayouts).toBeGreaterThanOrEqual(1);
    const opened = await w.app.selectFrom('exception_case').select(['type', 'severity', 'status']).where('subject_id', '=', leg.legId).executeTakeFirstOrThrow();
    expect(opened).toMatchObject({ type: 'INR_PAYOUT_DELAYED', severity: 'WARNING', status: 'OPEN' });
    // A warning does not put the trade on hold.
    expect((await w.app.selectFrom('trade').select('hold').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).hold).toBe(false);
    // Running it again does not duplicate the case.
    await runSettlementSla(w.t.worker, { payoutMinutes: 120, obligationHours: 48 });
    expect(await w.app.selectFrom('exception_case').select('id').where('subject_id', '=', leg.legId).execute()).toHaveLength(1);
  });

  it('the ledger is append-only and no journal can be unbalanced (FI-40, FI-41)', async () => {
    const trade = await exchangeTrade({ baseUsdt: '100' });
    const journal = await w.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `trade:${trade.tradeId}:accept`).executeTakeFirstOrThrow();
    await expect(sql`update ledger_entry set amount_minor = 1 where journal_id = ${journal.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`delete from ledger_journal where id = ${journal.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    expect(await w.app.selectFrom('ledger_global_imbalance').selectAll().execute()).toEqual([]);
  });
});
