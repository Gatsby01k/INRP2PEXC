import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, Rate, computeP2pEconomics } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { currentPricingPolicy, marketTrail, publicMarketRates, setPricingPolicy } from '@inrp2p/pricing';
import { acceptQuote, expireQuote, repriceRequest, requestInstantQuote, runMarketReferenceRefresh, runRfqSweep } from '@inrp2p/quotes';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { bidOnRfq, priceAsksFor, updateBlock } from '@inrp2p/traders';
import { exchangeView } from '../../packages/portal/src/index.ts';
import { traderClient } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsTrader } from './rails-world.ts';

/**
 * Automatic prices of the INRP2P exchange (ADR 0025, 0028), on the exchange's own rails and GasFree: a client asks and gets
 * a firm 60-second price at once, from the traders' firm offers — their own numbers, or rates set against the market —
 * bounded by the market and the minimum net margin, the deal's network as the client's own line; accepting it opens the
 * deal with the chosen trader exactly as a person's quote would. What no firm offer prices goes to several traders as a
 * price request; anything that still cannot be priced honestly closes with a plain answer — nothing waits for a person.
 */
let w: RailsWorld;
let a: Awaited<ReturnType<typeof railsTrader>>;
let b: Awaited<ReturnType<typeof railsTrader>>;
let c: Awaited<ReturnType<typeof railsTrader>>;

const r = (d: string) => Rate.parse(d, 'ROUTE').micro;
const usdt = (d: string) => Money.parse(d, 'USDT').minor;
/** GasFree's activation and two transfers in this world (ADR 0022): what the client pays as its own line (ADR 0028). */
const NETWORK = Money.parse('4.5', 'USDT');
const inr = (d: string) => Money.parse(d, 'INR').minor;
const dbCode = (p: Promise<unknown>) => p.then(() => null, (e) => pgErrorCode(e) ?? e?.code ?? e);

type Person = { actor: Parameters<typeof requestInstantQuote>[0]; ref: Parameters<typeof runAs>[2] };
const ask = (direction: 'SELL_USDT' | 'BUY_USDT', amount: string, who: Person & { walletId?: string; bankAccountId?: string } = { ...w.acceptor, walletId: w.walletId, bankAccountId: w.bankAccountId }, db = w.app) =>
  runAs(db, requestInstantQuote(who.actor, w.railsDeps), who.ref, 'request.instant_quote', {
    direction, fixedSide: 'BASE' as const, amount, ...(direction === 'SELL_USDT' ? { bankAccountId: who.bankAccountId ?? null } : { walletId: who.walletId ?? null }),
  });
const accept = (quoteId: string) => runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId });
const policy = async (change: Record<string, unknown>) =>
  runAs(w.app, setPricingPolicy(w.owner.actor), w.owner.ref, 'pricing.set_policy', { expectedPolicyId: (await currentPricingPolicy(w.app)).id, reason: 'automatic prices in this test', ...change });
const books = (bid: string, ask: string) => runMarketReferenceRefresh(w.app, async () => ({ bidMicro: r(bid), askMicro: r(ask), source: 'market: test books' }));
const quoteOf = (id: string) => w.app.selectFrom('quote').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const decisionOf = (quoteId: string) => w.app.selectFrom('auto_quote').selectAll().where('quote_id', '=', quoteId).executeTakeFirstOrThrow();
const orderOfQuote = async (quoteId: string) => w.app.selectFrom('trader_order').selectAll().where('id', '=', (await decisionOf(quoteId)).trader_order_id).executeTakeFirstOrThrow();
const requestOf = (id: string) => w.app.selectFrom('trade_request').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const blockOf = (traderId: string, side: 'BUY_USDT' | 'SELL_USDT') => w.app.selectFrom('trader_block').selectAll().where('trader_id', '=', traderId).where('side', '=', side).executeTakeFirstOrThrow();
const traderOfOrder = (o: { trader_id: string }) => o.trader_id;

async function firm(t: typeof a, side: 'BUY_USDT' | 'SELL_USDT', change: Record<string, unknown> = {}) {
  const block = await blockOf(t.traderId, side);
  return runAs(w.app, updateBlock(t.admin.actor), t.admin.ref, 'trader.update_block', { side, expectedVersion: block.version, firmHours: 24, ...change });
}

