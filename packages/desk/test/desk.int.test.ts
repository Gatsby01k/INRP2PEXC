import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, isTronAddress } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { createQuote, createQuoteLink, createRequest, sendQuote } from '@inrp2p/quotes';
import { cancelTrade, openException, requestAdjustment } from '@inrp2p/settlement';
import { acceptOrder, assignRequest, orderDeliveryAddress } from '@inrp2p/traders';
import {
  FULL_ACCESS, NO_ECONOMICS, accessFor, clientBook, clientDetail, clientFirstPlaces, clientSignIns, deskApprovals, deskExceptions, deskQueue, deskStrip, deskTrade, deskTradeRecord,
  deskQuote, findByRef, listOrders, orderCounts, searchOrders, tradeIdByRef, usdtView,
} from '../src/index.ts';
import { settleFirstLeg } from '../../settlement/test/world.ts';
import { confirmOnChain, sendUsdt } from '../../../test/integration/traders-world.ts';
import { type RailsWorld, completeDeal, createRailsWorld, railsTrade, railsTrader } from '../../../test/integration/rails-world.ts';

let w: RailsWorld;
let trader: Awaited<ReturnType<typeof railsTrader>>;

beforeAll(async () => {
  w = await createRailsWorld('desk_views');
  trader = await railsTrader(w, 'Konkan Desk', {
    buy: { capacity: '500000000', rate: '103.00', min: '100', max: '500000000' },
    sell: { capacity: '5000000', rate: '105.00', min: '1', max: '5000000' },
  });
});
afterAll(async () => w.close());

const openTrade = (opts: { direction?: 'SELL_USDT' | 'BUY_USDT'; baseUsdt: string; clientRate?: string }) => {
  const direction = opts.direction ?? 'SELL_USDT';
  const clientRate = opts.clientRate ?? (direction === 'SELL_USDT' ? '102.000000' : '106.000000');
  return railsTrade(w, trader, { direction, amount: opts.baseUsdt, clientRate, plannedClientRate: clientRate });
};
const groupOf = (groups: Awaited<ReturnType<typeof deskQueue>>, key: string) => groups.find((g) => g.key === key);
const rowFor = (groups: Awaited<ReturnType<typeof deskQueue>>, tradeId: string) =>
  groups.flatMap((g) => g.rows.map((r) => ({ group: g.key, row: r }))).find((x) => x.row.subject.id === tradeId);

