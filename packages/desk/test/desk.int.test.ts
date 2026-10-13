import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, isTronAddress } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { createQuote, createQuoteLink, createRequest, sendQuote } from '@inrp2p/quotes';
import { publishRouteRate } from '@inrp2p/pricing';
import {
  cancelTrade, confirmFirstLeg, confirmPayout, createPayoutLeg, openException, recordIncomingFiat, recordLegEvidence, requestAdjustment, sendPayoutLeg,
} from '@inrp2p/settlement';
import {
  FULL_ACCESS, NO_ECONOMICS, accessFor, clientBook, clientDetail, deskApprovals, deskExceptions, deskQueue, deskStrip, deskTrade, deskTradeRecord,
  deskQuote, findByRef, inrView, listOrders, orderCounts, rateHistory, routePositions, searchOrders, tradeIdByRef, usdtView,
} from '../src/index.ts';
import { type World, createWorld, deliverCounterparty, newUtr, openTrade, settleFirstLeg, ensureCounterpartyFunds } from '../../settlement/test/world.ts';

let w: World;
beforeAll(async () => { w = await createWorld('desk_views', { capacityInr: '500000000.00' }); });
afterAll(async () => w.close());

const groupOf = (groups: Awaited<ReturnType<typeof deskQueue>>, key: string) => groups.find((g) => g.key === key);
const rowFor = (groups: Awaited<ReturnType<typeof deskQueue>>, tradeId: string) =>
  groups.flatMap((g) => g.rows.map((r) => ({ group: g.key, row: r }))).find((x) => x.row.subject.id === tradeId);

async function payoutLeg(tradeId: string, amount: string, opts: { confirm?: boolean } = {}) {
  await ensureCounterpartyFunds(w, tradeId);
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
  });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  const utr = newUtr();
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', {
    legId: leg.legId, rail: 'IMPS' as const, utr,
  });
  if (opts.confirm !== false) await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
  return { ...leg, utr };
}

