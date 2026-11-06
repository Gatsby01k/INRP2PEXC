import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { pgErrorCode } from '@inrp2p/db';
import { effectiveObligations } from '@inrp2p/trades';
import { archiveBankAccount } from '@inrp2p/clients';
import { submitOrderPayment } from '@inrp2p/traders';
import {
  approveAdjustment, cancelTrade, claimIncomingFiat, createRefundLeg, destinationArchivedHandler, requestAdjustment, resolveException, submitTxForVerification,
} from '../src/index.ts';
import { balanceOf, clientDepositAddressOf, confirmLeg, createWorld, fundEscrow, observe, openTrade, payClient, scenarioTrader, settleFirstLeg, type World } from './world.ts';

/**
 * Regressions found by the end-to-end audit (2026-09-25). Each test states the flow a desk actually runs and the
 * state the system must be in afterwards; before the fixes, every one of them left money stranded, a trade stuck,
 * or an invariant silently broken.
 */
let w: World;
beforeAll(async () => { w = await createWorld('audit_regressions'); });
afterAll(async () => w.close());

const usdt = (decimal: string) => Money.parse(decimal, 'USDT').minor;
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select(['lifecycle_state', 'hold']).where('id', '=', tradeId).executeTakeFirstOrThrow());
const openCasesOf = (tradeId: string) =>
  w.app.selectFrom('exception_case').select(['id', 'type', 'subject_type']).where('trade_id', '=', tradeId).where('status', 'in', ['OPEN', 'IN_PROGRESS']).orderBy('opened_at').execute();
const sellTrade = (baseUsdt: string) => openTrade(w, { baseUsdt, clientRate: '102.000000' });

async function depositTo(tradeId: string, amountUsdt: string, from = w.clientSourceAddress) {
  const a = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow();
  const receipt = w.chain.add({ from, to: a.address, amountMinor: usdt(amountUsdt) });
  return runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
}
const resolve = (exceptionId: string, resolution: 'await_top_up' | 'escalate' = 'await_top_up') =>
  runAs(w.app, resolveException(w.dealer.actor), w.dealer.ref, 'exception.resolve', { exceptionId, resolution, notes: 'resolved by the desk after checking with the client' });

async function adjust(tradeId: string, deltas: { deltaBaseUsdt?: string; deltaClientInr?: string }, opts: { exceptionId?: string; type?: 'AMOUNT_CORRECTION' | 'RATE_CORRECTION' | 'WRITE_OFF' } = {}) {
  const requested = await runAs(w.app, requestAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.request', {
    tradeId, type: opts.type ?? ('AMOUNT_CORRECTION' as const), ...deltas, reason: 'agreed correction recorded by the desk', ...(opts.exceptionId ? { exceptionId: opts.exceptionId } : {}),
  });
  return { requested, approve: () => runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId }) };
}