function quoted<T extends { outcome: { kind: string } }>(out: T): Extract<T['outcome'], { kind: 'QUOTED' }> {
  if (out.outcome.kind !== 'QUOTED') throw new Error(`expected a firm price, got ${JSON.stringify(out.outcome)}`);
  return out.outcome as Extract<T['outcome'], { kind: 'QUOTED' }>;
}

beforeAll(async () => {
  w = await createRailsWorld('auto-pricing', { resourceMode: 'GASFREE' });
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, reason: 'no INR account: P2P escrow' });
  a = await railsTrader(w, 'Alpha', { buy: { capacity: '50000000', rate: '101.80', min: '100', max: '2000000' }, sell: { capacity: '500000', rate: '101.20', min: '10', max: '20000' } }, '0');
  b = await railsTrader(w, 'Bravo', { buy: { capacity: '50000000', rate: '101.60', min: '100', max: '2000000' }, sell: { capacity: '500000', rate: '101.50', min: '10', max: '20000' } }, '0');
  // Charlie's rates are better still, but it accepts each order itself: it is never priced on without asking.
  c = await railsTrader(w, 'Charlie', { buy: { capacity: '50000000', rate: '102.50', min: '100', max: '2000000' }, sell: { capacity: '500000', rate: '100.90', min: '10', max: '20000' } }, '0');
  for (const t of [a, b]) for (const side of ['BUY_USDT', 'SELL_USDT'] as const) await firm(t, side);
});
afterAll(async () => w.close());

describe('automatic prices are a person’s decision', () => {
  it('stay off until switched on: the request waits for the desk as before', async () => {
    const out = await ask('BUY_USDT', '100');
    expect(out.outcome).toEqual({ kind: 'MANUAL', reason: 'OFF' });
    expect((await requestOf(out.requestId)).status).toBe('OPEN');
    expect(await w.app.selectFrom('trader_order').select('id').where('trade_request_id', '=', out.requestId).execute()).toEqual([]);
  });

  it('cannot be switched on blind — not without a fresh market reference for both directions', async () => {
    // The public site's converter has nothing to estimate with either.
    expect(await publicMarketRates(w.app)).toEqual({ SELL_USDT: null, BUY_USDT: null });
    await expect(policy({ autoQuote: true })).rejects.toMatchObject({ code: 'MARKET_REFERENCE_STALE' });
    const read = await books('101.00', '102.00');
    expect(read.recorded.sort()).toEqual(['BUY_USDT', 'SELL_USDT']);
    await policy({ autoQuote: true });
    expect((await currentPricingPolicy(w.app)).autoQuote).toBe(true);
  });

  it('gives the public site the market’s rate of each direction while it is fresh, and nothing once it is not', async () => {
    expect(await publicMarketRates(w.app)).toEqual({ SELL_USDT: '101.000000', BUY_USDT: '102.000000' });
    // The workspace's ticker draws the day from the same history: the mid of both directions, hour by hour.
    expect(await marketTrail(w.app)).toEqual(['101.500000']);
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + ((await currentPricingPolicy(w.app)).referenceMaxAgeSeconds + 60) * 1000));
    expect(await publicMarketRates(clock.db)).toEqual({ SELL_USDT: null, BUY_USDT: null });
    await clock.set(null);
  });
});