describe('the operational strip', () => {
  it('reports today’s INR capacity, treasury, open trades and the route rates a dealer prices against', async () => {
    const strip = await deskStrip(w.app, FULL_ACCESS);
    expect(Money.parse(strip.inrAvailableToday, 'INR').isPositive()).toBe(true);
    expect(strip.istDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(strip.routes?.some((r) => r.direction === 'SELL_USDT' && r.rate !== null)).toBe(true);
    expect(strip.realizedMarginToday).toBeDefined();
    expect(strip.openTrades).toBeGreaterThanOrEqual(0);
  });

  it('omits the route rates and the margin entirely for an operator without economics:view', async () => {
    const strip = await deskStrip(w.app, NO_ECONOMICS);
    // Field absence, not blanking: there is nothing in the payload to leak (SECURITY §5).
    expect('routes' in strip).toBe(false);
    expect('realizedMarginToday' in strip).toBe(false);
    expect(strip.inrAvailableToday).toBeDefined();
  });

  it('derives view access from the operator’s own roles', async () => {
    expect(accessFor(w.settlementOp.actor)).toEqual({ economics: false, routePositions: false, pnl: false });
    expect(accessFor(w.dealer.actor)).toEqual({ economics: true, routePositions: true, pnl: true });
    expect(accessFor(w.owner.actor)).toEqual({ economics: true, routePositions: true, pnl: true });
  });
});

describe('the desk queue', () => {
  it('puts a new request in needs action with the quote as its next step', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '250', bankAccountId: w.bankAccountId,
    });
    const groups = await deskQueue(w.app, FULL_ACCESS);
    const row = groupOf(groups, 'needs_action')?.rows.find((r) => r.subject.id === request.requestId);
    expect(row).toMatchObject({ status: 'New request', action: 'QUOTE', direction: 'SELL_USDT', baseUsdt: '250.000000' });
  });

  it('moves a trade through waiting client → needs action → settlement as its money moves', async () => {
    const trade = await openTrade(w, { baseUsdt: '1000', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });

    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toMatchObject({
      group: 'waiting_client',
      row: { status: 'Awaiting USDT', action: 'NONE' },
    });

    await settleFirstLeg(w, trade.tradeId);
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toMatchObject({
      group: 'needs_action',
      row: { status: 'USDT confirmed', action: 'CREATE_PAYOUT' },
    });

    // A leg in flight without its reference is the desk's next job; with it, the confirm is.
    await ensureCounterpartyFunds(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
      tradeId: trade.tradeId, amount: '50000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toMatchObject({
      group: 'settlement',
      row: { status: 'Payout sent · needs reference', action: 'RECORD_EVIDENCE' },
    });

    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', {
      legId: leg.legId, rail: 'IMPS' as const, utr: newUtr(),
    });
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toMatchObject({
      group: 'settlement',
      row: { status: 'Payout in flight', action: 'CONFIRM_PAYOUT' },
    });

    await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toMatchObject({
      group: 'needs_action',
      row: { status: 'Payout remaining', action: 'CREATE_PAYOUT' },
    });

    await payoutLeg(trade.tradeId, '52000.00');
    // Completed trades leave the queue entirely.
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toBeUndefined();
  });

  it('says what an exception actually is, in the desk’s own words', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId, { amountUsdt: '99.95' });

    const placed = rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId);
    expect(placed?.group).toBe('exception');
    expect(placed?.row.status).toBe('Short by 0.050000 USDT');
    expect(placed?.row.action).toBe('RESOLVE_EXCEPTION');
    expect(placed?.row.hold).toBe(true);
  });

  it('counts a short BUY first leg in rupees, because that is what the client sent', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', baseUsdt: '10', clientRate: '106.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    const recorded = await runAs(w.app, recordIncomingFiat(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.record', {
      tradeId: trade.tradeId, rail: 'IMPS' as const, utr: newUtr('IN'), amount: '1000.00', inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmFirstLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'settlement.confirm_incoming', { legId: recorded.legId });
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)?.row.status).toBe('Short by 60.00 INR');
  });

  it('never carries a rate or a margin for an operator without economics:view', async () => {
    const groups = await deskQueue(w.app, NO_ECONOMICS);
    for (const g of groups) {
      for (const row of g.rows) {
        expect('clientRate' in row).toBe(false);
        expect('routeRate' in row).toBe(false);
        expect('margin' in row).toBe(false);
      }
    }
    const full = await deskQueue(w.app, FULL_ACCESS);
    expect(full.flatMap((g) => g.rows).some((r) => r.margin !== undefined)).toBe(true);
  });
});

