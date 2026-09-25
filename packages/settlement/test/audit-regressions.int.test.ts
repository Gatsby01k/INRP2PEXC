import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { pgErrorCode } from '@inrp2p/db';
import { effectiveObligations } from '@inrp2p/trades';
import { archiveBankAccount } from '@inrp2p/clients';
import {
  approveAdjustment, cancelTrade, confirmFirstLeg, confirmPayout, confirmRouteSettlement, createPayoutLeg, createRefundLeg, importBankStatement,
  obligationRemaining, recordIncomingFiat, recordLegEvidence, recordRouteSettlement, requestAdjustment, resolveException, sendPayoutLeg,
  cancelPayoutLeg, confirmRefundLeg, destinationArchivedHandler, refundAndCancel, revertFirstLeg, submitTxForVerification, voidException,
} from '../src/index.ts';
import { balanceOf, createWorld, newUtr, openTrade, settleFirstLeg, type World } from './world.ts';

/**
 * Regressions found by the end-to-end audit (2026-09-25). Each test states the flow a desk actually runs and the
 * state the system must be in afterwards; before the fixes, every one of them left money stranded, a trade stuck,
 * or an invariant silently broken.
 */
let w: World;
beforeAll(async () => { w = await createWorld('audit_regressions', { capacityInr: '500000000.00' }); });
afterAll(async () => w.close());

const usdt = (decimal: string) => Money.parse(decimal, 'USDT').minor;
const inr = (decimal: string) => Money.parse(decimal, 'INR').minor;
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select(['lifecycle_state', 'hold']).where('id', '=', tradeId).executeTakeFirstOrThrow());
const openCasesOf = (tradeId: string) =>
  w.app.selectFrom('exception_case').select(['id', 'type', 'subject_type']).where('trade_id', '=', tradeId).where('status', 'in', ['OPEN', 'IN_PROGRESS']).orderBy('opened_at').execute();

/** A SELL trade settled to the exchange (client ₹102.00, route ₹104.20). */
const sellTrade = (baseUsdt: string) => openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt, clientRate: '102.000000', routeRate: '104.200000' });

async function depositTo(tradeId: string, amountUsdt: string, from = w.clientSourceAddress) {
  const a = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow();
  const receipt = w.chain.add({ from, to: a.address, amountMinor: usdt(amountUsdt) });
  return runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
}
const confirmLeg = (legId: string) => runAs(w.app, confirmFirstLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'settlement.confirm_incoming', { legId });
const resolve = (exceptionId: string, resolution: 'await_top_up' | 'escalate' = 'await_top_up') =>
  runAs(w.app, resolveException(w.dealer.actor), w.dealer.ref, 'exception.resolve', { exceptionId, resolution, notes: 'resolved by the desk after checking with the client' });

async function payout(tradeId: string, amount: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
  return confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

async function adjust(tradeId: string, deltas: { deltaBaseUsdt?: string; deltaClientInr?: string; deltaRouteInr?: string }, opts: { exceptionId?: string; type?: 'AMOUNT_CORRECTION' | 'WRITE_OFF' | 'RATE_CORRECTION' } = {}) {
  const requested = await runAs(w.app, requestAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.request', {
    tradeId, type: opts.type ?? ('AMOUNT_CORRECTION' as const), ...deltas, reason: 'agreed correction recorded by the desk', ...(opts.exceptionId ? { exceptionId: opts.exceptionId } : {}),
  });
  return { requested, approve: () => runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }) };
}