describe('a client buying USDT', () => {
  let quoteId: string;

  it('gets a firm 60-second price at once: at the market, from the firm offer that leaves the most', async () => {
    const out = await ask('BUY_USDT', '1000');
    const q = quoted(out);
    quoteId = q.quoteId;
    const quote = await quoteOf(q.quoteId);
    const decision = await decisionOf(q.quoteId);
    const order = await orderOfQuote(q.quoteId);
    // The market's ask is ₹102; Alpha sells at ₹101.20, Bravo at ₹101.50; Charlie's ₹100.90 is not firm.
    // The client receives its 1,000 USDT and pays for them and the deal's network at the market's ask: 1,004.5 × ₹102.
    expect(quote).toMatchObject({
      status: 'SENT', client_rate_micro: r('102'), route_rate_micro: r('101.2'), valid_for_seconds: 60, base_minor: usdt('1000'), quote_inr_minor: inr('102459'),
      network_fee_base_minor: NETWORK.minor, client_network_base_minor: NETWORK.minor,
    });
    expect(quote.expires_at!.getTime() - quote.sent_at!.getTime()).toBe(60_000);
    expect(traderOfOrder(order)).toBe(a.traderId);
    expect(order).toMatchObject({ status: 'ACCEPTED', accepted_by: a.admin.userId, rate_micro: r('101.2'), planned_client_rate_micro: r('102'), rate_reference_snapshot_id: null });
    expect(order.hold_until!.getTime()).toBe(quote.expires_at!.getTime() + 60_000);
    // The trader's USDT is the client's rupees at its own rate; INRP2P keeps the rest, less the deal's network the client paid.
    const k = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: Money.ofMinor(usdt('1000'), 'USDT'), clientRate: Rate.ofMicro(r('102'), 'CLIENT'), routeRate: Rate.ofMicro(r('101.2'), 'ROUTE') }, { clientNetwork: NETWORK });
    expect(quote.route_base_minor).toBe(k.routeBase.minor);
    expect(quote.gross_margin_base_minor).toBe(k.grossMarginBase.minor);
    const terms = await w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', q.quoteId).executeTakeFirstOrThrow();
    expect(terms).toMatchObject({ unit: 'USDT', funder_trader_id: null, fee_usdt_minor: usdt('4.5') });
    expect(terms.net_margin_usdt_minor).toBe(k.grossMarginBase.minor - usdt('4.5'));
    expect(decision).toMatchObject({ source: 'INSTANT', position_bps: 0, cap_rate_micro: r('102'), offers: 2, net_margin_usdt_minor: terms.net_margin_usdt_minor, reference_rate_micro: r('102') });
    expect(decision.net_margin_usdt_minor).toBeGreaterThanOrEqual(decision.min_net_margin_usdt_minor);
    expect((await blockOf(a.traderId, 'SELL_USDT')).reserved_minor).toBe(order.capacity_minor);
    expect((await requestOf(out.requestId)).status).toBe('QUOTED');
  });

  it('shows the client its price, the network as its own line, and nothing of who fills it', async () => {
    const view = await exchangeView(w.app, w.clientId);
    expect(view.quote).toMatchObject({ status: 'SENT', networkFee: { amount: '4.500000', currency: 'USDT' }, networkFeeIncluded: null });
    expect(JSON.stringify(view).match(/Alpha|101\.200000|"trader|traderId|traderRef|route/i)?.[0] ?? null).toBeNull();
  });

  it('accepting it opens the deal with the chosen trader, on exactly the terms priced', async () => {
    const accepted = await accept(quoteId);
    const order = await orderOfQuote(quoteId);
    expect(order).toMatchObject({ status: 'IN_PROGRESS', trade_id: accepted.tradeId });
    const econ = await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
    const quote = await quoteOf(quoteId);
    expect(econ).toMatchObject({
      route_execution_mode: 'P2P', client_rate_micro: quote.client_rate_micro, route_base_minor: quote.route_base_minor, gross_margin_base_minor: quote.gross_margin_base_minor,
      client_network_base_minor: NETWORK.minor,
    });
  });
});

describe('a client selling USDT', () => {
  it('is paid at least the market, by the firm offer paying the most', async () => {
    const q = quoted(await ask('SELL_USDT', '1000'));
    const quote = await quoteOf(q.quoteId);
    // It sends 1,000 USDT and is paid for them less the deal's network at the market's bid: 995.5 × ₹101.
    expect(quote).toMatchObject({ client_rate_micro: r('101'), route_rate_micro: r('101.8'), base_minor: usdt('1000'), quote_inr_minor: inr('100545.50'), client_network_base_minor: NETWORK.minor });
    const order = await orderOfQuote(q.quoteId);
    expect(traderOfOrder(order)).toBe(a.traderId);
    // A trader buying USDT holds the rupees it pays the client.
    expect(order.capacity_minor).toBe(inr('100545.50'));
    expect(quote.base_minor - quote.route_base_minor!).toBe(quote.gross_margin_base_minor);
  });
});