describe('a short first leg is recoverable (DOMAIN_MODEL §3 USDT_WRONG_AMOUNT)', () => {
  it('await_top_up: the top-up is not itself a wrong amount, and resolving the cases makes the trade payable', async () => {
    const trade = await sellTrade('100');
    const first = await depositTo(trade.tradeId, '90');
    await confirmLeg(w, first.legId!);
    expect((await stateOf(trade.tradeId)).hold).toBe(true);

    // The client sends exactly what is missing: that is what the desk asked for, not a second mistake.
    const topUp = await depositTo(trade.tradeId, '10');
    expect(await w.app.selectFrom('exception_case').select('type').where('subject_id', '=', topUp.transferId).execute()).toEqual([]);
    await confirmLeg(w, topUp.legId!);

    for (const c of await openCasesOf(trade.tradeId)) await resolve(c.id);
    expect(await stateOf(trade.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_CONFIRMED', hold: false });
    await payClient(w, trade);
    expect((await stateOf(trade.tradeId)).lifecycle_state).toBe('COMPLETED');
  });

  it('adjust_trade_to_received: the approved adjustment makes the trade payable for what arrived, and its trader owes what the client is owed', async () => {
    const trade = await sellTrade('100');
    const first = await depositTo(trade.tradeId, '90');
    await confirmLeg(w, first.legId!);
    const tradeCase = (await openCasesOf(trade.tradeId)).find((c) => c.subject_type === 'TRADE')!;
    // 10 USDT fewer: the client is owed ₹1,020 less, and so — one amount of rupees — is what its trader pays.
    const { approve } = await adjust(trade.tradeId, { deltaBaseUsdt: '-10', deltaClientInr: '-1020.00' }, { exceptionId: tradeCase.id });
    await approve();
    for (const c of await openCasesOf(trade.tradeId)) await resolve(c.id, 'escalate');
    expect(await stateOf(trade.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_CONFIRMED', hold: false });

    await payClient(w, trade);
    expect((await stateOf(trade.tradeId)).lifecycle_state).toBe('COMPLETED');
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'USDT', { tradeId: trade.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'INR', { tradeId: trade.tradeId })).toBe(0n);
  });
});

describe('approval re-checks the effective terms (FI-20, FI-21, FI-61)', () => {
  it('refuses an approval that would put the obligation below what was already paid', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const { approve } = await adjust(trade.tradeId, { deltaClientInr: '-200.00' });
    await payClient(w, trade);
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

  it('refuses to change what a completed trade owes the client', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    await payClient(w, trade);
    await expect(adjust(trade.tradeId, { deltaClientInr: '100.00' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });
});

describe('cancellation leaves nothing behind (T9, FI-12)', () => {
  it('reverses posted adjustments with the acceptance, so every trade account ends at zero', async () => {
    const trade = await sellTrade('100');
    const { approve } = await adjust(trade.tradeId, { deltaClientInr: '-100.00' }, { type: 'RATE_CORRECTION' });
    await approve();
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client withdrew before sending' });
    for (const [code, currency] of [
      ['ASSET:CLIENT_RECEIVABLE', 'USDT'], ['LIAB:ROUTE_PAYABLE', 'USDT'], ['ASSET:ROUTE_RECEIVABLE', 'INR'], ['LIAB:CLIENT_PAYABLE', 'INR'], ['LIAB:DEFERRED_MARGIN', 'USDT'],
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
    expect(await w.app.selectFrom('transfer_allocation').select('id').where('crypto_transfer_id', '=', detected.transferId).where('voided_at', 'is', null).execute()).toEqual([]);
    const cases = await w.app.selectFrom('exception_case').select('type').where('subject_id', '=', detected.transferId).where('status', '=', 'OPEN').execute();
    expect(cases.map((c) => c.type)).toEqual(['FUNDS_AFTER_TRADE_CLOSED']);
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
    await payClient(w, trade, { confirm: false });
    const deposit = await clientDepositAddressOf(w, trade.tradeId);
    await expect(runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, sourceDepositAddressId: deposit.id }))
      .rejects.toMatchObject({ code: 'PAYOUT_IN_FLIGHT' });
  });

  it('refuses a payout once a refund of the client funds is planned', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    const deposit = await clientDepositAddressOf(w, trade.tradeId);
    await observe(w, deposit.address);
    await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, sourceDepositAddressId: deposit.id });
    const trader = await scenarioTrader(w);
    await expect(runAs(w.app, submitOrderPayment(trader.admin.actor), trader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: '123456789012' }))
      .rejects.toMatchObject({ code: 'REFUND_IN_PROGRESS' });
  });
});

describe('a destination archived under an open trade opens CLIENT_BANK_CHANGED (SECURITY S8)', () => {
  let d: World;
  beforeAll(async () => { d = await createWorld('audit_destinations'); });
  afterAll(async () => d.close());

  it('puts the open trade on hold with a case, once, and leaves a closed trade alone', async () => {
    const open = await openTrade(d, { baseUsdt: '10', clientRate: '102.000000' });
    const closed = await openTrade(d, { baseUsdt: '10', clientRate: '102.000000' });
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
  // A SELL client's USDT goes back from the deposit address it arrived at (D-16).
  const refund = async (tradeId: string, op = w.owner, key?: string) => {
    const deposit = await clientDepositAddressOf(w, tradeId);
    await observe(w, deposit.address);
    return runAs(w.app, createRefundLeg(op.actor), op.ref, 'refund_leg.create', { tradeId, sourceDepositAddressId: deposit.id }, key ?? randomUUID());
  };
  const refundLegs = (tradeId: string) =>
    w.app.selectFrom('settlement_leg').select(['id', 'status', 'amount_minor']).where('trade_id', '=', tradeId).where('side', '=', 'REFUND_TO_CLIENT').execute();

  it('a planned refund counts: a second refund of the same funds is refused', async () => {
    const trade = await sellTrade('100');
    await settleFirstLeg(w, trade.tradeId);
    await refund(trade.tradeId);
    await expect(refund(trade.tradeId)).rejects.toMatchObject({ code: 'REFUND_IN_PROGRESS' });
    expect(await refundLegs(trade.tradeId)).toHaveLength(1);
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
    // Two guards refuse it at commit: the refund total (IX025) and the missing earmark of the client's money (IX086).
    await expect(insertSecond).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX025' || pgErrorCode(e) === 'IX086');
    expect(await refundLegs(trade.tradeId)).toHaveLength(1);
  });
});

describe('a BUY trade is not cancelled around a recorded, unconfirmed INR payment', () => {
  it('refuses the cancellation while the client’s claim waits for its trader', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', baseUsdt: '10', clientRate: '106.000000' });
    await fundEscrow(w, trade);
    await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'IMPS' as const, utr: '223456789012', fromBankAccountId: w.bankAccountId });
    await expect(runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client asked to cancel' }))
      .rejects.toMatchObject({ code: 'INCOMING_FIAT_UNCONFIRMED' });
  });
});