describe('the trade panel', () => {
  it('shows the obligation, what is committed, the legs and the funding options', async () => {
    const trade = await openTrade(w, { baseUsdt: '1000', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId);
    await payoutLeg(trade.tradeId, '40000.00');

    const view = await deskTrade(w.app, trade.tradeId, FULL_ACCESS);
    expect(view).toMatchObject({
      ref: trade.tradeRef,
      direction: 'SELL_USDT',
      lifecycle: 'PARTIALLY_SETTLED',
      payout: { amount: '102000.00', currency: 'INR' },
      paid: '40000.00',
      committed: '40000.00',
      unallocated: '62000.00',
      clientRate: '102.000000',
      routeRate: '104.200000',
      expectedMargin: '2200.00',
    });
    expect(view.legs).toHaveLength(2);
    expect(view.legs[1]).toMatchObject({ side: 'EXCHANGE_TO_CLIENT', status: 'COMPLETED', payer: 'EXCHANGE_ACCOUNT', referenceKind: 'UTR' });
    expect(view.payoutOptions.asset).toBe('INR');
    expect(view.payoutOptions.accounts.some((a) => a.accountId === w.inrAccountId && Money.parse(a.availableToday, 'INR').isPositive())).toBe(true);
    expect(view.payoutOptions.routeDirectAvailable).toBe(false);
    expect(view.deposit?.address).toMatch(/^T/);
    expect(view.route?.routeDeliversRemaining.currency).toBe('INR');
  });

  it('offers the route as a payer only where the route pays the client directly (FI-65)', async () => {
    const direct = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'DIRECT_TO_CLIENT' });
    const view = await deskTrade(w.app, direct.tradeId, FULL_ACCESS);
    expect(view.payoutOptions.routeDirectAvailable).toBe(true);
    expect(view.payoutOptions.routeName).not.toBeNull();
    expect(view.executionMode).toBe('DIRECT_TO_CLIENT');
  });

  it('hides economics and the route side from an operator who may not see them', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    const view = await deskTrade(w.app, trade.tradeId, NO_ECONOMICS);
    for (const key of ['clientRate', 'routeRate', 'expectedMargin', 'executionMode', 'route']) expect(key in view).toBe(false);
    // What settlement needs is all still there.
    expect(view.payout.amount).toBe('10200.00');
    expect(view.payoutOptions.accounts.length).toBeGreaterThan(0);
  });

  it('carries the open cases so the panel can offer a resolution', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await runAs(w.app, openException(w.settlementOp.actor), w.settlementOp.ref, 'exception.open', {
      type: 'OPERATOR_MISTAKE' as const, subjectType: 'TRADE' as const, subjectId: trade.tradeId, tradeId: trade.tradeId,
      details: { note: 'wrong destination read out on the call' },
    });
    const view = await deskTrade(w.app, trade.tradeId, FULL_ACCESS);
    expect(view.cases.map((c) => c.type)).toContain('OPERATOR_MISTAKE');
    expect(view.hold).toBe(true);
  });
});

describe('orders and search', () => {
  it('finds a trade by its reference, by the client’s name and by the UTR that paid it', async () => {
    const trade = await openTrade(w, { baseUsdt: '500', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId);
    const leg = await payoutLeg(trade.tradeId, '51000.00');

    for (const term of [trade.tradeRef, trade.tradeRef.toLowerCase(), leg.utr, leg.utr.toLowerCase()]) {
      const found = await searchOrders(w.app, FULL_ACCESS, term);
      expect(found.map((o) => o.ref)).toContain(trade.tradeRef);
    }
    const byName = await searchOrders(w.app, FULL_ACCESS, (await clientBook(w.app))[0]!.name.slice(0, 4));
    expect(byName.length).toBeGreaterThan(0);
    // A term that matches nothing returns nothing rather than "something close".
    expect(await searchOrders(w.app, FULL_ACCESS, 'IX-999999-9999')).toEqual([]);
  });

  it('filters the orders list by state and never leaks the margin without economics:view', async () => {
    const open = await listOrders(w.app, FULL_ACCESS, { state: 'OPEN' });
    expect(open.every((o) => !['COMPLETED', 'CANCELLED'].includes(o.lifecycle))).toBe(true);
    const completed = await listOrders(w.app, FULL_ACCESS, { state: 'COMPLETED' });
    expect(completed.every((o) => o.lifecycle === 'COMPLETED')).toBe(true);
    expect(completed.some((o) => o.margin !== undefined)).toBe(true);
    const masked = await listOrders(w.app, NO_ECONOMICS, { state: 'COMPLETED' });
    expect(masked.every((o) => !('margin' in o) && !('clientRate' in o))).toBe(true);
  });
});

describe('route positions', () => {
  it('shows both sides of an obligation and what is left of each', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    const positions = await routePositions(w.app, { status: 'OPEN' });
    const mine = positions.find((p) => p.tradeId === trade.tradeId);
    expect(mine).toMatchObject({
      executionMode: 'TO_EXCHANGE',
      status: 'OPEN',
      routeDelivers: { amount: '10420.00', currency: 'INR' },
      routeDeliversRemaining: { amount: '10420.00', currency: 'INR' },
      exchangeDelivers: { amount: '100.000000', currency: 'USDT' },
    });
    expect(mine?.settlements).toEqual([]);
  });

  it('shows a direct route payout as a read-only settlement linked to its client leg', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'DIRECT_TO_CLIENT' });
    await settleFirstLeg(w, trade.tradeId);
    // The route pays the client directly: its own movement, no exchange money involved.
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
      tradeId: trade.tradeId, amount: '10200.00', payer: 'ROUTE' as const,
    });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', {
      legId: leg.legId, rail: 'IMPS' as const, utr: newUtr(),
    });
    await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });

    const mine = (await routePositions(w.app, { status: 'ALL' })).find((p) => p.tradeId === trade.tradeId);
    expect(mine?.settlements).toHaveLength(1);
    expect(mine?.settlements[0]).toMatchObject({ flow: 'DIRECT_TO_CLIENT', status: 'CONFIRMED', readOnly: true, side: 'ROUTE_DELIVERS' });
    expect(mine?.settlements[0]?.legRef).toBeTruthy();
    // ₹10,420,000 route side less the ₹10,200,000 paid directly leaves the residual the desk must still collect.
    expect(mine?.routeDeliversRemaining).toEqual({ amount: '220.00', currency: 'INR' });
  });
});

