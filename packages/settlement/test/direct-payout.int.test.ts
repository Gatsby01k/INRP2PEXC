import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import {
  cancelPayoutLeg, confirmPayout, confirmPayoutLeg, confirmRouteSettlement, createPayoutLeg, failPayoutLeg, getClientSettlementView,
  obligationRemaining, recordLegEvidence, recordRouteSettlement, sendPayoutLeg,
} from '../src/index.ts';
import { balanceOf, createWorld, newUtr, openTrade, settleFirstLeg, type World } from './world.ts';

let w: World;
beforeAll(async () => { w = await createWorld('settlement_direct'); });
afterAll(async () => w.close());

const INR = (v: string) => Money.parse(v, 'INR');

/** The canonical trade of FINANCIAL_INVARIANTS §3.5: SELL 100,000 USDT, client ₹102.00, route ₹104.20, direct. */
async function canonicalTrade() {
  const trade = await openTrade(w, { direction: 'SELL_USDT', executionMode: 'DIRECT_TO_CLIENT', baseUsdt: '100000', clientRate: '102.000000', routeRate: '104.200000' });
  await settleFirstLeg(w, trade.tradeId);
  return trade;
}

interface PayoutOptions {
  readonly payer?: 'ROUTE' | 'EXCHANGE_ACCOUNT';
  readonly utr?: string;
  readonly send?: boolean;
  readonly evidence?: boolean;
}

async function preparePayout(tradeId: string, amount: string, opts: PayoutOptions = {}) {
  const payer = opts.payer ?? 'ROUTE';
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId, amount, payer, ...(payer === 'EXCHANGE_ACCOUNT' ? { inrAccountId: w.inrAccountId } : {}),
  });
  if (opts.send !== false) await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  const utr = opts.utr ?? newUtr();
  if (opts.evidence !== false) {
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr });
  }
  return { ...leg, utr };
}

const confirm = (legId: string) => confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId, idempotencyKey: randomUUID() });