describe('the operational strip', () => {
  it('reports the trades in flight and what the day earned', async () => {
    const strip = await deskStrip(w.app, FULL_ACCESS);
    expect(strip.istDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(strip.realizedMarginTodayUsdt).toBeDefined();
    expect(strip.openTrades).toBeGreaterThanOrEqual(0);
  });

  it('omits what the day earned entirely for an operator without pnl:view', async () => {
    const strip = await deskStrip(w.app, NO_ECONOMICS);
    // Field absence, not blanking: there is nothing in the payload to leak (SECURITY §5).
    expect('realizedMarginTodayUsdt' in strip).toBe(false);
    expect(strip.openTrades).toBeGreaterThanOrEqual(0);
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

  it('follows a deal as its money moves, and asks nothing of the desk while it does', async () => {
    const trade = await openTrade({ baseUsdt: '1000' });
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toMatchObject({ group: 'waiting_client', row: { status: 'Awaiting USDT into escrow', action: 'NONE' } });
    await settleFirstLeg(w, trade.tradeId);
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toMatchObject({ group: 'processing', row: { status: 'Trader pays the client', action: 'NONE' } });
  });

  it('leaves a completed deal out of the queue', async () => {
    const trade = await openTrade({ baseUsdt: '100' });
    await completeDeal(w, trader, trade);
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toBeUndefined();
  });

  it('says what an exception actually is, in the desk’s own words', async () => {
    const trade = await openTrade({ baseUsdt: '100' });
    await settleFirstLeg(w, trade.tradeId, { amountUsdt: '99.95' });
    const placed = rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId);
    expect(placed?.group).toBe('exception');
    expect(placed?.row.status).toBe('Short by 0.05 USDT');
    expect(placed?.row.action).toBe('RESOLVE_EXCEPTION');
    expect(placed?.row.hold).toBe(true);
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
  it('shows the obligation, what was agreed, what it earns in USDT and the legs', async () => {
    const trade = await openTrade({ baseUsdt: '1000' });
    await settleFirstLeg(w, trade.tradeId);
    const view = await deskTrade(w.app, trade.tradeId, FULL_ACCESS);
    expect(view).toMatchObject({
      ref: trade.tradeRef,
      direction: 'SELL_USDT',
      lifecycle: 'FIRST_LEG_CONFIRMED',
      payout: { amount: '102000.00', currency: 'INR' },
      paid: '0.00',
      clientRate: '102.000000',
      routeRate: '103.000000',
      expectedMargin: '0.00',
    });
    // ₹102,000 buys the trader 990.291262 USDT at its 103: the 9.708738 between is INRP2P's, less the network it carries.
    expect(Money.parse(view.expectedMarginUsdt!, 'USDT').isPositive()).toBe(true);
    expect(view.legs).toHaveLength(1);
    expect(view.legs[0]).toMatchObject({ side: 'CLIENT_TO_EXCHANGE', status: 'COMPLETED', asset: 'USDT', referenceKind: 'TX' });
    expect(view.payoutOptions.asset).toBe('INR');
    expect(view.payoutOptions.routeName).not.toBeNull();
    expect(view.deposit?.address).toMatch(/^T/);
    expect(view.route?.routeDeliversRemaining.currency).toBe('INR');
  });

  it('hides economics and the route side from an operator who may not see them', async () => {
    const trade = await openTrade({ baseUsdt: '100' });
    const view = await deskTrade(w.app, trade.tradeId, NO_ECONOMICS);
    for (const key of ['clientRate', 'routeRate', 'expectedMargin', 'expectedMarginUsdt', 'route']) expect(key in view).toBe(false);
    // What settlement needs is all still there.
    expect(view.payout.amount).toBe('10200.00');
  });

  it('carries the open cases so the panel can offer a resolution', async () => {
    const trade = await openTrade({ baseUsdt: '100' });
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
    const trade = await openTrade({ baseUsdt: '500' });
    const { utr } = await completeDeal(w, trader, trade);
    for (const term of [trade.tradeRef, trade.tradeRef.toLowerCase(), utr]) {
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

describe('the USDT screen', () => {
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

  it('reads newest first when asked, and when each client joined', async () => {
    const newest = await clientBook(w.app, { sort: 'NEWEST' });
    const joined = newest.map((c) => Date.parse(c.joinedAt));
    expect(joined.every((t) => Number.isFinite(t))).toBe(true);
    expect(joined).toEqual([...joined].sort((a, b) => b - a));
    const byName = (await clientBook(w.app)).map((c) => c.name);
    expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b)));
    expect((await clientDetail(w.app, w.clientId, FULL_ACCESS)).joinedAt).toBe(newest.find((c) => c.clientId === w.clientId)!.joinedAt);
  });

  it("lists a client's latest sign-ins with the address and device each came from, and nothing a sign-in did not make", async () => {
    const at = new Date();
    const session = await w.t.owner
      .insertInto('auth_session')
      .values({
        expires_at: new Date(at.getTime() + 3_600_000), token: randomUUID(), created_at: at, updated_at: at, user_id: w.acceptor.userId, surface: 'CLIENT',
        ip_address: '103.21.58.14', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Safari/604.1', sign_in_method: 'EMAIL',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    // Before 0052 recorded anything for this client, its live sessions stand in: address and device, no place.
    const before = await clientSignIns(w.app, w.clientId);
    expect(before.first).toBeNull();
    expect(before.latest[0]).toMatchObject({ ip: '103.21.58.14', method: 'EMAIL', live: true, place: null });
    expect(before.latest[0]!.who).toMatch(/^.•••@/);
    expect(before.latest[0]!.who).not.toContain(w.acceptor.email.split('@')[0]!.slice(1));
    // The world's own sessions were made by the product, not by a sign-in request: no address, no device, not listed.
    expect(before.latest.every((x) => x.ip !== null || x.userAgent !== null)).toBe(true);

    // 0052: sign-ins are recorded with where the edge placed them, and outlive their sessions.
    await w.t.owner
      .insertInto('sign_in')
      .values({ user_id: w.acceptor.userId, session_id: randomUUID(), surface: 'CLIENT', method: 'EMAIL', ip: '49.36.112.201', country: 'IN', region: 'KA', city: 'Bengaluru', user_agent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0', at: new Date(at.getTime() - 86_400_000) })
      .execute();
    await w.t.owner
      .insertInto('sign_in')
      .values({ user_id: w.acceptor.userId, session_id: session.id, surface: 'CLIENT', method: 'EMAIL', ip: '103.21.58.14', country: 'IN', region: 'MH', city: 'Mumbai', user_agent: 'Mozilla/5.0 (iPhone) Safari/604.1', at })
      .execute();
    const after = await clientSignIns(w.app, w.clientId);
    expect(after.latest.map((x) => x.place?.city)).toEqual(['Mumbai', 'Bengaluru']);
    expect(after.latest[0]).toMatchObject({ ip: '103.21.58.14', live: true, place: { country: 'IN', region: 'MH', city: 'Mumbai' } });
    expect(after.latest[1]).toMatchObject({ ip: '49.36.112.201', live: false });
    expect(after.first).toMatchObject({ ip: '49.36.112.201', place: { city: 'Bengaluru' } });
    expect((await clientBook(w.app)).find((c) => c.clientId === w.clientId)!.firstPlace).toEqual({ country: 'IN', region: 'KA', city: 'Bengaluru' });
    // A list of many — the traders' — reads every first place at once; a client with nothing recorded is left out.
    const places = await clientFirstPlaces(w.app, [w.clientId, randomUUID()]);
    expect(places).toEqual({ [w.clientId]: { country: 'IN', region: 'KA', city: 'Bengaluru' } });
    expect(await clientFirstPlaces(w.app, [])).toEqual({});
    // A record is not edited.
    await expect(w.t.owner.updateTable('sign_in').set({ city: 'Elsewhere' }).where('user_id', '=', w.acceptor.userId).execute()).rejects.toThrow();
  });

  it('leaves a cancelled trade out of the queue and in the orders list', async () => {
    const trade = await openTrade({ baseUsdt: '10' });
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client stood down' });
    expect(rowFor(await deskQueue(w.app, FULL_ACCESS), trade.tradeId)).toBeUndefined();
    expect((await listOrders(w.app, FULL_ACCESS, { state: 'CANCELLED' })).some((o) => o.tradeId === trade.tradeId)).toBe(true);
  });
});

describe('the trade record', () => {
  it('reads a trade by its reference, with where it came from, where it pays and what happened, newest first', async () => {
    const trade = await openTrade({ baseUsdt: '1000' });
    await completeDeal(w, trader, trade);

    expect(await tradeIdByRef(w.app, trade.tradeRef.toLowerCase())).toBe(trade.tradeId);
    expect(await tradeIdByRef(w.app, 'IX-000000-0000')).toBeNull();

    const record = await deskTradeRecord(w.app, trade.tradeId, FULL_ACCESS);
    expect(record.trade.ref).toBe(trade.tradeRef);
    expect(record.requestRef).toBeTruthy();
    expect(record.quoteRef).toBeTruthy();
    expect(record.destination).toMatchObject({ kind: 'BANK', active: true });
    expect(record.destination?.detail).toMatch(/••••\d{4}$/);
    const titles = record.timeline.map((e) => e.title);
    expect(titles).toContain('The client confirmed the rupees');
    expect(titles).toContain('Client funds confirmed');
    // Newest first.
    const times = record.timeline.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
    // A leg says who created it, which is what the two-person rules key on.
    expect(record.trade.legs.every((l) => l.createdBy.length > 0 && l.createdByLabel.length > 0)).toBe(true);
  });

  it('lists a requested adjustment as waiting for a second person, and hides its route side without economics:view', async () => {
    const trade = await openTrade({ baseUsdt: '100' });
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
    const trade = await openTrade({ baseUsdt: '100' });
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

  it('counts the orders tabs', async () => {
    const counts = await orderCounts(w.app);
    expect(counts.ALL).toBe(counts.OPEN + counts.COMPLETED + counts.CANCELLED);
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
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: w.bankAccountId,
    });
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '102.000000' });
    await runAs(w.app, acceptOrder(trader.admin.actor), trader.admin.ref, 'trader_order.accept', { ref: assigned.ref });
    const order = await w.app.selectFrom('trader_order').select('route_id').where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
    const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: '102.000000', validitySeconds: 300 });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
    await runAs(w.app, createQuoteLink(w.dealer.actor, {}, () => {}), w.dealer.ref, 'quote_link.create', { quoteId: quote.quoteId });

    const view = await deskQuote(w.app, quote.quoteId, FULL_ACCESS);
    expect(view).toMatchObject({ status: 'SENT', base: '1000.000000', quoteInr: '102000.00', clientRate: '102.000000', margin: '0.00', tradeRef: null });
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
    const sale = await openTrade({ baseUsdt: '100' });
    await settleFirstLeg(w, sale.tradeId);
    const before = await deskTrade(w.app, sale.tradeId, accessFor(w.settlementOp.actor));
    expect(before.funding.model).toBe('COUNTERPARTY_FUNDED');
    expect(before.funding.counterparty).toBe('NONE');
    expect(before.funding.places).toEqual([expect.objectContaining({ kind: 'CLIENT_FUNDS', asset: 'USDT', free: '100.000000' })]);
    expect(before.funding.places[0]!.depositAddressId).not.toBeNull();

    // A purchase: the trader's USDT in the escrow; the client is owed 100, the trader delivered more.
    const purchase = await openTrade({ direction: 'BUY_USDT', baseUsdt: '100' });
    const { address, amount } = await runAs(w.app, orderDeliveryAddress(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.delivery_address', { ref: purchase.orderRef });
    await sendUsdt(w, trader.walletAddress, address, amount);
    await confirmOnChain(w);
    const seenBySettlement = await deskTrade(w.app, purchase.tradeId, accessFor(w.settlementOp.actor));
    const counterparty = seenBySettlement.funding.places.find((p) => p.kind === 'COUNTERPARTY_FUNDS')!;
    expect(seenBySettlement.funding.counterparty).toBe('FULL');
    expect(counterparty).toMatchObject({ asset: 'USDT', free: '100.000000' });
    // Field absence, not blanking: what the trader delivered over 100 USDT would give its rate away (SECURITY §5).
    expect('arrived' in counterparty).toBe(false);
    expect(JSON.stringify(seenBySettlement.funding)).not.toContain(amount);

    const seenByDealer = await deskTrade(w.app, purchase.tradeId, accessFor(w.dealer.actor));
    expect(seenByDealer.funding.places.find((p) => p.kind === 'COUNTERPARTY_FUNDS')).toMatchObject({ arrived: amount, free: amount });
  });
});

describe('where a trade pays (D1)', () => {
  it('shows the destination in force, the verified choices, and every change asked for', async () => {
    const { addBankAccount } = await import('@inrp2p/clients');
    const { approveDestinationChange, requestDestinationChange } = await import('@inrp2p/settlement');
    const trade = await openTrade({ baseUsdt: '10' });
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