describe('the INR and USDT screens', () => {
  it('reports each account’s capacity for today and totals only the active ones', async () => {
    const view = await inrView(w.app);
    const account = view.accounts.find((a) => a.accountId === w.inrAccountId);
    expect(account).toMatchObject({ status: 'ACTIVE', dayOpened: true });
    expect(Money.parse(account!.capacityToday, 'INR').isPositive()).toBe(true);
    const sum = view.accounts
      .filter((a) => a.status === 'ACTIVE')
      .reduce((acc, a) => acc + Money.parse(a.capacityToday, 'INR').minor, 0n);
    expect(Money.parse(view.totals.capacity, 'INR').minor).toBe(sum);
  });

  it('reports the treasury, the deposit pool and the transfers the chain has produced', async () => {
    const view = await usdtView(w.app);
    expect(view.wallets.some((x) => x.role === 'HOT')).toBe(true);
    expect(view.pool.capability).toBeDefined();
    expect(view.transfers.length).toBeGreaterThan(0);
    expect(view.transfers.some((t) => t.state === 'CONFIRMED' && t.tradeRef !== null)).toBe(true);
  });
  it('keeps a legacy checksum-invalid wallet visible without crashing the USDT screen', async () => {
    const address = `T${'A'.repeat(33)}`;
    expect(isTronAddress(address)).toBe(false);
    // Represents a row inserted before checksum validation; its SQL address shape is still valid.
    const wallet = await w.t.owner.insertInto('treasury_wallet').values({
      network: 'TRON', address, label: 'Legacy checksum-invalid wallet', role: 'COLD',
      status: 'PAUSED', created_by: 'SYSTEM:legacy-fixture',
    }).returning('id').executeTakeFirstOrThrow();
    try {
      const view = await usdtView(w.app);
      expect(view.wallets.find((x) => x.walletId === wallet.id)).toMatchObject({ address, status: 'PAUSED' });
      expect(view.custody.find((x) => x.address === address)).toMatchObject({
        label: 'Legacy checksum-invalid wallet', reading: null, unusable: 'invalid TRON address',
        leaving: null, freeOnChain: '0.000000', tradesMoney: '0.000000', plannedOut: '0.000000',
        notSeenOnChain: null,
      });
      expect(view.custody.some((x) => isTronAddress(x.address))).toBe(true);
      expect(view.transfers.length).toBeGreaterThan(0);
    } finally {
      await w.t.owner.updateTable('treasury_wallet').set({ status: 'RETIRED' }).where('id', '=', wallet.id).execute();
    }
  });

});

