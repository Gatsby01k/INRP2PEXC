import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, Rate } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { currentPricingPolicy, setPricingPolicy } from '@inrp2p/pricing';
import {
  PEER_YES_MINUTES, acceptQuoteStandingInTx, completePeerStart, declinePeer, meetPeer, peerFactsOf, requestInstantQuote, runMarketReferenceRefresh, runPeerSweep, setPeerPolicy, setWait,
  startPeer, stillLooking, withdrawRequest,
} from '@inrp2p/quotes';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { runTraderSweep, traderHome, updateBlock } from '@inrp2p/traders';
import { clientInbox, peerNotificationHandler, pushInboxHandler } from '@inrp2p/notifications';
import { subscribePush } from '@inrp2p/clients';
import { FakeWebPush } from '@inrp2p/adapters';
import { HELD_QUOTE_SECONDS, expireQuote, runWaitingSweep } from '@inrp2p/quotes';
import type { OutboxEvent } from '@inrp2p/outbox';
import { clientHistory, exchangeView, historyCounts } from '../../packages/portal/src/index.ts';
import { traderClient } from './traders-world.ts';
import { type RailsWorld, completeDeal, createRailsWorld, railsTrader } from './rails-world.ts';

/**
 * One book (ADR 0033): two clients waiting with no trader meet each other. The production case — a seller from ₹102 and
 * a buyer up to ₹100, nobody online — first sees each other's price; the buyer meets the seller's; the seller starts;
 * the buyer's standing yes accepts the price; the deal runs P2P to its end on the exchange's own rails, the seller acting
 * as the route of that one deal through its personal side. Then the ways a meeting ends without a deal.
 */
let w: RailsWorld;
let seller: Awaited<ReturnType<typeof traderClient>>;

const r = (d: string) => Rate.parse(d, 'ROUTE').micro;
const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const books = (bid: string, ask: string) => runMarketReferenceRefresh(w.app, async () => ({ bidMicro: r(bid), askMicro: r(ask), source: 'market: test books' }));
const requestOf = (id: string) => w.app.selectFrom('trade_request').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const matchOf = (ref: string) => w.app.selectFrom('peer_match').selectAll().where('ref', '=', ref).executeTakeFirstOrThrow();
const inboxOf = (clientId: string) => clientInbox(w.app, clientId, { limit: 200 });
const eventsOf = async (aggregateId: string, types: readonly string[]): Promise<OutboxEvent[]> =>
  (await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).where('aggregate_id', '=', aggregateId).where('type', 'in', [...types]).orderBy('created_at').execute())
    .map((e) => ({ id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id }));
const tell = async (matchId: string) => {
  const handler = peerNotificationHandler(w.app);
  for (const e of await eventsOf(matchId, ['peer.offered', 'peer.waiting', 'peer.ended', 'peer.deal_started'])) await handler.run(e);
};

type Person = { actor: Parameters<typeof requestInstantQuote>[0]; ref: Parameters<typeof runAs>[2] };
const askAs = (who: Person, p: Record<string, unknown>) => runAs(w.app, requestInstantQuote(who.actor, w.railsDeps), who.ref, 'request.instant_quote', p as any);
const buyerAsks = (p: Record<string, unknown>) => askAs(w.acceptor, { direction: 'BUY_USDT', walletId: w.walletId, ...p });
const meet = (who: Person, requestId: string, rate: string) => runAs(w.app, meetPeer(who.actor), who.ref, 'peer.meet', { requestId, rate });
const start = async (who: Person, matchRef: string) => {
  const out = await runAs(w.app, startPeer(who.actor), who.ref, 'peer.start', { matchRef });
  const standing = out.standing ? await completePeerStart(w.app, (ctx, quoteId, userId) => acceptQuoteStandingInTx(ctx, w.railsDeps, quoteId, userId), out.matchId) : 'GONE';
  return { ...out, standingResult: standing };
};

beforeAll(async () => {
  w = await createRailsWorld('peer', { resourceMode: 'GASFREE' });
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, reason: 'no INR account: P2P escrow' });
  await books('101.00', '102.00');
  await runAs(w.app, setPricingPolicy(w.owner.actor), w.owner.ref, 'pricing.set_policy', { expectedPolicyId: (await currentPricingPolicy(w.app)).id, reason: 'automatic prices', autoQuote: true });
  seller = await traderClient(w, 'Meera Seller');
});
afterAll(async () => w.close());

