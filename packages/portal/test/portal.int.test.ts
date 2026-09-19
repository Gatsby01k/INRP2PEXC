import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { createQuote, createRequest, declineRequest, sendQuote } from '@inrp2p/quotes';
import { confirmPayout, createPayoutLeg, recordLegEvidence, sendPayoutLeg } from '@inrp2p/settlement';
import { clientDestinations, clientHistory, exchangeView, portalAccess, portalTrade } from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from '../../settlement/test/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld('portal_views', { capacityInr: '500000000.00' });
});
afterAll(async () => w.close());

async function payLeg(tradeId: string, amount: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
  });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  const utr = newUtr();
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr });
  await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
  return { ...leg, utr };
}

describe('who is asking', () => {
  it('resolves the client from the session, never from the request', async () => {
    const access = await portalAccess(w.app, w.acceptor.userId);
    expect(access).toMatchObject({ clientId: w.clientId, canAcceptQuotes: true });
    expect(access.clientName.length).toBeGreaterThan(0);
  });

  it('refuses a user who is not a member of any client', async () => {
    await expect(portalAccess(w.app, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('knows a member who may not accept quotes (D-01)', async () => {
    const viewer = await portalAccess(w.app, w.viewer.userId);
    expect(viewer.canAcceptQuotes).toBe(false);
  });
});

describe('the exchange screen', () => {
  it('offers the destinations the client can actually be paid to', async () => {
    const destinations = await clientDestinations(w.app, w.clientId);
    expect(destinations.banks.some((b) => b.id === w.bankAccountId)).toBe(true);
    expect(destinations.banks.every((b) => b.status === 'ACTIVE')).toBe(true);
    // The number itself stays sealed: a screen gets the four digits a person recognises, nothing more.
    expect(JSON.stringify(destinations)).not.toMatch(/account_number|accountNumber/);
    expect(destinations.banks[0]!.last4).toMatch(/^\d{4}$/);
  });

  it('shows the request being priced, then the quote the desk sent for it', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '400', targetRate: '90.000000', bankAccountId: w.bankAccountId,
    });

    const pricing = await exchangeView(w.app, w.clientId);
    expect(pricing.request).toMatchObject({ ref: request.ref, status: 'OPEN', amount: '400.000000', currency: 'USDT', targetRate: '90.000000' });
    expect(pricing.request?.destination).toMatch(/•••• \d{4}$/);
    expect(pricing.quote).toBeNull();

    const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', {
      requestId: request.requestId, routeId: w.routeId, clientRate: '90.000000', validitySeconds: 120,
    });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });

    const quoted = await exchangeView(w.app, w.clientId);
    expect(quoted.quote).toMatchObject({ status: 'SENT', clientRate: '90.000000', direction: 'SELL_USDT', network: 'TRON' });
    expect(quoted.quote?.inr.amount).toBe('36000.00');
    expect(quoted.quote?.expiresAt).toBeTruthy();
  });

  it('tells the client when the desk could not price their request, in the desk’s own words', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '11', bankAccountId: w.bankAccountId,
    });
    await runAs(w.app, declineRequest(w.dealer.actor), w.dealer.ref, 'request.decline', { requestId: request.requestId, reason: 'No liquidity for that size today' });
    const view = await exchangeView(w.app, w.clientId);
    expect(view.request).toMatchObject({ ref: request.ref, status: 'DECLINED', statusReason: 'No liquidity for that size today' });
  });
});

describe('one trade, as its client sees it', () => {
  it('walks the four stages as the money actually moves', async () => {
    const trade = await openTrade(w, { baseUsdt: '1000', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });

    const awaiting = await portalTrade(w.app, w.clientId, trade.tradeRef);
    expect(awaiting.trade.status).toBe('AWAITING_FIRST_LEG');
    expect(awaiting.stages.map((s) => s.status)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(awaiting.stages[1]!.detail).toBe('waiting for your USDT');
    expect(awaiting.trade.depositInstructions).toMatchObject({ network: 'TRON', amount: '1000.000000' });
    expect(awaiting.incoming).toBeNull();

    await settleFirstLeg(w, trade.tradeId);
    const funded = await portalTrade(w.app, w.clientId, trade.tradeRef);
    expect(funded.stages.map((s) => s.status)).toEqual(['done', 'done', 'current', 'pending']);
    expect(funded.incoming).toMatchObject({ state: 'CONFIRMED', amount: '1000.000000' });
    expect(funded.incoming?.txHash).toMatch(/^[0-9a-f]{64}$/i);

    const first = await payLeg(trade.tradeId, '50000.00');
    const partly = await portalTrade(w.app, w.clientId, trade.tradeRef);
    expect(partly.settlement.paid.amount).toBe('50000.00');
    expect(partly.settlement.remaining.amount).toBe('40000.00');
    expect(partly.settlement.payments.map((p) => p.reference)).toContain(first.utr);
    expect(partly.stages[2]!.detail).toBe('paying out');

    await payLeg(trade.tradeId, '40000.00');
    const done = await portalTrade(w.app, w.clientId, trade.tradeRef);
    expect(done.trade.status).toBe('COMPLETED');
    expect(done.stages.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect(done.completedAt).toBeTruthy();
    expect(Money.parse(done.settlement.remaining.amount, 'INR').isZero()).toBe(true);
  });

  it('never tells one client about another client’s trade', async () => {
    const trade = await openTrade(w, { baseUsdt: '10', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });
    await expect(portalTrade(w.app, randomUUID(), trade.tradeRef)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('says a trade is on hold without explaining the desk’s problem to the client', async () => {
    const trade = await openTrade(w, { baseUsdt: '20', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId, { amountUsdt: '19' });
    const held = await portalTrade(w.app, w.clientId, trade.tradeRef);
    expect(held.onHold).toBe(true);
    expect(JSON.stringify(held)).not.toMatch(/SHORT_PAYMENT|exception/i);
  });
});

describe('history', () => {
  it('lists the client’s own trades, newest first, and separates what is still running', async () => {
    const all = await clientHistory(w.app, w.clientId, { limit: 100 });
    expect(all.length).toBeGreaterThan(0);
    const times = all.map((r) => Date.parse(r.openedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const open = await clientHistory(w.app, w.clientId, { filter: 'open' });
    expect(open.every((r) => r.status !== 'COMPLETED' && r.status !== 'CANCELLED')).toBe(true);

    const completed = await clientHistory(w.app, w.clientId, { filter: 'completed' });
    expect(completed.every((r) => r.status === 'COMPLETED' && r.closedAt !== null)).toBe(true);
  });

  it('is empty for a client with no trades', async () => {
    expect(await clientHistory(w.app, randomUUID())).toEqual([]);
  });
});