describe('the client book', () => {
  it('counts open and completed trades and lists the destinations a quote may use', async () => {
    const book = await clientBook(w.app);
    const entry = book.find((c) => c.clientId === w.clientId);
    expect(entry?.completedTrades).toBeGreaterThan(0);

    const detail = await clientDetail(w.app, w.clientId, FULL_ACCESS);
    expect(detail.bankAccounts.some((b) => b.id === w.bankAccountId)).toBe(true);
    expect(detail.wallets.some((x) => x.id === w.walletId)).toBe(true);
    expect(detail.acceptors.length).toBeGreaterThan(0);
    expect(detail.recentTrades.length).toBeGreaterThan(0);
    expect(detail.recentTrades[0]!.clientRate).toBeDefined();

    const masked = await clientDetail(w.app, w.clientId, NO_ECONOMICS);
    expect(masked.recentTrades.every((t) => !('clientRate' in t))).toBe(true);
  });

  it('leaves a cancelled trade out of the queue and in the orders list', async () => {
    const trade = await openTrade(w, { baseUsdt: '10', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client stood down' });
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toBeUndefined();
    expect((await listOrders(w.app, FULL_ACCESS, { state: 'CANCELLED' })).some((o) => o.tradeId === trade.tradeId)).toBe(true);
  });
});

describe('the trade record', () => {
  it('reads a trade by its reference, with where it came from, where it pays and what happened, newest first', async () => {
    const trade = await openTrade(w, { baseUsdt: '1000', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId);
    await payoutLeg(trade.tradeId, '40000.00');

    expect(await tradeIdByRef(w.app, trade.tradeRef.toLowerCase())).toBe(trade.tradeId);
    expect(await tradeIdByRef(w.app, 'IX-000000-0000')).toBeNull();

    const record = await deskTradeRecord(w.app, trade.tradeId, FULL_ACCESS);
    expect(record.trade.ref).toBe(trade.tradeRef);
    expect(record.requestRef).toBeTruthy();
    expect(record.quoteRef).toBeTruthy();
    expect(record.destination).toMatchObject({ kind: 'BANK', active: true });
    expect(record.destination?.detail).toMatch(/••••\d{4}$/);
    const titles = record.timeline.map((e) => e.title);
    expect(titles).toContain('Payout confirmed');
    expect(titles).toContain('Client funds confirmed');
    // Newest first.
    const times = record.timeline.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
    // A leg says who created it, which is what the two-person rules key on.
    expect(record.trade.legs.every((l) => l.createdBy.length > 0 && l.createdByLabel.length > 0)).toBe(true);
  });

  it('lists a requested adjustment as waiting for a second person, and hides its route side without economics:view', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId, { amountUsdt: '99.5' });
    await runAs(w.app, requestAdjustment(w.settlementOp.actor), w.settlementOp.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'AMOUNT_CORRECTION' as const, deltaBaseUsdt: '-0.500000', deltaClientInr: '-51.00', reason: 'client sent less than agreed; accepted as is',
    });
    const approvals = await deskApprovals(w.app, FULL_ACCESS);
    const mine = approvals.adjustments.find((a) => a.tradeId === trade.tradeId);
    expect(mine).toMatchObject({ status: 'REQUESTED', type: 'AMOUNT_CORRECTION', deltaBase: '-0.500000', deltaClientInr: '-51.00' });
    expect(mine?.deltaMargin).toBeDefined();
    const masked = await deskApprovals(w.app, NO_ECONOMICS);
    const hidden = masked.adjustments.find((a) => a.tradeId === trade.tradeId)!;
    expect('deltaMargin' in hidden).toBe(false);
    expect('deltaRouteInr' in hidden).toBe(false);
    expect((await deskTradeRecord(w.app, trade.tradeId, FULL_ACCESS)).adjustments.map((a) => a.ref)).toContain(mine!.ref);
  });

  it('lists every open exception case, including the ones no trade owns, and finds one by its reference', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' });
    await runAs(w.app, openException(w.settlementOp.actor), w.settlementOp.ref, 'exception.open', {
      type: 'OPERATOR_MISTAKE' as const, subjectType: 'TRADE' as const, subjectId: trade.tradeId, tradeId: trade.tradeId, details: { note: 'reference typed on the wrong trade' },
    });
    const cases = await deskExceptions(w.app);
    const onTrade = cases.find((c) => c.trade?.id === trade.tradeId);
    expect(onTrade).toMatchObject({ type: 'OPERATOR_MISTAKE', status: 'OPEN', trade: { ref: trade.tradeRef } });
    // Blocking cases lead.
    const firstWarning = cases.findIndex((c) => c.severity === 'WARNING');
    if (firstWarning >= 0) expect(cases.slice(firstWarning).every((c) => c.severity === 'WARNING')).toBe(true);
    expect((await findByRef(w.app, onTrade!.ref.toLowerCase())).map((h) => h.kind)).toEqual(['EXCEPTION']);
    expect(await findByRef(w.app, 'EX-999999')).toEqual([]);
  });

  it('counts the orders tabs and reads the route-rate history with the rate each one replaced', async () => {
    const counts = await orderCounts(w.app);
    expect(counts.ALL).toBe(counts.OPEN + counts.COMPLETED + counts.CANCELLED);
    const history = await rateHistory(w.app, { limit: 10 });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.rate).toMatch(/^\d+\.\d{6}$/);
  });

  it('adds the latest client rate and margin to the book only with economics:view', async () => {
    const full = (await clientBook(w.app, { access: FULL_ACCESS })).find((c) => c.clientId === w.clientId)!;
    expect(full.marginGenerated).toBeDefined();
    const plain = (await clientBook(w.app, { access: NO_ECONOMICS })).find((c) => c.clientId === w.clientId)!;
    expect('marginGenerated' in plain).toBe(false);
    expect('lastRate' in plain).toBe(false);
    const detail = await clientDetail(w.app, w.clientId, FULL_ACCESS, { contacts: true });
    expect(detail.stats.completedTrades).toBeGreaterThan(0);
    expect(Array.isArray(detail.contacts)).toBe(true);
    expect('contacts' in (await clientDetail(w.app, w.clientId, FULL_ACCESS))).toBe(false);
  });
});