describe('holding liquidity', () => {
  it('asking again replaces the earlier price and gives its capacity back', async () => {
    const first = quoted(await ask('BUY_USDT', '2500'));
    const reservedAfterFirst = (await blockOf(a.traderId, 'SELL_USDT')).reserved_minor;
    const firstOrder = await orderOfQuote(first.quoteId);
    const second = quoted(await ask('BUY_USDT', '3000'));
    expect(await quoteOf(first.quoteId)).toMatchObject({ status: 'CANCELLED', cancel_reason: 'SUPERSEDED' });
    expect((await orderOfQuote(first.quoteId)).status).toBe('RELEASED');
    const secondOrder = await orderOfQuote(second.quoteId);
    expect((await blockOf(a.traderId, 'SELL_USDT')).reserved_minor).toBe(reservedAfterFirst - firstOrder.capacity_minor + secondOrder.capacity_minor);
  });

  it('a price that ran out is asked for again in one tap; the old hold goes', async () => {
    const out = quoted(await ask('BUY_USDT', '2000'));
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 61_000));
    expect(await expireQuote(clock.db, out.quoteId)).toBe(true);
    expect((await quoteOf(out.quoteId)).status).toBe('EXPIRED');
    const request = (await w.app.selectFrom('quote').select('trade_request_id').where('id', '=', out.quoteId).executeTakeFirstOrThrow()).trade_request_id;
    expect((await requestOf(request)).status).toBe('OPEN');
    const view = await exchangeView(w.app, w.clientId);
    expect(view.request).toMatchObject({ canReprice: true, gatheringUntil: null });
    const before = (await blockOf(a.traderId, 'SELL_USDT')).reserved_minor;
    const again = await runAs(w.app, repriceRequest(w.acceptor.actor), w.acceptor.ref, 'request.reprice', { requestId: request });
    expect(again.kind).toBe('QUOTED');
    expect((await orderOfQuote(out.quoteId)).status).toBe('RELEASED');
    // The old order's capacity went back before the new one was held: one hold, never two.
    expect((await blockOf(a.traderId, 'SELL_USDT')).reserved_minor).toBe(before);
  });

  it('two clients at once never hold one trader’s capacity twice', async () => {
    const block = await blockOf(a.traderId, 'SELL_USDT');
    // Alpha has room for one 1,000-USDT deal beyond what it holds; Bravo for plenty.
    await runAs(w.app, updateBlock(a.admin.actor), a.admin.ref, 'trader.update_block', { side: 'SELL_USDT' as const, expectedVersion: block.version, capacity: Money.ofMinor(block.reserved_minor + usdt('1500'), 'USDT').toDecimalString() });
    // Two clients with nothing open: neither gives back capacity of its own while it asks.
    const [one, two] = [await traderClient(w, 'First Buyer'), await traderClient(w, 'Second Buyer')];
    const [x, y] = await Promise.all([ask('BUY_USDT', '1000', { ...one.admin, walletId: one.walletId }), ask('BUY_USDT', '1000', { ...two.admin, walletId: two.walletId })]);
    const ox = await orderOfQuote(quoted(x).quoteId);
    const oy = await orderOfQuote(quoted(y).quoteId);
    expect(new Set([traderOfOrder(ox), traderOfOrder(oy)])).toEqual(new Set([a.traderId, b.traderId]));
    const after = await blockOf(a.traderId, 'SELL_USDT');
    expect(after.reserved_minor).toBeLessThanOrEqual(after.capacity_minor);
    await firm(a, 'SELL_USDT', { capacity: '500000' });
  });
});

describe('a trader’s own reserve (ADR 0024)', () => {
  it('never lets a trader into a deal its reserve does not cover: priced within it, no price past it', async () => {
    const setRisk = async (riskPolicy: unknown) => {
      const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
      await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, riskPolicy: riskPolicy as null, reason: 'reserve-based limits' });
    };
    const wide = { minDeals: 0, minDays: 0, dealX: 2, openX: 100 };
    try {
      // 500 USDT of reserve at the first level: one deal of at most 1,000 USDT of the trader's own.
      await setRisk({ cleanDays: 30, tiers: [wide, { ...wide, minDeals: 10 }, { ...wide, minDeals: 50 }] });
      const within = quoted(await ask('BUY_USDT', '900'));
      expect((await quoteOf(within.quoteId)).route_base_minor!).toBeLessThanOrEqual(usdt('1000'));
      // Past it, the client is told what it can have instead, and nothing waits for a person.
      const past = await ask('BUY_USDT', '1500');
      expect(past.outcome).toMatchObject({ kind: 'NO_PRICE', reason: 'NO_OFFER' });
      expect((past.outcome as { message: string }).message).toMatch(/available for about \d+ to \d+ USDT/);
      expect(await requestOf(past.requestId)).toMatchObject({ status: 'DECLINED', no_price_reason: 'NO_OFFER' });
    } finally {
      await setRisk(null);
    }
  });
});