describe('a short first leg is recoverable (DOMAIN_MODEL §3 USDT_WRONG_AMOUNT)', () => {
  it('await_top_up: the top-up is not itself a wrong amount, and resolving the cases makes the trade payable', async () => {
    const trade = await sellTrade('100');
    const first = await depositTo(trade.tradeId, '90');
    await confirmLeg(first.legId!);
    expect((await stateOf(trade.tradeId)).hold).toBe(true);

    // The client sends exactly what is missing: that is what the desk asked for, not a second mistake.
    const topUp = await depositTo(trade.tradeId, '10');
    const topUpCases = await w.app.selectFrom('exception_case').select('type').where('subject_id', '=', topUp.transferId).execute();
    expect(topUpCases).toEqual([]);
    await confirmLeg(topUp.legId!);

    for (const c of await openCasesOf(trade.tradeId)) await resolve(c.id);
    expect(await stateOf(trade.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_CONFIRMED', hold: false });
    const out = await payout(trade.tradeId, '10200.00');
    expect(out.completed).toBe(true);
  });

  it('adjust_trade_to_received: the approved adjustment makes the trade payable for what arrived', async () => {
    const trade = await sellTrade('100');
    const first = await depositTo(trade.tradeId, '90');
    await confirmLeg(first.legId!);
    const tradeCase = (await openCasesOf(trade.tradeId)).find((c) => c.subject_type === 'TRADE')!;
    // 10 USDT fewer: the client is owed ₹1,020 less and the route ₹1,042 less; the margin falls by ₹22.
    const { approve } = await adjust(trade.tradeId, { deltaBaseUsdt: '-10', deltaClientInr: '-1020.00', deltaRouteInr: '-1042.00' }, { exceptionId: tradeCase.id });
    await approve();
    for (const c of await openCasesOf(trade.tradeId)) await resolve(c.id, 'escalate');
    expect(await stateOf(trade.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_CONFIRMED', hold: false });

    const out = await payout(trade.tradeId, '9180.00');
    expect(out.completed).toBe(true);
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(-inr('198.00'));
  });
});

describe('an adjustment that settles the rest completes the trade (FI-21)', () => {
  it('writing off the unpaid remainder of a partly paid trade completes it and realizes the margin', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    await payout(trade.tradeId, '10000.00');
    expect((await stateOf(trade.tradeId)).lifecycle_state).toBe('PARTIALLY_SETTLED');

    const { approve } = await adjust(trade.tradeId, { deltaClientInr: '-200.00' }, { type: 'WRITE_OFF' });
    await approve();
    expect((await stateOf(trade.tradeId)).lifecycle_state).toBe('COMPLETED');
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(-inr('420.00'));
    expect(await w.app.selectFrom('outbox_event').select('id').where('type', '=', 'receipt.generate').where('aggregate_id', '=', trade.tradeId).execute()).toHaveLength(1);
  });
});

describe('approval re-checks the effective terms (FI-20, FI-21, FI-61)', () => {
  it('refuses an approval that would put the obligation below what was already paid', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const { approve } = await adjust(trade.tradeId, { deltaClientInr: '-200.00' });
    await payout(trade.tradeId, '10200.00');
    await expect(approve()).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect((await effectiveObligations(w.app, trade.tradeId)).payout.toDecimalString()).toBe('10200.00');
  });

  it('refuses a second stacked adjustment that would make the payout negative', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const first = await adjust(trade.tradeId, { deltaClientInr: '-6000.00' }, { type: 'WRITE_OFF' });
    const second = await adjust(trade.tradeId, { deltaClientInr: '-6000.00' }, { type: 'WRITE_OFF' });
    await first.approve();
    await expect(second.approve()).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect((await effectiveObligations(w.app, trade.tradeId)).payout.toDecimalString()).toBe('4200.00');
  });

  it('refuses to change what a completed trade owes the client, but books a route correction to revenue', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    await payout(trade.tradeId, '10200.00');
    await expect(adjust(trade.tradeId, { deltaClientInr: '100.00' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    const routeSide = await adjust(trade.tradeId, { deltaRouteInr: '50.00' }, { type: 'RATE_CORRECTION' });
    await routeSide.approve();
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(-inr('270.00'));
  });

  it('refuses to shrink a route side below what the route already settled, and settles the obligation when it lands exactly', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const rs = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount: '10000.00', rail: 'NEFT' as const, utr: newUtr('RS'), inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: rs.routeSettlementId });
    const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const route = await w.app.selectFrom('liquidity_route').select('registered_route_address').where('id', '=', w.routeId).executeTakeFirstOrThrow();
    const sent = w.chain.add({ from: treasury.address, to: route.registered_route_address!, amountMinor: usdt('100') });
    const back = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'TO_ROUTE' as const, amount: '100', txHash: sent.txHash, logIndex: sent.logIndex, treasuryWalletId: w.treasuryWalletId,
    });
    await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: back.routeSettlementId });
    expect((await obligationRemaining(w.app, trade.routeObligationId)).routeDelivers.toDecimalString()).toBe('420.00');

    await expect(adjust(trade.tradeId, { deltaRouteInr: '-500.00' }, { type: 'RATE_CORRECTION' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    const exact = await adjust(trade.tradeId, { deltaRouteInr: '-420.00' }, { type: 'RATE_CORRECTION' });
    await exact.approve();
    const o = await w.app.selectFrom('route_obligation').select(['status', 'settled_at']).where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    expect(o.status).toBe('SETTLED');
    expect(o.settled_at).not.toBeNull();
  });
});