describe('a sent quote', () => {
  it('shows its terms, its link without the token, and its economics only with economics:view', async () => {
    await runAs(w.app, publishRouteRate(w.dealer.actor), w.dealer.ref, 'rates.publish_route', { routeId: w.routeId, direction: 'SELL_USDT' as const, rate: '104.200000' });
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: w.bankAccountId,
    });
    const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: w.routeId, clientRate: '102.000000', validitySeconds: 300 });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
    await runAs(w.app, createQuoteLink(w.dealer.actor, {}, () => {}), w.dealer.ref, 'quote_link.create', { quoteId: quote.quoteId });

    const view = await deskQuote(w.app, quote.quoteId, FULL_ACCESS);
    expect(view).toMatchObject({ status: 'SENT', base: '1000.000000', quoteInr: '102000.00', clientRate: '102.000000', margin: '2200.00', tradeRef: null });
    expect(view.link).toMatchObject({ openCount: 0, revoked: false });
    expect(JSON.stringify(view)).not.toMatch(/token/i);
    const masked = await deskQuote(w.app, quote.quoteId, NO_ECONOMICS);
    for (const key of ['routeName', 'routeRate', 'margin']) expect(key in masked).toBe(false);

    const row = (await deskQueue(w.app, FULL_ACCESS)).flatMap((g) => g.rows).find((r) => r.subject.id === quote.quoteId);
    expect(row).toMatchObject({ hasLink: true, payout: null });
    expect(row?.expiresAt).toBeTruthy();
    expect((await findByRef(w.app, view.ref)).map((h) => h.kind)).toEqual(['QUOTE']);
  });
});

