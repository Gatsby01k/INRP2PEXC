import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, Rate, marketRateMicro } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { currentPricingPolicy, currentReferenceRate, setPricingPolicy } from '@inrp2p/pricing';
import { acceptQuote, createQuote, createRequest, requestInstantQuote, runMarketReferenceRefresh, sendQuote } from '@inrp2p/quotes';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { acceptOrder, assignRequest, traderHome, updateBlock } from '@inrp2p/traders';
import { type RailsWorld, createRailsWorld, railsTrader } from './rails-world.ts';

/**
 * The fully automatic INRP2P exchange (ADR 0028): a trader sets its rate against the market and leaves its offer firm until
 * it turns it off; a client of any size gets a firm price at once, the deal's network as its own line; the database derives
 * every market rate again from the reference it names. Nobody at INRP2P prices, routes or accepts anything here.
 */
let w: RailsWorld;
let echo: Awaited<ReturnType<typeof railsTrader>>;
let fixed: Awaited<ReturnType<typeof railsTrader>>;

const r = (d: string) => Rate.parse(d, 'ROUTE').micro;
const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const inr = (d: string) => Money.parse(d, 'INR').minor;
const dbCode = (p: Promise<unknown>) => p.then(() => null, (e) => pgErrorCode(e) ?? e?.code ?? e);
const NETWORK = usdt('4.5');

const books = (bid: string, ask: string) => runMarketReferenceRefresh(w.app, async () => ({ bidMicro: r(bid), askMicro: r(ask), source: 'market: test books' }));
const policy = async (change: Record<string, unknown>) =>
  runAs(w.app, setPricingPolicy(w.owner.actor), w.owner.ref, 'pricing.set_policy', { expectedPolicyId: (await currentPricingPolicy(w.app)).id, reason: 'the fully automatic exchange in this test', ...change });
const ask = (direction: 'SELL_USDT' | 'BUY_USDT', amount: string) =>
  runAs(w.app, requestInstantQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'request.instant_quote', {
    direction, fixedSide: 'BASE' as const, amount, ...(direction === 'SELL_USDT' ? { bankAccountId: w.bankAccountId } : { walletId: w.walletId }),
  });
const blockOf = (traderId: string, side: 'BUY_USDT' | 'SELL_USDT') => w.app.selectFrom('trader_block').selectAll().where('trader_id', '=', traderId).where('side', '=', side).executeTakeFirstOrThrow();
const edit = async (t: typeof echo, side: 'BUY_USDT' | 'SELL_USDT', change: Record<string, unknown>) =>
  runAs(w.app, updateBlock(t.admin.actor), t.admin.ref, 'trader.update_block', { side, expectedVersion: (await blockOf(t.traderId, side)).version, ...change });
const orderOfQuote = async (quoteId: string) => {
  const d = await w.app.selectFrom('auto_quote').select('trader_order_id').where('quote_id', '=', quoteId).executeTakeFirstOrThrow();
  return w.app.selectFrom('trader_order').selectAll().where('id', '=', d.trader_order_id).executeTakeFirstOrThrow();
};
const quoteOf = (id: string) => w.app.selectFrom('quote').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
function quoted(out: Awaited<ReturnType<typeof ask>>) {
  if (out.outcome.kind !== 'QUOTED') throw new Error(`expected a firm price, got ${JSON.stringify(out.outcome)}`);
  return out.outcome;
}

beforeAll(async () => {
  w = await createRailsWorld('full-auto', { resourceMode: 'GASFREE' });
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, reason: 'no INR account: P2P escrow' });
  echo = await railsTrader(w, 'Echo', { buy: { capacity: '50000000', rate: '101.00', min: '100', max: '2000000' }, sell: { capacity: '500000', rate: '101.00', min: '10', max: '20000' } }, '0');
  // A trader at a fixed number that accepts each order itself: never priced on without asking.
  fixed = await railsTrader(w, 'Foxtrot', { buy: { capacity: '50000000', rate: '101.10', min: '100', max: '2000000' }, sell: { capacity: '500000', rate: '101.50', min: '10', max: '20000' } }, '0');
  await books('101.00', '102.00');
  await policy({ autoQuote: true, rfq: true, rfqMaxTraders: 3, rfqWindowSeconds: 120 });
});
afterAll(async () => w.close());