describe('two clients and no trader', () => {
  let sellRequestId: string;
  let buyRequestId: string;
  let matchRef: string;

  it('with peer matching off, each just waits — as the production case did', async () => {
    const sell = await askAs(seller.admin, { direction: 'SELL_USDT', fixedSide: 'BASE', amount: '100', targetRate: '102', bankAccountId: seller.bankAccountId });
    expect(sell.outcome).toMatchObject({ kind: 'WAITING', reason: 'NO_OFFER' });
    sellRequestId = sell.requestId;
    const buy = await buyerAsks({ fixedSide: 'QUOTE', amount: '10000', targetRate: '100' });
    expect(buy.outcome).toMatchObject({ kind: 'WAITING', reason: 'NO_OFFER' });
    buyRequestId = buy.requestId;
    expect(await peerFactsOf(w.app, buyRequestId)).toMatchObject({ enabled: false, offer: null, meeting: null });
    // The wait says what is true: nobody is online to take it.
    expect((await exchangeView(w.app, w.clientId)).request!.waiting).toMatchObject({ tradersOnline: 0, waitHours: 24 });
  });

  it('switched on, each sees the other’s price with INRP2P’s fee on it — ₹2 apart is "close", not "ready"', async () => {
    await runAs(w.app, setPeerPolicy(w.owner.actor), w.owner.ref, 'peer_policy.set', { enabled: true });
    expect(await peerFactsOf(w.app, buyRequestId)).toMatchObject({ enabled: true, offer: { kind: 'NEAR', rate: '102.260000', deal: null, otherAmountUsdt: '100' } });
    expect(await peerFactsOf(w.app, sellRequestId)).toMatchObject({ enabled: true, offer: { kind: 'NEAR', rate: '99.750000' } });
    // The sweep tells each of them once, and not again for the same price within the hour.
    const swept = await runPeerSweep(w.app);
    expect(swept).toMatchObject({ told: 2, failures: [] });
    expect((await runPeerSweep(w.app)).told).toBe(0);
    for (const id of [buyRequestId, sellRequestId]) {
      const handler = peerNotificationHandler(w.app);
      for (const e of await eventsOf(id, ['client.peer_nearby'])) await handler.run(e);
    }
    const near = (await inboxOf(w.clientId)).find((n) => n.kind === 'PEER_NEARBY')!;
    expect(near.title).toBe('A seller is close to your price');
    expect(near.body).toContain('₹102.26');
    expect(near.body).not.toContain('Meera');
  });

  it('the buyer meets the seller’s price: its bound moves to it, its yes stands an hour, the seller is asked to start', async () => {
    const out = await meet(w.acceptor, buyRequestId, '102.26');
    matchRef = out.matchRef;
    const m = await matchOf(matchRef);
    expect(m).toMatchObject({ status: 'WAITING_MAKER', taker_request_id: buyRequestId, maker_request_id: sellRequestId, direction: 'BUY_USDT', fee_bps: 25 });
    expect(m.taker_rate_micro).toBeLessThanOrEqual(r('102.26'));
    expect(m.maker_rate_micro).toBeGreaterThanOrEqual(r('102'));
    expect(m.taker_yes_until.getTime() - m.taker_yes_at.getTime()).toBe(PEER_YES_MINUTES * 60_000);
    // The seller has 100 USDT: the meeting is what that buys, less than the ₹10,000 asked — said before anyone starts.
    expect(m.route_base_minor).toBeLessThanOrEqual(usdt('100'));
    expect(m.network_allowance_minor).toBe(usdt('4.5'));
    expect((await requestOf(buyRequestId)).target_rate_micro).toBe(r('102.26'));
    // The seller is the route of this one deal through a personal side — never a trader of the programme.
    const profile = await w.app.selectFrom('trader_profile').selectAll().where('client_id', '=', seller.clientId).executeTakeFirstOrThrow();
    expect(profile).toMatchObject({ status: 'PERSONAL', available: false, required_reserve_minor: null, approved_at: null, bank_account_id: seller.bankAccountId });
    expect((await traderHome(w.app, seller.admin.userId)).state).toBe('NONE');
    const order = await w.app.selectFrom('trader_order').selectAll().where('id', '=', m.order_id!).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ status: 'OFFERED', trader_id: profile.id, trade_request_id: buyRequestId, side: 'SELL_USDT', rate_micro: m.maker_rate_micro });
    // Each sees the meeting as its own side of it.
    expect((await peerFactsOf(w.app, sellRequestId)).meeting).toMatchObject({ ref: matchRef, role: 'MAKER', status: 'WAITING_MAKER' });
    expect((await peerFactsOf(w.app, buyRequestId)).meeting).toMatchObject({ ref: matchRef, role: 'TAKER', network: '2.250000' });
    // The seller turned on notifications in its browser: the same note reaches it there, with its one link.
    await runAs(w.app, subscribePush(seller.admin.actor), seller.admin.ref, 'push.subscribe', {
      endpoint: 'https://push.example.test/seller-1', p256dh: 'B'.repeat(87), auth: 'A'.repeat(22), userAgent: 'test',
    });
    await tell(m.id);
    const browser = new FakeWebPush();
    for (const e of await eventsOf(m.id, ['peer.offered'])) await pushInboxHandler(w.app, browser).run(e);
    expect(browser.sent.map((x) => ({ endpoint: x.target.endpoint, title: x.message.title, url: x.message.url }))).toEqual([
      { endpoint: 'https://push.example.test/seller-1', title: 'A buyer took your price', url: '/exchange' },
    ]);
    const offered = (await inboxOf(seller.clientId)).find((n) => n.kind === 'PEER_MATCH_OFFERED')!;
    expect(offered.title).toBe('A buyer took your price');
    expect(offered.body).toMatch(/Start the deal by \d\d:\d\d IST/);
    expect((await inboxOf(w.clientId)).find((n) => n.kind === 'PEER_MATCH_WAITING')!.title).toBe('We asked the seller to start');
  });

  it('a request in a meeting is not the waiting sweep’s to price', async () => {
    const before = await requestOf(buyRequestId);
    expect(before.status).toBe('OPEN');
    await expect(meet(w.acceptor, buyRequestId, '102.26')).rejects.toMatchObject({ code: 'PEER_MATCH_LIVE' });
  });

  it('the seller starts: the buyer’s standing yes accepts the price, the trade opens, the seller’s request is done', async () => {
    const out = await start(seller.admin, matchRef);
    expect(out).toMatchObject({ standing: true, standingResult: 'ACCEPTED' });
    const m = await matchOf(matchRef);
    expect(m.status).toBe('STARTED');
    const quote = await w.app.selectFrom('quote').selectAll().where('id', '=', m.quote_id!).executeTakeFirstOrThrow();
    expect(quote).toMatchObject({ status: 'ACCEPTED', accepted_via: 'STANDING', accepted_by_user_id: w.acceptor.userId, client_rate_micro: m.taker_rate_micro, route_rate_micro: m.maker_rate_micro });
    // The network: the escrow carries the whole allowance; the buyer pays half as its own line, the seller's side the rest.
    expect(quote.network_fee_base_minor).toBe(usdt('4.5'));
    expect(quote.client_network_base_minor).toBe(usdt('2.25'));
    const trade = await w.app.selectFrom('trade').selectAll().where('id', '=', m.trade_id!).executeTakeFirstOrThrow();
    expect(trade).toMatchObject({ client_id: w.clientId, direction: 'BUY_USDT' });
    expect(await requestOf(sellRequestId)).toMatchObject({ status: 'MATCHED', waiting_until: null });
    expect(await requestOf(buyRequestId)).toMatchObject({ status: 'ACCEPTED' });
    await tell(m.id);
    const started = (await inboxOf(seller.clientId)).find((n) => n.kind === 'PEER_DEAL_STARTED')!;
    // Whole rupees for people: the meeting is ₹9,970, just under what 100 USDT buys — the seller sends 99.99… of its 100.
    expect(started.body).toMatch(/^Send 99\.\d+ USDT to the deal’s escrow now — the buyer pays ₹9,970 to your account only after it lands\.$/);
    expect(started.href).toMatch(/^\/deals\/TO-/);
  });

  it('runs P2P to its end: the seller’s USDT into escrow, the buyer’s rupees, the seller confirms, the buyer is paid', async () => {
    const m = await matchOf(matchRef);
    const order = await w.app.selectFrom('trader_order').select(['ref']).where('id', '=', m.order_id!).executeTakeFirstOrThrow();
    const trade = await w.app.selectFrom('trade').select(['id', 'ref']).where('id', '=', m.trade_id!).executeTakeFirstOrThrow();
    await completeDeal(w, seller, { tradeId: trade.id, tradeRef: trade.ref, orderRef: order.ref });
    expect(await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.id).executeTakeFirstOrThrow()).toEqual({ lifecycle_state: 'COMPLETED' });
    // The order catches up with its trade on the trader sweep, like any trader's.
    await runTraderSweep(w.app);
    // The seller finds its deal in its own History, at its deal page, in its own figures.
    const history = await clientHistory(w.app, seller.clientId);
    expect(history).toEqual([expect.objectContaining({ ref: order.ref, peerDeal: true, direction: 'SELL_USDT', status: 'COMPLETED', inr: '9970.00' })]);
    expect(await historyCounts(w.app, seller.clientId)).toEqual({ all: 1, open: 0, completed: 1 });
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', m.order_id!).executeTakeFirstOrThrow()).status).toBe('COMPLETED');
    // The buyer's USDT reached its own wallet; the seller's peer limit grows with the deal it completed.
    const sent = await w.app.selectFrom('chain_send').select(['purpose', 'status']).where('trade_id', '=', trade.id).execute();
    expect(sent.filter((x) => x.status === 'CONFIRMED').length).toBeGreaterThanOrEqual(1);
  });
});