describe('cancellation leaves nothing behind (T9, FI-12)', () => {
  it('reverses posted adjustments with the acceptance, so every trade account ends at zero', async () => {
    const trade = await sellTrade('100');
    const { approve } = await adjust(trade.tradeId, { deltaClientInr: '-100.00' }, { type: 'RATE_CORRECTION' });
    await approve();
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client withdrew before sending' });
    for (const [code, currency] of [
      ['ASSET:CLIENT_RECEIVABLE', 'USDT'], ['LIAB:ROUTE_PAYABLE', 'USDT'], ['ASSET:ROUTE_RECEIVABLE', 'INR'], ['LIAB:CLIENT_PAYABLE', 'INR'], ['LIAB:DEFERRED_MARGIN', 'INR'],
    ] as const) {
      expect({ code, balance: await balanceOf(w.app, code, currency, { tradeId: trade.tradeId }) }).toEqual({ code, balance: 0n });
    }
  });

  it('refuses to approve an adjustment on a cancelled trade', async () => {
    const trade = await sellTrade('100');
    const pending = await adjust(trade.tradeId, { deltaClientInr: '-100.00' }, { type: 'RATE_CORRECTION' });
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client withdrew before sending' });
    await expect(pending.approve()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(adjust(trade.tradeId, { deltaClientInr: '-50.00' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('a detected deposit on a cancelled trade stops being that trade’s evidence', async () => {
    const trade = await sellTrade('100');
    const detected = await depositTo(trade.tradeId, '100');
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client asked to cancel after sending' });
    const live = await w.app.selectFrom('transfer_allocation').select('id').where('crypto_transfer_id', '=', detected.transferId).where('voided_at', 'is', null).execute();
    expect(live).toEqual([]);
    const cases = await w.app.selectFrom('exception_case').select('type').where('subject_id', '=', detected.transferId).where('status', '=', 'OPEN').execute();
    expect(cases.map((c) => c.type)).toEqual(['FUNDS_AFTER_TRADE_CLOSED']);
  });
});

describe('payout evidence must be what the chain says it is (FI-24)', () => {
  it('refuses a USDT payout whose on-chain sender is not the recorded sender', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '50', clientRate: '106.000000', routeRate: '104.200000' });
    await settleFirstLeg(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '50', payer: 'EXCHANGE_ACCOUNT' as const, treasuryWalletId: w.treasuryWalletId });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    const row = await w.app.selectFrom('settlement_leg').select('destination_wallet_id').where('id', '=', leg.legId).executeTakeFirstOrThrow();
    const dest = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', row.destination_wallet_id!).executeTakeFirstOrThrow();
    const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    // Someone else paid the client this amount; the operator records it as our treasury's payment.
    const stranger = w.chain.add({ from: encodeTronAddress(randomBytes(20)), to: dest.address, amountMinor: usdt('50') });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: stranger.txHash, logIndex: stranger.logIndex, fromAddress: treasury.address });
    await expect(confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'TRANSFER_NOT_CONFIRMED' });
  });
});