describe('a trader’s rate set against the market', () => {
  it('follows the market by the trader’s own margin, and its offer stays firm until the trader turns it off', async () => {
    // Echo sells 0.30% under the ask and buys 0.30% over the bid, firm with no end of its own.
    const sells = await edit(echo, 'SELL_USDT', { rateBasis: 'MARKET', marketOffsetBps: -30, firmOpenEnded: true });
    expect(sells).toMatchObject({ firmUntil: null, firmOpenEnded: true });
    await edit(echo, 'BUY_USDT', { rateBasis: 'MARKET', marketOffsetBps: 30, rateLimit: '103.00', firmOpenEnded: true });
    expect(await blockOf(echo.traderId, 'SELL_USDT')).toMatchObject({ rate_basis: 'MARKET', market_offset_bps: -30, rate_micro: null, instant_open_ended: true, instant_until: null });
    // What the trader sees: the rate it comes to now, the market it follows, its terms.
    const home = await traderHome(w.app, echo.admin.userId);
    const side = home.blocks.find((b) => b.side === 'SELL_USDT')!;
    expect(side).toMatchObject({ rateBasis: 'MARKET', marketOffsetBps: -30, market: '102.000000', firmOpenEnded: true, firmUntil: null });
    // ₹102 × 0.997 = ₹101.694, up to the trader's paisa: ₹101.70.
    expect(side.rate).toBe('101.700000');
    const buys = home.blocks.find((b) => b.side === 'BUY_USDT')!;
    expect(buys).toMatchObject({ rate: '101.300000', rateLimit: '103.000000', market: '101.000000' });
  });

  it('a fixed number cannot stay firm without an end: the market would leave it behind', async () => {
    await expect(edit(fixed, 'SELL_USDT', { firmOpenEnded: true })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await dbCode(sql`update trader_block set instant_open_ended = true, instant_set_by = ${fixed.admin.userId} where trader_id = ${fixed.traderId} and side = 'SELL_USDT'`.execute(w.app))).not.toBeNull();
  });
});

describe('a client of any size', () => {
  it('buys 50 USDT at the market at once: the network its own line, the rate the market’s', async () => {
    const out = quoted(await ask('BUY_USDT', '50'));
    const quote = await quoteOf(out.quoteId);
    const order = await orderOfQuote(out.quoteId);
    const ask0 = (await currentReferenceRate(w.app, 'BUY_USDT'))!;
    // 54.5 USDT priced at the ask, ₹102: the client receives its 50 in full and pays ₹5,559.
    expect(quote).toMatchObject({ client_rate_micro: r('102'), base_minor: usdt('50'), quote_inr_minor: inr('5559'), client_network_base_minor: NETWORK, network_fee_base_minor: NETWORK });
    expect(order).toMatchObject({ trader_id: echo.traderId, rate_micro: r('101.7'), rate_reference_snapshot_id: ask0.id, rate_offset_bps: -30, rate_limit_micro: null, accepted_by: echo.admin.userId });
    // What INRP2P keeps is the spread, never less than nothing: the network is the client's.
    const terms = await w.app.selectFrom('quote_network_fee').select(['net_margin_usdt_minor', 'fee_usdt_minor']).where('quote_id', '=', out.quoteId).executeTakeFirstOrThrow();
    expect(terms.fee_usdt_minor).toBe(NETWORK);
    expect(terms.net_margin_usdt_minor!).toBeGreaterThan(0n);
    expect(terms.net_margin_usdt_minor).toBe(quote.gross_margin_base_minor! - NETWORK);
  });

  it('settles end to end: the client receives exactly what it was told, the network paid out of the escrow', async () => {
    const out = quoted(await ask('BUY_USDT', '120'));
    const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: out.quoteId });
    const econ = await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
    expect(econ).toMatchObject({ base_minor: usdt('120'), client_network_base_minor: NETWORK });
    // The escrow holds the trader's USDT: the client's, the network and the spread.
    expect(econ.route_base_minor! - econ.base_minor).toBe(econ.gross_margin_base_minor);
    expect(econ.gross_margin_base_minor! > NETWORK).toBe(true);
  });

  it('sells 300 USDT: sends 300, is paid for 295.5 at the bid', async () => {
    const out = quoted(await ask('SELL_USDT', '300'));
    const quote = await quoteOf(out.quoteId);
    const order = await orderOfQuote(out.quoteId);
    expect(quote).toMatchObject({ client_rate_micro: r('101'), base_minor: usdt('300'), quote_inr_minor: inr('29845.50') });
    // ₹101 × 1.003 = ₹101.303, down to the trader's paisa: ₹101.30 — under its own bound of ₹103.
    expect(order).toMatchObject({ trader_id: echo.traderId, rate_micro: r('101.3'), rate_offset_bps: 30, rate_limit_micro: r('103') });
  });
});

describe('the market moves', () => {
  it('and the rate with it: the next price is on the new market, the trader never touched its terms', async () => {
    await books('101.00', '103.00');
    const out = quoted(await ask('BUY_USDT', '100'));
    const order = await orderOfQuote(out.quoteId);
    // ₹103 × 0.997 = ₹102.691 → ₹102.70.
    expect((await quoteOf(out.quoteId)).client_rate_micro).toBe(r('103'));
    expect(order.rate_micro).toBe(marketRateMicro({ side: 'SELL_USDT', referenceMicro: r('103'), offsetBps: -30, limitMicro: null }));
    expect(order.rate_micro).toBe(r('102.7'));
  });

  it('past the trader’s own bound, its rate stops there', async () => {
    // The bid at ₹102.90 + 0.30% = ₹103.21 — Echo never buys above ₹103.
    await books('102.90', '103.50');
    const out = quoted(await ask('SELL_USDT', '200'));
    expect((await orderOfQuote(out.quoteId)).rate_micro).toBe(r('103'));
    await books('101.00', '102.00');
  });
});