describe('what is never priced automatically', () => {
  it('nothing competitive: when no firm offer beats the market, the client is told so and nothing waits for a person', async () => {
    await books('101.00', '100.50');
    const out = await ask('BUY_USDT', '1000');
    expect(out.outcome).toMatchObject({ kind: 'NO_PRICE', reason: 'NOT_COMPETITIVE' });
    expect(await requestOf(out.requestId)).toMatchObject({ status: 'DECLINED', no_price_reason: 'NOT_COMPETITIVE' });
    expect((await exchangeView(w.app, w.clientId)).request).toMatchObject({ status: 'DECLINED', noPrice: true });
    const skipped = await w.app.selectFrom('audit_event').select('after').where('action', '=', 'quote.auto_price_skipped').where('entity_id', '=', out.requestId).executeTakeFirstOrThrow();
    expect(JSON.stringify(skipped.after)).toContain('NOT_COMPETITIVE');
    await books('101.00', '102.00');
  });
});

describe('a larger amount than any firm offer takes', () => {
  it('goes to several traders as a price request, and the best bid becomes the client’s firm price', async () => {
    await policy({ rfq: true, rfqMaxTraders: 3, rfqWindowSeconds: 120 });
    const out = await ask('BUY_USDT', '50000');
    expect(out.outcome.kind).toBe('RFQ');
    const rfq = await w.app.selectFrom('rfq').selectAll().where('trade_request_id', '=', out.requestId).executeTakeFirstOrThrow();
    const invited = (await w.app.selectFrom('rfq_invite').select('trader_id').where('rfq_id', '=', rfq.id).execute()).map((i) => i.trader_id).sort();
    expect(invited).toEqual([a.traderId, b.traderId, c.traderId].sort());
    // The client is told the price is being gathered; a trader sees the side and the amount, never who asks.
    expect((await exchangeView(w.app, w.clientId)).request).toMatchObject({ gatheringUntil: rfq.closes_at.toISOString(), canReprice: false });
    const asks = await priceAsksFor(w.app, b.traderId);
    expect(asks).toEqual([{ ref: rfq.ref, side: 'SELL_USDT', amount: '50000.000000', currency: 'USDT', closesAt: rfq.closes_at.toISOString(), yourRate: null }]);

    await runAs(w.app, bidOnRfq(a.admin.actor), a.admin.ref, 'rfq.bid', { ref: rfq.ref, rate: '101.40' });
    await runAs(w.app, bidOnRfq(b.admin.actor), b.admin.ref, 'rfq.bid', { ref: rfq.ref, rate: '101.30' });
    await runAs(w.app, bidOnRfq(b.admin.actor), b.admin.ref, 'rfq.bid', { ref: rfq.ref, rate: '101.10' });
    // Charlie has not answered: nothing is awarded before the time is up.
    expect(await runRfqSweep(w.app)).toMatchObject({ AWARDED: 0 });
    expect((await requestOf(out.requestId)).status).toBe('OPEN');

    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 121_000));
    const swept = await runRfqSweep(clock.db);
    expect(swept.failures).toEqual([]);
    expect(swept).toMatchObject({ AWARDED: 1 });
    const bids = await w.app.selectFrom('rfq_bid').select(['trader_id', 'rate_micro', 'status']).where('rfq_id', '=', rfq.id).orderBy('placed_at').execute();
    expect(bids.map((x) => x.status)).toEqual(['LOST', 'REPLACED', 'WON']);
    const quote = await w.app.selectFrom('quote').selectAll().where('trade_request_id', '=', out.requestId).where('status', '=', 'SENT').executeTakeFirstOrThrow();
    expect(quote).toMatchObject({ client_rate_micro: r('102'), route_rate_micro: r('101.1'), base_minor: usdt('50000') });
    expect(await decisionOf(quote.id)).toMatchObject({ source: 'RFQ', rfq_id: rfq.id });
    const order = await orderOfQuote(quote.id);
    expect(order).toMatchObject({ trader_id: b.traderId, accepted_by: b.admin.userId, status: 'ACCEPTED' });
    expect((await w.app.selectFrom('rfq').select('status').where('id', '=', rfq.id).executeTakeFirstOrThrow()).status).toBe('AWARDED');
    expect(await priceAsksFor(w.app, b.traderId)).toEqual([]);
    const accepted = await accept(quote.id);
    expect((await orderOfQuote(quote.id)).trade_id).toBe(accepted.tradeId);
  });

  it('a price request nobody answers closes, and the client is told in its inbox too', async () => {
    const out = await ask('BUY_USDT', '60000');
    expect(out.outcome.kind).toBe('RFQ');
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 121_000));
    expect(await runRfqSweep(clock.db)).toMatchObject({ NO_PRICE: 1 });
    expect(await requestOf(out.requestId)).toMatchObject({ status: 'DECLINED', no_price_reason: 'NO_BID' });
    expect(await w.app.selectFrom('quote').select('id').where('trade_request_id', '=', out.requestId).execute()).toEqual([]);
    const told = await w.app.selectFrom('outbox_event').select('type').where('aggregate_id', '=', out.requestId).execute();
    expect(told.map((e) => e.type)).toContain('client.request_declined');
    expect(told.map((e) => e.type)).not.toContain('desk.request_needs_action');
  });
});