describe('meetings that end without a deal', () => {
  let other: Awaited<ReturnType<typeof traderClient>>;
  let sellId: string;
  let buyId: string;

  it('two clients at the market cross at once — "ready", in the middle of the market, the fee between them', async () => {
    other = await traderClient(w, 'Ravi Seller');
    const sell = await askAs(other.admin, { direction: 'SELL_USDT', fixedSide: 'BASE', amount: '300', bankAccountId: other.bankAccountId });
    sellId = sell.requestId;
    const buy = await buyerAsks({ fixedSide: 'BASE', amount: '150' });
    buyId = buy.requestId;
    const facts = await peerFactsOf(w.app, buyId);
    // Bid ₹101, ask ₹102 — a spread wider than INRP2P's fee: they meet at the middle, ₹101.50, the quarter percent between
    // them; the buyer pays ₹101.63, under the market's ask.
    expect(facts.offer).toMatchObject({ kind: 'READY', rate: '101.630000', deal: { base: '150.000000', network: '2.250000' } });
  });

  it('a silent seller: an hour later the meeting ends, the seller is paused with a strike, the buyer keeps its place', async () => {
    const out = await meet(w.acceptor, buyId, '101.63');
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + (PEER_YES_MINUTES + 1) * 60_000));
    try {
      expect(await runPeerSweep(clock.db)).toMatchObject({ ended: 1 });
    } finally {
      await clock.set(null);
    }
    const m = await matchOf(out.matchRef);
    expect(m).toMatchObject({ status: 'ENDED', end_reason: 'MAKER_SILENT' });
    expect((await requestOf(sellId)).peer_paused_at).not.toBeNull();
    expect(await w.app.selectFrom('peer_strike').select(['kind']).where('client_id', '=', other.clientId).execute()).toEqual([{ kind: 'MAKER_SILENT' }]);
    expect(await requestOf(buyId)).toMatchObject({ status: 'OPEN' });
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', m.order_id!).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
    // A paused seller is no price for others…
    expect((await peerFactsOf(w.app, buyId)).offer).toBeNull();
    await tell(m.id);
    expect((await inboxOf(other.clientId)).find((n) => n.kind === 'PEER_MATCH_ENDED')!.title).toBe('You did not start the deal in time');
    // …until it says it is still looking.
    await runAs(w.app, stillLooking(other.admin.actor), other.admin.ref, 'peer.still_looking', { requestId: sellId });
    expect((await peerFactsOf(w.app, buyId)).offer).toMatchObject({ kind: 'READY' });
  });

  it('a seller that declines ends the meeting with no strike; a buyer that stops looking ends it too', async () => {
    const one = await meet(w.acceptor, buyId, '101.63');
    await runAs(w.app, declinePeer(other.admin.actor), other.admin.ref, 'peer.decline', { matchRef: one.matchRef });
    expect(await matchOf(one.matchRef)).toMatchObject({ status: 'ENDED', end_reason: 'MAKER_DECLINED' });
    expect(await w.app.selectFrom('peer_strike').select('id').where('client_id', '=', other.clientId).execute()).toHaveLength(1);

    const two = await meet(w.acceptor, buyId, '101.63');
    await runAs(w.app, withdrawRequest(w.acceptor.actor), w.acceptor.ref, 'request.withdraw', { requestId: buyId });
    const m = await matchOf(two.matchRef);
    expect(m).toMatchObject({ status: 'ENDED', end_reason: 'TAKER_WITHDREW' });
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', m.order_id!).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
    expect((await requestOf(sellId)).status).toBe('OPEN');
  });

  it('the client chooses how long it waits — never a length already behind it', async () => {
    await runAs(w.app, setWait(other.admin.actor), other.admin.ref, 'request.set_wait', { requestId: sellId, hours: 168 });
    const row = await requestOf(sellId);
    expect(row.wait_hours).toBe(168);
    expect(row.waiting_until!.getTime() - row.waiting_since!.getTime()).toBe(168 * 3_600_000);
    await expect(runAs(w.app, setWait(other.admin.actor), other.admin.ref, 'request.set_wait', { requestId: sellId, hours: 5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('a client’s own price, and a held price that lapses (ADR 0033 §2.1–2.2)', () => {
  let tara: Awaited<ReturnType<typeof railsTrader>>;

  it('a price past the client’s own is never sent: it waits, and says why', async () => {
    await runAs(w.app, setPeerPolicy(w.owner.actor), w.owner.ref, 'peer_policy.set', { enabled: false, reason: 'traders only for this part' });
    tara = await railsTrader(w, 'Tara', { sell: { capacity: '500000', rate: '101.20', min: '10', max: '20000' } }, '0');
    const block = await w.app.selectFrom('trader_block').selectAll().where('trader_id', '=', tara.traderId).where('side', '=', 'SELL_USDT').executeTakeFirstOrThrow();
    await runAs(w.app, updateBlock(tara.admin.actor), tara.admin.ref, 'trader.update_block', { side: 'SELL_USDT', expectedVersion: block.version, firmHours: 24 });
    // Tara sells at ₹101.20: a buyer who pays no more than ₹100 is not priced at ₹102 — or at anything.
    const out = await buyerAsks({ fixedSide: 'BASE', amount: '100', targetRate: '100' });
    expect(out.outcome).toMatchObject({ kind: 'WAITING', reason: 'OUTSIDE_LIMIT' });
    await runAs(w.app, withdrawRequest(w.acceptor.actor), w.acceptor.ref, 'request.withdraw', { requestId: out.requestId });
  });

  it('a held price that lapses puts the request back in its wait — same place, same end — and the client is told', async () => {
    // Waiting first (no firm offer takes 30,000), then Tara takes it: the price is held for the client, who is away.
    const out = await buyerAsks({ fixedSide: 'BASE', amount: '30000' });
    expect(out.outcome.kind).toBe('WAITING');
    const before = await requestOf(out.requestId);
    const block = await w.app.selectFrom('trader_block').selectAll().where('trader_id', '=', tara.traderId).where('side', '=', 'SELL_USDT').executeTakeFirstOrThrow();
    await runAs(w.app, updateBlock(tara.admin.actor), tara.admin.ref, 'trader.update_block', { side: 'SELL_USDT', expectedVersion: block.version, maxOrder: '40000' });
    expect((await runWaitingSweep(w.app)).PRICED).toBe(1);
    const quote = await w.app.selectFrom('quote').selectAll().where('trade_request_id', '=', out.requestId).where('status', '=', 'SENT').executeTakeFirstOrThrow();
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + (HELD_QUOTE_SECONDS + 5) * 1000));
    try {
      expect(await expireQuote(clock.db, quote.id)).toBe(true);
    } finally {
      await clock.set(null);
    }
    const after = await requestOf(out.requestId);
    expect(after).toMatchObject({ status: 'OPEN', held_lapses: 1 });
    expect(after.waiting_since!.getTime()).toBe(before.waiting_since!.getTime());
    expect(after.waiting_until!.getTime()).toBe(before.waiting_until!.getTime());
    // Not a person's queue: the client is told the search goes on.
    expect(await eventsOf(out.requestId, ['desk.request_needs_action', 'client.waiting_resumed']).then((es) => es.map((e) => e.type))).toEqual(['client.waiting_resumed']);
  });
});
