import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, Rate } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import { acknowledgedSignalHandler, clientInbox, clientNotificationHandler } from '@inrp2p/notifications';
import { FORBIDDEN_CLIENT_KEY, assertClientSafe, createQuote, createQuoteLink, createRequest, sendQuote, viewQuoteLink } from '@inrp2p/quotes';
import { confirmPayout, createPayoutLeg, recordLegEvidence, sendPayoutLeg } from '@inrp2p/settlement';
import { clientDestinations, clientHistory, exchangeView, portalAccess, portalTrade } from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from '../../settlement/test/world.ts';

/**
 * Phase 7 exit: the client JSON leakage test.
 *
 * Every read model a client can reach is serialized here and searched twice. Once for **keys** the desk owns —
 * `assertClientSafe` already refuses those, and this proves the fuse is actually in the path. Once for **values**,
 * which is the half a key check cannot do: the route rate, the route's name and the margin are numbers and words
 * that would leak perfectly well through an innocently named field.
 *
 * The world is built so those values are unmistakable. The route prices at ₹92.50 and the client is quoted
 * ₹90.00, so ₹2.50 a unit — ₹2,500 on this trade — is the exchange's, and a client who could read it anywhere in
 * these payloads would know exactly what the desk makes on them (SECURITY §5, D-14).
 */
const CLIENT_RATE = '90.000000';
const ROUTE_RATE = '92.500000';
const BASE_USDT = '1000';
/** Facts about the exchange's own side of the trade. None may appear in anything a client can read. */
const ROUTE_ONLY_VALUES = ['92.50', '92.500000', '2500.00', '2,500', '92500.00'];

let w: World;
let tradeRef = '';
let quoteToken = '';

beforeAll(async () => {
  w = await createWorld('portal_leakage', { capacityInr: '500000000.00' });

  const trade = await openTrade(w, { baseUsdt: BASE_USDT, clientRate: CLIENT_RATE, routeRate: ROUTE_RATE, executionMode: 'TO_EXCHANGE' });
  tradeRef = trade.tradeRef;
  await settleFirstLeg(w, trade.tradeId);
  await payLeg(trade.tradeId, '50000.00');

  // A second, live quote with a shareable link, so the link view is exercised while it still has recipients.
  const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '400', bankAccountId: w.bankAccountId,
  });
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', {
    requestId: request.requestId, routeId: w.routeId, clientRate: CLIENT_RATE, validitySeconds: 600,
  });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  await runAs(w.app, createQuoteLink(w.dealer.actor, {}, (t) => { quoteToken = t; }), w.dealer.ref, 'quote_link.create', { quoteId: quote.quoteId });

  await dispatchOutbox(w.t.worker, [clientNotificationHandler(w.app), acknowledgedSignalHandler()]);
});
afterAll(async () => w.close());

async function payLeg(tradeId: string, amount: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
  });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
  await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

const tradeId = async (): Promise<string> => (await w.app.selectFrom('trade').select('id').where('ref', '=', tradeRef).executeTakeFirstOrThrow()).id;

/** Every payload a signed-in client or a link holder can obtain, by the name of the screen it draws. */
async function clientReachablePayloads(): Promise<Record<string, unknown>> {
  return {
    'who is asking': await portalAccess(w.app, w.acceptor.userId),
    destinations: await clientDestinations(w.app, w.clientId, { includeArchived: true }),
    exchange: await exchangeView(w.app, w.clientId),
    trade: await portalTrade(w.app, w.clientId, tradeRef),
    history: await clientHistory(w.app, w.clientId, { limit: 100 }),
    inbox: await clientInbox(w.app, w.clientId, { limit: 100 }),
    'quote link': await viewQuoteLink(w.app, {}, { token: quoteToken, ipHash: 'f'.repeat(64) }),
  };
}

describe('nothing of the desk reaches a client', () => {
  it('serializes without a key the desk owns', async () => {
    for (const [screen, payload] of Object.entries(await clientReachablePayloads())) {
      expect(() => assertClientSafe(payload), screen).not.toThrow();
      for (const key of Object.keys(flatten(payload))) {
        expect(FORBIDDEN_CLIENT_KEY.test(key.split('.').at(-1) ?? ''), `${screen}: ${key}`).toBe(false);
      }
    }
  });

  it('carries no figure that belongs to the exchange, whatever it is called', async () => {
    for (const [screen, payload] of Object.entries(await clientReachablePayloads())) {
      const json = JSON.stringify(payload);
      for (const value of ROUTE_ONLY_VALUES) {
        expect(json.includes(value), `${screen} leaks ${value}`).toBe(false);
      }
      expect(json, screen).not.toMatch(/Mumbai|liquidity route|gross margin/i);
    }
  });

  it('still shows the client everything that is theirs', async () => {
    // A leakage test that passed because the payloads were empty would prove nothing.
    const payloads = await clientReachablePayloads();
    const trade = payloads.trade as Awaited<ReturnType<typeof portalTrade>>;
    expect(trade.trade.clientRate).toBe(CLIENT_RATE);
    expect(Money.parse(trade.trade.base.amount, 'USDT').equals(Money.parse(BASE_USDT, 'USDT'))).toBe(true);
    // ₹90,000 is theirs: it is the price they accepted, not the price the desk paid.
    expect(trade.trade.inr.amount).toBe('90000.00');
    expect(trade.settlement.paid.amount).toBe('50000.00');
    expect((payloads.inbox as unknown[]).length).toBeGreaterThan(0);
    // And the margin the test hunts for is real: the desk bought at 92.50 and sold at 90.00 on this trade.
    const economics = await w.t.owner.selectFrom('trade_economics').select(['route_rate_micro', 'gross_margin_inr_minor']).where('trade_id', '=', await tradeId()).executeTakeFirstOrThrow();
    expect(Rate.ofMicro(economics.route_rate_micro, 'ROUTE').toDecimalString()).toBe(ROUTE_RATE);
    expect(Money.ofMinor(economics.gross_margin_inr_minor, 'INR').toDecimalString()).toBe('2500.00');
  });
});

/** Flattens to dotted paths so a forbidden key cannot hide inside an array or a nested object. */
function flatten(value: unknown, prefix = '$', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}.${i}`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, `${prefix}.${k}`, out);
  return out;
}