describe('what the database refuses', () => {
  it('a decision recorded for a quote already sent, a bid after its request closed, a firm offer of more than seven days', async () => {
    // A decision is written with its own quote before it is sent — never afterwards, never twice, never another one.
    const one = await w.app.selectFrom('auto_quote').selectAll().limit(1).executeTakeFirstOrThrow();
    expect(await dbCode(w.app.insertInto('auto_quote').values({ ...one, position_bps: one.position_bps + 1 }).execute())).toBe('IX139');
    const closed = await w.app.selectFrom('rfq').select(['id']).where('status', '<>', 'OPEN').limit(1).executeTakeFirstOrThrow();
    const invite = await w.app.selectFrom('rfq_invite').select('trader_id').where('rfq_id', '=', closed.id).limit(1).executeTakeFirstOrThrow();
    const placer = [a, b, c].find((t) => t.traderId === invite.trader_id)!;
    expect(await dbCode(w.app.insertInto('rfq_bid').values({ rfq_id: closed.id, trader_id: invite.trader_id, rate_micro: r('100'), placed_by: placer.admin.userId }).execute())).toBe('IX141');
    expect(await dbCode(sql`update trader_block set instant_until = inrp2p_now() + interval '8 days', instant_set_by = ${a.admin.userId} where trader_id = ${a.traderId} and side = 'SELL_USDT'`.execute(w.app))).toBe('IX142');
    expect(await dbCode(sql`update auto_quote set position_bps = 1`.execute(w.app))).not.toBeNull();
  });
});

describe('a market nobody confirmed lately', () => {
  it('a stale market: no price at all, rather than a price nobody can bound', async () => {
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 16 * 60_000));
    const out = await ask('BUY_USDT', '1000', undefined, clock.db);
    expect(out.outcome).toMatchObject({ kind: 'NO_PRICE', reason: 'NO_MARKET' });
    expect(await requestOf(out.requestId)).toMatchObject({ status: 'DECLINED', no_price_reason: 'NO_MARKET' });
  });
});