describe('the bank statement check covers every movement on the account (SECURITY S7)', () => {
  let s: World;
  beforeAll(async () => { s = await createWorld('audit_statements', { capacityInr: '500000000.00' }); });
  afterAll(async () => s.close());

  const today = async () => (await sql<{ day: string }>`select to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day`.execute(s.app)).rows[0]!.day;
  async function importLines(lines: readonly { reference: string; amount: string; direction: 'CREDIT' | 'DEBIT' }[]) {
    const day = await today();
    return runAs(s.app, importBankStatement(s.financeOp.actor), s.financeOp.ref, 'statement.import', {
      inrAccountId: s.inrAccountId, periodFrom: day, periodTo: day, filename: 'statement.csv',
      sha256: createHash('sha256').update(randomUUID()).digest('hex'),
      lines: lines.map((l) => ({ valueDate: day, ...l })),
    });
  }
  const casesOn = (transferId: string) => s.app.selectFrom('exception_case').select(sql<string>`details ->> 'reason'`.as('reason')).where('subject_id', '=', transferId).execute();

  it('matches a reference the operator typed in lower case', async () => {
    const trade = await openTrade(s, { executionMode: 'TO_EXCHANGE', baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000' });
    await settleFirstLeg(s, trade.tradeId);
    const leg = await runAs(s.app, createPayoutLeg(s.settlementOp.actor, {}), s.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '10200.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: s.inrAccountId });
    await runAs(s.app, sendPayoutLeg(s.settlementOp.actor), s.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    const utr = newUtr('lc').toLowerCase();
    const evidence = await runAs(s.app, recordLegEvidence(s.settlementOp.actor, s.settlementDeps), s.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr });
    await confirmPayout(s.app, s.settlementOp.actor, s.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });

    await importLines([{ reference: utr.toUpperCase(), amount: '10200.00', direction: 'DEBIT' }]);
    const line = await s.app.selectFrom('bank_statement_line').select(['outcome', 'fiat_transfer_id']).where('reference', '=', utr.toUpperCase()).executeTakeFirstOrThrow();
    expect(line).toEqual({ outcome: 'MATCHED', fiat_transfer_id: evidence.transferId });
    expect(await casesOn(evidence.transferId)).toEqual([]);
  });

  it('flags confirmed incoming client INR that the bank never received', async () => {
    const trade = await openTrade(s, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '106.000000', routeRate: '104.200000' });
    const first = await settleFirstLeg(s, trade.tradeId);
    await importLines([{ reference: newUtr('FEE'), amount: '11.80', direction: 'DEBIT' }]);
    expect((await casesOn(first.transferId)).map((c) => c.reason)).toEqual(['NOT_IN_STATEMENT']);
    // Clean-up for the other tests in this world: the case is real, not a false positive, but it is not theirs.
    const c = await s.app.selectFrom('exception_case').select('id').where('subject_id', '=', first.transferId).executeTakeFirstOrThrow();
    await runAs(s.app, voidException(s.dealer.actor), s.dealer.ref, 'exception.void', { exceptionId: c.id, reason: 'test clean-up' });
  });
});

describe('reference numbers never lose a digit (migration 0020)', () => {
  it('requests, quotes and trades past the 10,000th keep unique, complete references', async () => {
    for (const seq of ['trade_ref_seq', 'quote_ref_seq', 'trade_request_ref_seq']) await sql`select setval(${seq}::regclass, 9998)`.execute(w.t.owner);
    const refs: string[] = [];
    for (let i = 0; i < 3; i++) refs.push((await sellTrade('1')).tradeRef);
    expect(refs.map((r) => r.split('-')[2])).toEqual(['9999', '10000', '10001']);

    // Structural guard: no reference default may use lpad on its own again, since lpad truncates as well as pads.
    const defaults = await sql<{ table: string; expr: string }>`
      select c.relname as table, pg_get_expr(d.adbin, d.adrelid) as expr
      from pg_attrdef d
      join pg_class c on c.oid = d.adrelid
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
      where a.attname = 'ref' and c.relkind = 'r'`.execute(w.t.owner);
    expect(defaults.rows.length).toBeGreaterThanOrEqual(8);
    for (const d of defaults.rows) expect({ table: d.table, truncating: /\blpad\(/.test(d.expr) }).toEqual({ table: d.table, truncating: false });
  });
});

describe('a trade never pays out and refunds at once (FI-25)', () => {
  it('refuses a refund while a payout is in flight', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '10200.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    await expect(runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, treasuryWalletId: w.treasuryWalletId }))
      .rejects.toMatchObject({ code: 'PAYOUT_IN_FLIGHT' });
  });

  it('refuses a payout once a refund of the client funds is planned', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, treasuryWalletId: w.treasuryWalletId });
    await expect(runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '10200.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId }))
      .rejects.toMatchObject({ code: 'REFUND_IN_PROGRESS' });
  });
});

