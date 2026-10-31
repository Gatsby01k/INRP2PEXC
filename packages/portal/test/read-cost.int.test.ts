import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countingDb } from '@inrp2p/db/testing';
import { runAs } from '@inrp2p/identity/testing';
import { createQuote, createRequest, sendQuote, toClientQuoteView } from '@inrp2p/quotes';
import { exchangeView, portalAccess, workspaceAccess } from '../src/index.ts';
import { type World, createWorld } from '../../settlement/test/world.ts';

/**
 * What the client workspace's reads cost (performance budget), counted in statements and in how many of them are in
 * flight at once — the round trips a page waits for. Every page of the workspace reads who is asking; the Exchange reads
 * its screen on every visit and every refresh (ADR 0021 §4).
 */
let w: World;
let counted: ReturnType<typeof countingDb>;
let quoteId: string;
beforeAll(async () => {
  w = await createWorld('portal_read_cost', { capacityInr: '500000000.00' });
  counted = countingDb(w.t.appPool);
  const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '400', bankAccountId: w.bankAccountId,
  });
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', {
    requestId: request.requestId, routeId: w.routeId, clientRate: '90.000000', validitySeconds: 600,
  });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  quoteId = quote.quoteId;
});
afterAll(async () => w.close());

/** The most statements a read had in flight at once, on the pool: 1 means it waited for each answer before the next. */
async function peakInFlight<T>(fn: () => Promise<T>): Promise<{ result: T; peak: number }> {
  const pool = w.t.appPool;
  let now = 0;
  let peak = 0;
  const up = () => {
    now += 1;
    peak = Math.max(peak, now);
  };
  const down = () => {
    now -= 1;
  };
  pool.on('acquire', up);
  pool.on('release', down);
  try {
    return { result: await fn(), peak };
  } finally {
    pool.off('acquire', up);
    pool.off('release', down);
  }
}

describe('who is asking', () => {
  it('is one statement: the user and their membership together', async () => {
    counted.reset();
    const access = await workspaceAccess(counted.db, w.acceptor.userId);
    expect(access.kind).toBe('MEMBER');
    expect(counted.statements).toHaveLength(1);

    counted.reset();
    await portalAccess(counted.db, w.acceptor.userId);
    expect(counted.statements).toHaveLength(1);
  });
});

describe('the Exchange screen', () => {
  it('reads a live quote in six statements, the destinations and the latest request together', async () => {
    await exchangeView(counted.db, w.clientId); // warm the pool, so the measure is the read's and not the connections'
    counted.reset();
    const { result, peak } = await peakInFlight(() => exchangeView(counted.db, w.clientId));
    expect(result.quote?.status).toBe('SENT');
    // banks, wallets and the latest request; then its latest quote; then the quote, then its destination and fee.
    expect(counted.statements).toHaveLength(7);
    expect(peak).toBe(3);
  });

  it('reads a quote for the client with its destination and its network fee together', async () => {
    await toClientQuoteView(counted.db, quoteId);
    counted.reset();
    const { peak } = await peakInFlight(() => toClientQuoteView(counted.db, quoteId));
    expect(counted.statements).toHaveLength(3);
    expect(peak).toBe(2);
  });
});