describe('what the database refuses', () => {
  it('an order at a market rate its terms do not give, or on a reference that is not the market of its deals', async () => {
    const out = quoted(await ask('BUY_USDT', '80'));
    const order = await orderOfQuote(out.quoteId);
    const copy = {
      trader_id: order.trader_id, block_id: order.block_id, route_id: order.route_id, trade_request_id: order.trade_request_id, side: order.side,
      base_minor: order.base_minor, inr_minor: order.inr_minor, capacity_minor: order.capacity_minor, planned_client_rate_micro: order.planned_client_rate_micro,
      offered_by: 'test', offer_expires_at: new Date(Date.now() + 60_000), rate_offset_bps: order.rate_offset_bps, rate_limit_micro: order.rate_limit_micro,
    };
    expect(await dbCode(w.app.insertInto('trader_order').values({ ...copy, rate_micro: order.rate_micro + 10_000n, rate_reference_snapshot_id: order.rate_reference_snapshot_id }).execute())).toBe('IX143');
    const bid = (await currentReferenceRate(w.app, 'SELL_USDT'))!;
    expect(await dbCode(w.app.insertInto('trader_order').values({ ...copy, rate_micro: order.rate_micro, rate_reference_snapshot_id: bid.id }).execute())).toBe('IX143');
    expect(await dbCode(w.app.insertInto('trader_order').values({ ...copy, rate_micro: order.rate_micro, rate_offset_bps: -31, rate_reference_snapshot_id: order.rate_reference_snapshot_id }).execute())).toBe('IX143');
  });

  it('a market rate on a stale reference', async () => {
    const out = quoted(await ask('BUY_USDT', '90'));
    const order = await orderOfQuote(out.quoteId);
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 16 * 60_000));
    const insert = clock.db.insertInto('trader_order').values({
      trader_id: order.trader_id, block_id: order.block_id, route_id: order.route_id, trade_request_id: order.trade_request_id, side: order.side,
      base_minor: order.base_minor, inr_minor: order.inr_minor, capacity_minor: order.capacity_minor, planned_client_rate_micro: order.planned_client_rate_micro,
      offered_by: 'test', offer_expires_at: new Date(Date.now() + 20 * 60_000), rate_micro: order.rate_micro, rate_reference_snapshot_id: order.rate_reference_snapshot_id,
      rate_offset_bps: order.rate_offset_bps, rate_limit_micro: order.rate_limit_micro,
    }).execute();
    expect(await dbCode(insert)).toBe('IX143');
    await clock.set(null);
  });
});

describe('a person routing at a market rate', () => {
  it('offers the order at the rate its terms give now, records how, and the trader accepts exactly that', async () => {
    // Foxtrot's fixed ₹101.50 would win the routing over Echo's ₹101.70: it is away for these.
    await edit(fixed, 'SELL_USDT', { status: 'PAUSED' });
    await edit(echo, 'SELL_USDT', { firmHours: 0 });
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'BUY_USDT', fixedSide: 'BASE' as const, amount: '200', walletId: w.walletId });
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '102.000000' });
    const order = await w.app.selectFrom('trader_order').selectAll().where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ trader_id: echo.traderId, rate_micro: r('101.7'), rate_offset_bps: -30, status: 'OFFERED' });
    // The client's rupees pay for its 200 USDT and the network; the order was sized with both.
    expect(order.inr_minor).toBe(inr('20859'));
    // The market moving meanwhile does not move the offer: it names its rate, and the trader accepts that.
    await books('101.00', '102.50');
    await runAs(w.app, acceptOrder(echo.admin.actor), echo.admin.ref, 'trader_order.accept', { ref: assigned.ref });
    const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: '102.000000', validitySeconds: 300 });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
    expect(await quoteOf(quote.quoteId)).toMatchObject({ quote_inr_minor: inr('20859'), client_network_base_minor: NETWORK, route_rate_micro: r('101.7') });
    const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
    expect(accepted.tradeId).toBeTruthy();
    await books('101.00', '102.00');
  });

  it('changing its margin withdraws an offer made on the old terms', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'BUY_USDT', fixedSide: 'BASE' as const, amount: '150', walletId: w.walletId });
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '102.000000' });
    const changed = await edit(echo, 'SELL_USDT', { marketOffsetBps: -40 });
    expect(changed.offersWithdrawn).toBe(1);
    expect((await w.app.selectFrom('trader_order').select('status').where('ref', '=', assigned.ref).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
  });

  it('back to a fixed number, an offer firm until turned off ends with the market rate it stood on', async () => {
    await edit(echo, 'SELL_USDT', { firmOpenEnded: true });
    const back = await edit(echo, 'SELL_USDT', { rateBasis: 'FIXED', rate: '101.40' });
    expect(back).toMatchObject({ firmOpenEnded: false, firmUntil: null });
    expect(await blockOf(echo.traderId, 'SELL_USDT')).toMatchObject({ rate_basis: 'FIXED', rate_micro: r('101.4'), market_offset_bps: null, instant_set_by: null });
  });
});