describe('a client may pay the INR of a BUY in more than one transfer (T2)', () => {
  it('two references recorded before either is confirmed make the trade payable once both are confirmed', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '106.000000', routeRate: '104.200000' });
    const record = (amount: string) => runAs(w.app, recordIncomingFiat(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.record', {
      tradeId: trade.tradeId, rail: 'IMPS' as const, utr: newUtr('IN'), amount, inrAccountId: w.inrAccountId,
    });
    const first = await record('600.00');
    const second = await record('460.00');
    await confirmLeg(first.legId);
    // Half of the client's money is confirmed and half is still being checked: that is not a short payment.
    expect(await openCasesOf(trade.tradeId)).toEqual([]);
    await confirmLeg(second.legId);
    expect(await stateOf(trade.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_CONFIRMED', hold: false });
  });
});

describe('a destination archived under an open trade opens CLIENT_BANK_CHANGED (SECURITY S8)', () => {
  let d: World;
  beforeAll(async () => { d = await createWorld('audit_destinations', { capacityInr: '500000000.00' }); });
  afterAll(async () => d.close());

  it('puts the open trade on hold with a case, once, and leaves a closed trade alone', async () => {
    const open = await openTrade(d, { executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '102.000000', routeRate: '104.200000' });
    const closed = await openTrade(d, { executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '102.000000', routeRate: '104.200000' });
    await runAs(d.app, cancelTrade(d.dealer.actor), d.dealer.ref, 'trade.cancel', { tradeId: closed.tradeId, reason: 'client withdrew before sending' });
    await runAs(d.app, archiveBankAccount(d.owner.actor), d.owner.ref, 'client_bank.archive', { bankAccountId: d.bankAccountId, reason: 'client closed this account' });

    const event = await d.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id'])
      .where('type', '=', 'client.destination_archived').orderBy('created_at', 'desc').executeTakeFirstOrThrow();
    const handler = destinationArchivedHandler(d.app);
    const deliver = () => handler.run({ id: event.id, type: event.type, aggregateType: event.aggregate_type, aggregateId: event.aggregate_id, payload: event.payload, correlationId: event.correlation_id });
    await deliver();
    await deliver(); // at-least-once delivery: the second one changes nothing

    const cases = (tradeId: string) => d.app.selectFrom('exception_case').select('type').where('trade_id', '=', tradeId).where('status', '=', 'OPEN').execute();
    expect((await cases(open.tradeId)).map((c) => c.type)).toEqual(['CLIENT_BANK_CHANGED']);
    expect((await d.app.selectFrom('trade').select('hold').where('id', '=', open.tradeId).executeTakeFirstOrThrow()).hold).toBe(true);
    expect(await cases(closed.tradeId)).toEqual([]);
  });
});

describe('refunds never exceed the client funds they return (FI-25, IX025)', () => {
  const refund = (tradeId: string, op = w.owner, key?: string) =>
    runAs(w.app, createRefundLeg(op.actor), op.ref, 'refund_leg.create', { tradeId, treasuryWalletId: w.treasuryWalletId }, key ?? randomUUID());
  const refundLegs = (tradeId: string) =>
    w.app.selectFrom('settlement_leg').select(['id', 'status', 'amount_minor']).where('trade_id', '=', tradeId).where('side', '=', 'REFUND_TO_CLIENT').execute();

  it('a planned refund counts: a second refund of the same funds is refused until the first is cancelled', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const first = await refund(trade.tradeId);
    await expect(refund(trade.tradeId)).rejects.toMatchObject({ code: 'REFUND_IN_PROGRESS' });
    await runAs(w.app, cancelPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.cancel', { legId: first.legId, reason: 'refund planned in error' });
    await refund(trade.tradeId);
    expect((await refundLegs(trade.tradeId)).map((l) => l.status).sort()).toEqual(['CANCELLED', 'PENDING']);
  });

  it('two operators refunding the same trade at the same moment produce one refund', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const results = await Promise.allSettled([refund(trade.tradeId, w.owner), refund(trade.tradeId, w.settlementOp)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'REFUND_IN_PROGRESS' } });
    expect(await refundLegs(trade.tradeId)).toHaveLength(1);
  });

  it('a retried request with the same idempotency key returns the same refund, not a second one', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const key = randomUUID();
    const a = await refund(trade.tradeId, w.owner, key);
    const b = await refund(trade.tradeId, w.owner, key);
    expect(b.legId).toBe(a.legId);
    expect(await refundLegs(trade.tradeId)).toHaveLength(1);
  });

  it('the database refuses refund legs that together exceed the confirmed client funds, however they are written', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    await refund(trade.tradeId);
    const insertSecond = w.t.owner.insertInto('settlement_leg').values({
      trade_id: trade.tradeId, seq: 99, ref: 'placeholder', side: 'REFUND_TO_CLIENT', asset: 'USDT', amount_minor: usdt('100'), payer: 'EXCHANGE_ACCOUNT',
      treasury_wallet_id: w.treasuryWalletId, created_by: 'test',
    }).execute();
    await expect(insertSecond).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX025');
    expect(await refundLegs(trade.tradeId)).toHaveLength(1);
  });
});