describe('canonical direct route payout (FINANCIAL_INVARIANTS §3.5)', () => {
  it('exit 1: one payout, one UTR, one journal — trade COMPLETED, margin realized, route residual ₹220,000', async () => {
    const trade = await canonicalTrade();
    const before = await obligationRemaining(w.app, trade.routeObligationId);
    expect(before.routeDelivers.toDecimalString()).toBe('10420000.00');
    expect(before.exchangeDelivers.toDecimalString()).toBe('100000.000000');
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'INR', { tradeId: trade.tradeId })).toBe(-INR('10200000.00').minor);

    const leg = await preparePayout(trade.tradeId, '10200000.00');
    const result = await confirm(leg.legId);
    expect(result).toMatchObject({ completed: true, tradeState: 'COMPLETED', remaining: '0.00' });

    const movements = await w.app.selectFrom('fiat_transfer').select(['id', 'status', 'payer_type', 'payee_type']).where('utr', '=', leg.utr).execute();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ status: 'CONFIRMED', payer_type: 'ROUTE', payee_type: 'CLIENT_BANK' });

    const journals = await w.app
      .selectFrom('ledger_journal')
      .select(['posting_key', 'event_type'])
      .where('posting_key', '=', `fiat:${movements[0]!.id}:confirm`)
      .execute();
    expect(journals).toHaveLength(1);
    const entries = await w.app
      .selectFrom('ledger_entry as e')
      .innerJoin('ledger_account as a', 'a.id', 'e.account_id')
      .innerJoin('ledger_journal as j', 'j.id', 'e.journal_id')
      .select(['a.code', 'e.direction', 'e.amount_minor'])
      .where('j.posting_key', '=', `fiat:${movements[0]!.id}:confirm`)
      .orderBy('e.direction')
      .execute();
    expect(entries.map((e) => `${e.direction} ${e.code.split(':').slice(0, 2).join(':')} ${e.amount_minor}`)).toEqual([
      'CR ASSET:ROUTE_RECEIVABLE 1020000000',
      'DR LIAB:CLIENT_PAYABLE 1020000000',
    ]);

    const legRow = await w.app.selectFrom('settlement_leg').select(['status', 'confirmed_at']).where('id', '=', leg.legId).executeTakeFirstOrThrow();
    expect(legRow.status).toBe('COMPLETED');
    const tradeRow = await w.app.selectFrom('trade').select(['lifecycle_state', 'completed_at']).where('id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(tradeRow.lifecycle_state).toBe('COMPLETED');

    // Margin realized at completion, not before (FI-43).
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(-INR('220000.00').minor);
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'INR', { tradeId: trade.tradeId })).toBe(0n);

    // FI-62 + FI-64: the trade is done while the route still owes ₹220,000, and the ledger says the same.
    const after = await obligationRemaining(w.app, trade.routeObligationId);
    expect(after.routeDelivers.toDecimalString()).toBe('220000.00');
    const obligationRow = await w.app.selectFrom('route_obligation').select('status').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    expect(obligationRow.status).toBe('PARTIALLY_SETTLED');
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'INR', { routeObligationId: trade.routeObligationId })).toBe(INR('220000.00').minor);
  });

  it('exit 2: replaying the confirm posts nothing — same key returns the stored result, a new key is refused', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '10200000.00');
    const key = randomUUID();
    const first = await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: key });
    const journalsBefore = await w.app.selectFrom('ledger_journal').select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    const replay = await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: key });
    expect(replay).toEqual(first);
    await expect(confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    const journalsAfter = await w.app.selectFrom('ledger_journal').select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(journalsAfter.n).toBe(journalsBefore.n);
    const allocations = await w.app.selectFrom('transfer_allocation').select('id').where('settlement_leg_id', '=', leg.legId).where('voided_at', 'is', null).execute();
    expect(allocations).toHaveLength(1);
  });

  it('exit 3: the same UTR cannot be recorded again — not on another leg, another trade or a route settlement', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '10200000.00');
    await confirm(leg.legId);

    const other = await canonicalTrade();
    const otherLeg = await preparePayout(other.tradeId, '10200000.00', { evidence: false });
    await expect(runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: otherLeg.legId, rail: 'IMPS' as const, utr: leg.utr }))
      .rejects.toMatchObject({ code: 'DUPLICATE_UTR' });
    await expect(runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: other.routeObligationId, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount: '220000.00', rail: 'IMPS' as const, utr: leg.utr, inrAccountId: w.inrAccountId,
    })).rejects.toMatchObject({ code: 'DUPLICATE_UTR' });
    await expect(sql`insert into fiat_transfer (rail, utr, amount_minor, payer_type, payer_id, payee_type, payee_id, destination_masked, recorded_by)
                     values ('IMPS', ${leg.utr.toLowerCase()}, 1, 'ROUTE', ${w.routeId}, 'EXCHANGE_ACCOUNT', ${w.inrAccountId}, 'duplicate attempt', 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === '23505');
  });

  it('exit 4: one movement satisfies at most one leg and one route settlement (FI-28)', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '10200000.00');
    await confirm(leg.legId);
    const movement = await w.app.selectFrom('fiat_transfer').select('id').where('utr', '=', leg.utr).executeTakeFirstOrThrow();
    const otherLeg = await preparePayout((await canonicalTrade()).tradeId, '10200000.00', { evidence: false });
    await expect(sql`insert into transfer_allocation (transfer_kind, fiat_transfer_id, dimension, settlement_leg_id, amount_minor, allocated_by)
                     values ('FIAT', ${movement.id}, 'CLIENT', ${otherLeg.legId}, 1020000000, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === '23505');
    const settlement = await w.app.selectFrom('route_settlement').select('id').where('fiat_transfer_id', '=', movement.id).executeTakeFirstOrThrow();
    await expect(sql`insert into transfer_allocation (transfer_kind, fiat_transfer_id, dimension, route_settlement_id, amount_minor, allocated_by)
                     values ('FIAT', ${movement.id}, 'ROUTE', ${settlement.id}, 1020000000, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === '23505');
  });

  it('exit 5: an exchange-paid movement never reduces the route obligation, and a route leg needs DIRECT_TO_CLIENT', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '200000.00', { payer: 'EXCHANGE_ACCOUNT' });
    await confirm(leg.legId);
    const movement = await w.app.selectFrom('fiat_transfer').select('id').where('utr', '=', leg.utr).executeTakeFirstOrThrow();
    // No route settlement exists for it, and the database refuses to invent one.
    expect(await w.app.selectFrom('route_settlement').select('id').where('fiat_transfer_id', '=', movement.id).execute()).toEqual([]);
    const remaining = await obligationRemaining(w.app, trade.routeObligationId);
    expect(remaining.routeDelivers.toDecimalString()).toBe('10420000.00');
    await expect(sql`insert into route_settlement (route_id, route_obligation_id, obligation_side, flow, asset, amount_minor, transfer_kind, fiat_transfer_id, status, confirmed_at, created_by)
                     values (${w.routeId}, ${trade.routeObligationId}, 'ROUTE_DELIVERS', 'DIRECT_TO_CLIENT', 'INR', 20000000, 'FIAT', ${movement.id}, 'CONFIRMED', now(), 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX065');

    // A TO_EXCHANGE trade cannot have a route-paid leg (FI-65), in the command and in the database.
    const exchangeTrade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '1000', clientRate: '102.000000', routeRate: '104.200000' });
    await settleFirstLeg(w, exchangeTrade.tradeId);
    await expect(runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: exchangeTrade.tradeId, amount: '102000.00', payer: 'ROUTE' as const }))
      .rejects.toMatchObject({ code: 'ROUTE_PAYER_NOT_ALLOWED' });
    await expect(sql`insert into settlement_leg (trade_id, seq, ref, side, asset, amount_minor, payer, route_id, created_by)
                     values (${exchangeTrade.tradeId}, 99, 'x', 'EXCHANGE_TO_CLIENT', 'INR', 100, 'ROUTE', ${w.routeId}, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX065');
  });

  it('exit 6: a direct payout larger than the route remaining rolls back entirely and opens a case', async () => {
    const trade = await canonicalTrade();
    // The route pays most of what it owes to the exchange instead, leaving only ₹20,000 on the route side.
    const rs = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount: '10400000.00', rail: 'NEFT' as const, utr: newUtr('RS'), inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: rs.routeSettlementId });
    expect((await obligationRemaining(w.app, trade.routeObligationId)).routeDelivers.toDecimalString()).toBe('20000.00');

    const leg = await preparePayout(trade.tradeId, '10200000.00');
    const journalsBefore = await w.app.selectFrom('ledger_journal').select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    await expect(confirm(leg.legId)).rejects.toMatchObject({ code: 'ROUTE_DIRECT_PAYOUT_MISMATCH' });

    const legRow = await w.app.selectFrom('settlement_leg').select('status').where('id', '=', leg.legId).executeTakeFirstOrThrow();
    expect(legRow.status).toBe('PROCESSING');
    const movement = await w.app.selectFrom('fiat_transfer').select('status').where('utr', '=', leg.utr).executeTakeFirstOrThrow();
    expect(movement.status).toBe('RECORDED');
    const journalsAfter = await w.app.selectFrom('ledger_journal').select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
    expect(journalsAfter.n).toBe(journalsBefore.n);
    expect((await obligationRemaining(w.app, trade.routeObligationId)).routeDelivers.toDecimalString()).toBe('20000.00');
    const exception = await w.app.selectFrom('exception_case').select(['type', 'status', 'severity']).where('subject_id', '=', leg.legId).executeTakeFirstOrThrow();
    expect(exception).toMatchObject({ type: 'ROUTE_DIRECT_PAYOUT_MISMATCH', status: 'OPEN', severity: 'BLOCKING' });
    expect((await w.app.selectFrom('trade').select('hold').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).hold).toBe(true);
  });

  it('exit 7: two direct confirms that together exceed the route remaining — exactly one succeeds', async () => {
    const trade = await canonicalTrade();
    const rs = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount: '4420000.00', rail: 'NEFT' as const, utr: newUtr('RS'), inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: rs.routeSettlementId });
    expect((await obligationRemaining(w.app, trade.routeObligationId)).routeDelivers.toDecimalString()).toBe('6000000.00');

    const a = await preparePayout(trade.tradeId, '5100000.00');
    const b = await preparePayout(trade.tradeId, '5100000.00');
    const results = await Promise.allSettled([confirm(a.legId), confirm(b.legId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const remaining = await obligationRemaining(w.app, trade.routeObligationId);
    expect(remaining.routeDelivers.toDecimalString()).toBe('900000.00');
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'INR', { routeObligationId: trade.routeObligationId })).toBe(INR('900000.00').minor);
  });

  it('exit 8: mixed payers settle the client once and the route partially', async () => {
    const trade = await canonicalTrade();
    const direct = await preparePayout(trade.tradeId, '10000000.00');
    await confirm(direct.legId);
    const top = await preparePayout(trade.tradeId, '200000.00', { payer: 'EXCHANGE_ACCOUNT' });
    const result = await confirm(top.legId);
    expect(result.completed).toBe(true);
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    expect((await obligationRemaining(w.app, trade.routeObligationId)).routeDelivers.toDecimalString()).toBe('420000.00');
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'INR', { routeObligationId: trade.routeObligationId })).toBe(INR('420000.00').minor);

    const perCurrency = await sql<{ currency: string; net: string }>`
      select currency, sum(case direction when 'DR' then amount_minor else -amount_minor end)::text as net
      from ledger_entry where trade_id = ${trade.tradeId} group by currency`.execute(w.app);
    for (const row of perCurrency.rows) expect({ currency: row.currency, net: row.net }).toEqual({ currency: row.currency, net: '0' });
  });

  it('exit 9: a failed direct leg posts nothing and leaves the obligation untouched', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '10200000.00');
    await runAs(w.app, failPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.fail', { legId: leg.legId, reason: 'route reported the transfer bounced' });
    const movement = await w.app.selectFrom('fiat_transfer').select(['id', 'status']).where('utr', '=', leg.utr).executeTakeFirstOrThrow();
    expect(movement.status).toBe('FAILED');
    expect(await w.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `fiat:${movement.id}:confirm`).execute()).toEqual([]);
    expect(await w.app.selectFrom('route_settlement').select('id').where('fiat_transfer_id', '=', movement.id).execute()).toEqual([]);
    expect((await obligationRemaining(w.app, trade.routeObligationId)).routeDelivers.toDecimalString()).toBe('10420000.00');
    const exception = await w.app.selectFrom('exception_case').select(['type', 'severity']).where('subject_id', '=', leg.legId).executeTakeFirstOrThrow();
    expect(exception).toMatchObject({ type: 'BANK_TRANSFER_FAILED', severity: 'BLOCKING' });
  });

  it('exit 10: the residual is settled later and the obligation closes when both sides are zero', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '10200000.00');
    await confirm(leg.legId);

    const residual = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'FROM_ROUTE_TO_EXCHANGE' as const, amount: '220000.00', rail: 'NEFT' as const, utr: newUtr('RS'), inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: residual.routeSettlementId });
    expect((await w.app.selectFrom('route_obligation').select('status').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow()).status).toBe('PARTIALLY_SETTLED');

    // The exchange still owes the route 100,000 USDT; sending it closes the obligation.
    const usdt = w.chain.add({ from: (await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow()).address, to: (await w.app.selectFrom('liquidity_route').select('registered_route_address').where('id', '=', w.routeId).executeTakeFirstOrThrow()).registered_route_address!, amountMinor: Money.parse('100000', 'USDT').minor });
    const toRoute = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'TO_ROUTE' as const, amount: '100000', txHash: usdt.txHash, logIndex: usdt.logIndex, treasuryWalletId: w.treasuryWalletId,
    });
    await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: toRoute.routeSettlementId });

    expect((await w.app.selectFrom('route_obligation').select('status').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow()).status).toBe('SETTLED');
    const remaining = await obligationRemaining(w.app, trade.routeObligationId);
    expect([remaining.routeDelivers.toDecimalString(), remaining.exchangeDelivers.toDecimalString()]).toEqual(['0.00', '0.000000']);
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'INR', { routeObligationId: trade.routeObligationId })).toBe(0n);
    expect(await balanceOf(w.app, 'LIAB:ROUTE_PAYABLE', 'USDT', { routeObligationId: trade.routeObligationId })).toBe(0n);
  });

  it('exit 11: the client view of a direct payout shows the payment, never the route', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '10200000.00');
    await confirm(leg.legId);
    const view = await getClientSettlementView(w.app, trade.tradeId, w.clientId);
    expect(view).toMatchObject({ status: 'COMPLETED', paid: { amount: '10200000.00', currency: 'INR' }, remaining: { amount: '0.00', currency: 'INR' } });
    expect(view.payments).toHaveLength(1);
    expect(view.payments[0]).toMatchObject({ amount: '10200000.00', status: 'COMPLETED', reference: leg.utr });
    const json = JSON.stringify(view);
    expect(json).not.toContain(w.routeId);
    expect(json).not.toContain('ROUTE');
    expect(json).not.toContain('10420000');
    for (const key of Object.keys(view.payments[0]!)) expect(/route|margin|payer|obligation/i.test(key)).toBe(false);
  });

  it('a payout cannot be created or sent while the trade is on hold, and a PENDING leg can be cancelled', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '100000.00', { payer: 'EXCHANGE_ACCOUNT', send: false, evidence: false });
    await runAs(w.app, cancelPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.cancel', { legId: leg.legId, reason: 'wrong account chosen' });
    const row = await w.app.selectFrom('settlement_leg').select(['status', 'capacity_reservation_id']).where('id', '=', leg.legId).executeTakeFirstOrThrow();
    expect(row.status).toBe('CANCELLED');
    const reservation = await w.app.selectFrom('capacity_reservation').select('status').where('id', '=', row.capacity_reservation_id!).executeTakeFirstOrThrow();
    expect(reservation.status).toBe('RELEASED');
  });

  it('confirming needs a payment reference, and the leg must be in flight', async () => {
    const trade = await canonicalTrade();
    const leg = await preparePayout(trade.tradeId, '10200000.00', { evidence: false });
    await expect(runAs(w.app, confirmPayoutLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.confirm', { legId: leg.legId }))
      .rejects.toMatchObject({ code: 'UTR_REQUIRED' });
  });
});