describe('a trader with a deal already open (ADR 0024)', () => {
  it('counts the deal being priced once: a second deal that fits beside the first is priced, one past the room is not', async () => {
    const setRisk = async (riskPolicy: unknown) => {
      const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
      await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, riskPolicy: riskPolicy as null, reason: 'reserve-based limits' });
    };
    // Delta sells cheaper than anyone firm and has nothing open: every price below goes to it while its reserve allows.
    const d = await railsTrader(w, 'Delta', { sell: { capacity: '500000', rate: '100.95', min: '10', max: '20000' } }, '0');
    await firm(d, 'SELL_USDT');
    await books('101.00', '102.00');
    // 500 USDT of reserve: one deal of at most 1,000 USDT of Delta's own, 1,500 USDT open at once.
    const level = { minDeals: 0, minDays: 0, dealX: 2, openX: 3 };
    try {
      await setRisk({ cleanDays: 30, tiers: [level, { ...level, minDeals: 10 }, { ...level, minDeals: 50 }] });
      const first = quoted(await ask('BUY_USDT', '600'));
      expect(traderOfOrder(await orderOfQuote(first.quoteId))).toBe(d.traderId);
      await accept(first.quoteId);
      const open = (await quoteOf(first.quoteId)).route_base_minor!;

      // About 606 USDT open and about 606 more: 1,212 of 1,500 — it fits, and is priced on Delta's offer.
      const second = quoted(await ask('BUY_USDT', '600'));
      const secondOrder = await orderOfQuote(second.quoteId);
      expect(traderOfOrder(secondOrder)).toBe(d.traderId);
      expect(open + secondOrder.base_minor).toBeLessThanOrEqual(usdt('1500'));
      await accept(second.quoteId);

      // A third beside both would pass 1,500: Delta is never asked to fill it, whoever else may.
      const third = await ask('BUY_USDT', '600');
      expect(await w.app.selectFrom('trader_order').select('id').where('trade_request_id', '=', third.requestId).where('trader_id', '=', d.traderId).execute()).toEqual([]);
      const invited = await w.app.selectFrom('rfq_invite as i').innerJoin('rfq as q', 'q.id', 'i.rfq_id').select('i.trader_id').where('q.trade_request_id', '=', third.requestId).execute();
      expect(invited.map((i) => i.trader_id)).not.toContain(d.traderId);
    } finally {
      await setRisk(null);
      await firm(d, 'SELL_USDT', { status: 'PAUSED' });
    }
  });
});

describe('the price request sweep', () => {
  it('one request that cannot be awarded never holds up the others: they are awarded, it is tried again', async () => {
    await books('101.00', '102.00');
    const [one, two] = [await traderClient(w, 'Third Buyer'), await traderClient(w, 'Fourth Buyer')];
    const x = await ask('BUY_USDT', '70000', { ...one.admin, walletId: one.walletId });
    const y = await ask('BUY_USDT', '70000', { ...two.admin, walletId: two.walletId });
    expect([x.outcome.kind, y.outcome.kind]).toEqual(['RFQ', 'RFQ']);
    const rfqOf = (requestId: string) => w.app.selectFrom('rfq').selectAll().where('trade_request_id', '=', requestId).executeTakeFirstOrThrow();
    const [rx, ry] = [await rfqOf(x.requestId), await rfqOf(y.requestId)];
    for (const rfq of [rx, ry]) await runAs(w.app, bidOnRfq(b.admin.actor), b.admin.ref, 'rfq.bid', { ref: rfq.ref, rate: '101.10' });
    // The first one's award fails in the database, whatever the reason; it closes first, so it would stand in front.
    await sql.raw(`create function test_refuse_award() returns trigger language plpgsql as $$ begin
      if new.trade_request_id = '${x.requestId}' then raise exception 'refused for this test'; end if; return new; end $$;
      create trigger test_refuse_award before insert on auto_quote for each row execute function test_refuse_award()`).execute(w.t.owner);
    try {
      const clock = await w.t.pinnedClock();
      await clock.set(new Date(Math.max(rx.closes_at.getTime(), ry.closes_at.getTime()) + 1_000));
      const out = await runRfqSweep(clock.db);
      await clock.set(null);
      expect(out).toMatchObject({ AWARDED: 1 });
      expect(out.failures.map((f) => f.rfqId)).toEqual([rx.id]);
      expect((await rfqOf(y.requestId)).status).toBe('AWARDED');
      expect((await rfqOf(x.requestId)).status).toBe('OPEN');
    } finally {
      await sql.raw('drop trigger test_refuse_award on auto_quote; drop function test_refuse_award()').execute(w.t.owner);
    }
  });
});

describe('a client asking for prices in a loop', () => {
  it('is stopped after its window’s share, and nobody else is', async () => {
    const { limitPriceRequests, PRICE_REQUESTS_PER_WINDOW } = await import('@inrp2p/quotes');
    const other = await traderClient(w, 'Fifth Buyer');
    for (let i = 0; i < PRICE_REQUESTS_PER_WINDOW; i++) await limitPriceRequests(w.app, w.clientId);
    await expect(limitPriceRequests(w.app, w.clientId)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(limitPriceRequests(w.app, other.clientId)).resolves.toBeUndefined();
  });
});