describe('where a trade’s money is (D-16)', () => {
  it('shows each place and what may leave it, and the route-revealing figures only to route-positions viewers', async () => {
    const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000' });
    await settleFirstLeg(w, trade.tradeId);
    const before = await deskTrade(w.app, trade.tradeId, accessFor(w.settlementOp.actor));
    expect(before.funding.model).toBe('COUNTERPARTY_FUNDED');
    expect(before.funding.counterparty).toBe('NONE');
    expect(before.funding.places).toEqual([expect.objectContaining({ kind: 'CLIENT_FUNDS', asset: 'USDT', free: '100.000000' })]);
    expect(before.funding.places[0]!.depositAddressId).not.toBeNull();

    await deliverCounterparty(w, trade.tradeId); // ₹10,420 arrives at the payout account; the client is owed ₹10,200
    const seenBySettlement = await deskTrade(w.app, trade.tradeId, accessFor(w.settlementOp.actor));
    const counterparty = seenBySettlement.funding.places.find((p) => p.kind === 'COUNTERPARTY_FUNDS')!;
    expect(seenBySettlement.funding.counterparty).toBe('FULL');
    expect(counterparty).toMatchObject({ asset: 'INR', inrAccountId: w.inrAccountId, free: '10200.00' });
    // Field absence, not blanking: ₹10,420 over 100 USDT would be the route rate (SECURITY §5).
    expect('arrived' in counterparty).toBe(false);
    expect(JSON.stringify(seenBySettlement.funding)).not.toContain('10420');

    const seenByDealer = await deskTrade(w.app, trade.tradeId, accessFor(w.dealer.actor));
    expect(seenByDealer.funding.places.find((p) => p.kind === 'COUNTERPARTY_FUNDS')).toMatchObject({ arrived: '10420.00', planned: '0.00', spent: '0.00', free: '10420.00' });

    await payoutLeg(trade.tradeId, '10200.00');
    const paid = await deskTrade(w.app, trade.tradeId, accessFor(w.dealer.actor));
    expect(paid.funding.places.find((p) => p.kind === 'COUNTERPARTY_FUNDS')).toMatchObject({ spent: '10200.00', free: '220.00' });
  });
});

describe('where a trade pays (D1)', () => {
  it('shows the destination in force, the verified choices, and every change asked for', async () => {
    const { addBankAccount } = await import('@inrp2p/clients');
    const { approveDestinationChange, requestDestinationChange } = await import('@inrp2p/settlement');
    const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '102.000000', routeRate: '104.200000' });
    const before = await deskTrade(w.app, trade.tradeId, FULL_ACCESS);
    expect(before.destination?.id).toBe(w.bankAccountId);
    const fresh = await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', {
      clientId: w.clientId, holderName: 'Acme Pay Private Limited', bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK0000123', accountNumber: '880011223344', railPreferences: ['IMPS'] as const,
    });
    const options = (await deskTrade(w.app, trade.tradeId, FULL_ACCESS)).destinationOptions.payout;
    expect(options.map((o) => o.id)).toContain(fresh.bankAccountId);
    expect(options.map((o) => o.id)).not.toContain(w.bankAccountId);

    const asked = await runAs(w.app, requestDestinationChange(w.financeOp.actor), w.financeOp.ref, 'trade.request_destination_change', {
      tradeId: trade.tradeId, toBankAccountId: fresh.bankAccountId, reason: 'client prefers the Kotak account', evidence: 'confirmed by the client administrator on a call',
    });
    const pending = await deskTrade(w.app, trade.tradeId, FULL_ACCESS);
    expect(pending.destinationChanges[0]).toMatchObject({ ref: asked.ref, status: 'REQUESTED', toLabel: 'Kotak Mahindra Bank ••••3344' });
    expect(pending.destination?.id).toBe(w.bankAccountId);

    await runAs(w.app, approveDestinationChange(w.financeOp2.actor), w.financeOp2.ref, 'trade.approve_destination_change', { requestId: asked.requestId });
    const after = await deskTrade(w.app, trade.tradeId, FULL_ACCESS);
    expect(after.destination).toMatchObject({ id: fresh.bankAccountId, label: 'Kotak Mahindra Bank ••••3344' });
    expect(after.destinationChanges[0]).toMatchObject({ status: 'APPROVED' });
  });
});