describe('a BUY trade is not cancelled around a recorded, unconfirmed INR payment', () => {
  const buyTrade = () => openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '106.000000', routeRate: '104.200000' });
  const recordInr = (tradeId: string, amount: string) =>
    runAs(w.app, recordIncomingFiat(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.record', { tradeId, rail: 'IMPS' as const, utr: newUtr('IN'), amount, inrAccountId: w.inrAccountId });

  it('refuses the cancellation, and allows it once the desk records that the payment did not arrive', async () => {
    const trade = await buyTrade();
    const recorded = await recordInr(trade.tradeId, '1060.00');
    await expect(runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client asked to cancel' }))
      .rejects.toMatchObject({ code: 'INCOMING_FIAT_UNCONFIRMED' });
    const live = await w.app.selectFrom('transfer_allocation').select('id').where('fiat_transfer_id', '=', recorded.transferId).where('voided_at', 'is', null).execute();
    expect(live).toHaveLength(1);

    await runAs(w.app, revertFirstLeg(w.settlementOp.actor), w.settlementOp.ref, 'settlement.revert_incoming', { legId: recorded.legId, reason: 'no matching credit in the collection account' });
    expect((await w.app.selectFrom('fiat_transfer').select('status').where('id', '=', recorded.transferId).executeTakeFirstOrThrow()).status).toBe('FAILED');
    expect((await stateOf(trade.tradeId)).lifecycle_state).toBe('AWAITING_FIRST_LEG');
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client asked to cancel' });
    expect((await stateOf(trade.tradeId)).lifecycle_state).toBe('CANCELLED');
    // The closed claim can never be confirmed into a payment afterwards.
    await expect(confirmLeg(recorded.legId)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('refund-and-cancel is refused too while part of the client INR is still unconfirmed', async () => {
    const trade = await buyTrade();
    const first = await recordInr(trade.tradeId, '600.00');
    await confirmLeg(first.legId);
    await recordInr(trade.tradeId, '460.00');
    const planned = await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, inrAccountId: w.inrAccountId });
    await runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId: planned.legId, rail: 'IMPS' as const, utr: newUtr('RF') });
    await expect(runAs(w.app, refundAndCancel(w.dealer.actor), w.dealer.ref, 'trade.refund_and_cancel', { tradeId: trade.tradeId, reason: 'client withdrew' }))
      .rejects.toMatchObject({ code: 'INCOMING_FIAT_UNCONFIRMED' });
  });
});

