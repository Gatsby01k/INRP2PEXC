import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { createRequest } from '@inrp2p/quotes';
import { cancelTrade, confirmFirstLeg, confirmPayout, createPayoutLeg, openException, recordIncomingFiat, recordLegEvidence, sendPayoutLeg } from '@inrp2p/settlement';
import {
  FULL_ACCESS, NO_ECONOMICS, accessFor, clientBook, clientDetail, deskQueue, deskStrip, deskTrade,
  inrView, listOrders, routePositions, searchOrders, usdtView,
} from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from '../../settlement/test/world.ts';

let w: World;
beforeAll(async () => { w = await createWorld('desk_views', { capacityInr: '500000000.00' }); });
afterAll(async () => w.close());

const groupOf = (groups: Awaited<ReturnType<typeof deskQueue>>, key: string) => groups.find((g) => g.key === key);
const rowFor = (groups: Awaited<ReturnType<typeof deskQueue>>, tradeId: string) =>
  groups.flatMap((g) => g.rows.map((r) => ({ group: g.key, row: r }))).find((x) => x.row.subject.id === tradeId);

async function payoutLeg(tradeId: string, amount: string, opts: { confirm?: boolean } = {}) {
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