describe('a statement reference shared across rails is never matched by guess (SECURITY S7)', () => {
  let r: World;
  beforeAll(async () => { r = await createWorld('audit_statement_rails', { capacityInr: '500000000.00' }); });
  afterAll(async () => r.close());

  const today = async () => (await sql<{ day: string }>`select to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day`.execute(r.app)).rows[0]!.day;
  async function importLines(lines: readonly { reference: string; amount: string; direction: 'CREDIT' | 'DEBIT' }[]) {
    const day = await today();
    return runAs(r.app, importBankStatement(r.financeOp.actor), r.financeOp.ref, 'statement.import', {
      inrAccountId: r.inrAccountId, periodFrom: day, periodTo: day, filename: 'statement.csv',
      sha256: createHash('sha256').update(randomUUID()).digest('hex'), lines: lines.map((l) => ({ valueDate: day, ...l })),
    });
  }
  async function paidLeg(tradeId: string, amount: string, rail: 'IMPS' | 'NEFT', utr: string) {
    const leg = await runAs(r.app, createPayoutLeg(r.settlementOp.actor, {}), r.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: r.inrAccountId });
    await runAs(r.app, sendPayoutLeg(r.settlementOp.actor), r.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    const ev = await runAs(r.app, recordLegEvidence(r.settlementOp.actor, r.settlementDeps), r.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail, utr });
    await confirmPayout(r.app, r.settlementOp.actor, r.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    return ev.transferId;
  }
  const lineOf = (importId: string) => r.app.selectFrom('bank_statement_line').select(['outcome', 'fiat_transfer_id']).where('import_id', '=', importId).orderBy('seq').execute();
  const reasonsOn = async (transferId: string) =>
    (await r.app.selectFrom('exception_case').select(sql<string>`details ->> 'reason'`.as('reason')).where('subject_id', '=', transferId).execute()).map((c) => c.reason);

  it('matches only the transfer that account, reference, direction and amount single out; otherwise it is ambiguous and reviewed', async () => {
    const t1 = await openTrade(r, { executionMode: 'TO_EXCHANGE', baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000' });
    await settleFirstLeg(r, t1.tradeId);
    const t2 = await openTrade(r, { executionMode: 'TO_EXCHANGE', baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000' });
    await settleFirstLeg(r, t2.tradeId);
    const x = newUtr('XR');
    const y = newUtr('YR');
    const onImps = await paidLeg(t1.tradeId, '5000.00', 'IMPS', x);
    const onNeft = await paidLeg(t1.tradeId, '5200.00', 'NEFT', x.toLowerCase());
    const sameImps = await paidLeg(t2.tradeId, '3000.00', 'IMPS', y);
    const sameNeft = await paidLeg(t2.tradeId, '3000.00', 'NEFT', y);

    // One statement: a line whose amount singles out one of the two transfers sharing its reference, and a line
    // whose reference, amount and direction fit two transfers equally.
    const out = await importLines([{ reference: x, amount: '5200.00', direction: 'DEBIT' }, { reference: y, amount: '3000.00', direction: 'DEBIT' }]);
    expect(await lineOf(out.importId)).toEqual([{ outcome: 'MATCHED', fiat_transfer_id: onNeft }, { outcome: 'AMBIGUOUS', fiat_transfer_id: null }]);
    expect(out).toMatchObject({ matched: 1, ambiguous: 1, mismatched: 1 });
    expect(await reasonsOn(onNeft)).toEqual([]);
    expect(await reasonsOn(sameImps)).toEqual(['STATEMENT_REFERENCE_AMBIGUOUS']);
    expect(await reasonsOn(sameNeft)).toEqual(['STATEMENT_REFERENCE_AMBIGUOUS']);
    // The sibling of the matched transfer, on the other rail, was not on the statement: still reported missing.
    expect(await reasonsOn(onImps)).toEqual(['NOT_IN_STATEMENT']);

    // A shared reference whose amount fits neither: ambiguous as well, not a mismatch against an arbitrary one.
    const neither = await importLines([{ reference: x, amount: '7000.00', direction: 'DEBIT' }]);
    expect(await lineOf(neither.importId)).toEqual([{ outcome: 'AMBIGUOUS', fiat_transfer_id: null }]);
  });

  it('a statement that shows a payment the desk recorded as not received goes to review, not to a match', async () => {
    const trade = await openTrade(r, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '106.000000', routeRate: '104.200000' });
    const utr = newUtr('NR');
    const recorded = await runAs(r.app, recordIncomingFiat(r.settlementOp.actor), r.settlementOp.ref, 'fiat_in.record', {
      tradeId: trade.tradeId, rail: 'IMPS' as const, utr, amount: '1060.00', inrAccountId: r.inrAccountId,
    });
    await runAs(r.app, revertFirstLeg(r.settlementOp.actor), r.settlementOp.ref, 'settlement.revert_incoming', { legId: recorded.legId, reason: 'no matching credit in the collection account' });
    const out = await importLines([{ reference: utr, amount: '1060.00', direction: 'CREDIT' }]);
    expect(await lineOf(out.importId)).toEqual([{ outcome: 'MISMATCHED', fiat_transfer_id: recorded.transferId }]);
    expect(await reasonsOn(recorded.transferId)).toEqual(['STATEMENT_SHOWS_FAILED_TRANSFER']);
  });
});
