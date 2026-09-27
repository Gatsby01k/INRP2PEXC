import { describe, expect, it } from 'vitest';
import type { ClientDestinations, ExchangeView, HistoryRow, PortalTrade } from '@inrp2p/portal';
import {
  destinationsAssistant,
  exchangeAssistant,
  historyAssistant,
  lifecycleSteps,
  quoteLive,
  readiness,
  requestSteps,
  tradeAssistant,
} from '../src/app/(client)/_assistant/model.ts';

/**
 * The workspace robot's reports, held to one rule: the mood is the state of record the page's own projection is
 * in, and the words say nothing the backend has not. Each case below is a real state a client can be in.
 */

const NOW = Date.parse('2026-09-19T09:11:00.000Z');
const LATER = '2026-09-19T09:16:00.000Z';
const EARLIER = '2026-09-19T09:10:00.000Z';

const bank = { id: 'b1', bankName: 'HDFC Bank', ifsc: 'HDFC0000001', last4: '8219', holderName: 'Acme Pay', rails: ['IMPS'], status: 'ACTIVE' as const, verified: true };
const wallet = { id: 'w1', network: 'TRON' as const, address: 'TQMabcdefghijklmnopqrstuvwxyzxd8D', label: 'Acme wallet', purpose: 'DESTINATION' as const, status: 'ACTIVE' as const };
const both: ClientDestinations = { banks: [bank], wallets: [wallet] };
const none: ClientDestinations = { banks: [], wallets: [] };

const request = {
  ref: 'RQ-260919-0007',
  direction: 'SELL_USDT' as const,
  fixedSide: 'BASE' as const,
  amount: '25000.000000',
  currency: 'USDT' as const,
  targetRate: null,
  destination: 'HDFC Bank •••• 8219',
  status: 'OPEN' as const,
  statusReason: null,
  createdAt: EARLIER,
};
const quote = {
  ref: 'QT-260919-0006',
  direction: 'SELL_USDT' as const,
  base: { amount: '25000.000000', currency: 'USDT' as const },
  inr: { amount: '2550000.00', currency: 'INR' as const },
  clientRate: '102.000000',
  network: 'TRON' as const,
  destination: 'HDFC Bank •••• 8219',
  expiresAt: LATER,
  status: 'SENT' as const,
};
const view = (over: Partial<ExchangeView>): ExchangeView => ({ destinations: both, request: null, quote: null, openTradeRef: null, ...over });

describe('exchange', () => {
  it('welcomes a client with nothing live, and says what happens to a request', () => {
    const s = exchangeAssistant(view({}), { canAccept: true, now: NOW });
    expect(s.mood).toBe('none');
    expect(s.body).toMatch(/firm quote/);
    expect(s.body).not.toMatch(/₹|rate/);
  });

  it('waits with a client whose request the desk is pricing', () => {
    const s = exchangeAssistant(view({ request }), { canAccept: true, now: NOW });
    expect(s).toMatchObject({ mood: 'waiting', label: 'Desk pricing' });
    expect(s.title).toContain(request.ref);
    expect(requestSteps(view({ request }), NOW).map((x) => x.status)).toEqual(['done', 'current', 'pending', 'pending']);
  });

  it('focuses on a live quote: the desk’s own rate and the time it is held until', () => {
    const s = exchangeAssistant(view({ request: { ...request, status: 'QUOTED' }, quote }), { canAccept: true, now: NOW });
    expect(s).toMatchObject({ mood: 'focused', label: 'Quote ready' });
    expect(s.body).toContain('₹102.00');
    expect(s.body).toContain('14:46 IST');
    expect(requestSteps(view({ request, quote }), NOW).map((x) => x.status)).toEqual(['done', 'done', 'current', 'pending']);
  });

  it('tells a member who cannot accept that someone else has to', () => {
    const s = exchangeAssistant(view({ request, quote }), { canAccept: false, now: NOW });
    expect(s.mood).toBe('focused');
    expect(s.body).toMatch(/acceptance rights/);
  });

  it('treats a quote past its time as expired, even before the expiry job has marked it', () => {
    expect(quoteLive(quote, Date.parse(LATER))).toBe(false);
    expect(quoteLive(quote, NOW)).toBe(true);
    const s = exchangeAssistant(view({ request, quote }), { canAccept: true, now: Date.parse(LATER) + 1 });
    expect(s).toMatchObject({ mood: 'alert', label: 'Quote expired' });
    expect(exchangeAssistant(view({ request, quote: { ...quote, status: 'EXPIRED' } }), { canAccept: true, now: NOW }).mood).toBe('alert');
  });

  it('asks for help when there is nowhere to be paid, and repeats a decline in the desk’s own words', () => {
    expect(exchangeAssistant(view({ destinations: none }), { canAccept: true, now: NOW })).toMatchObject({ mood: 'alert', label: 'Setup needed' });
    const declined = exchangeAssistant(view({ request: { ...request, status: 'DECLINED', statusReason: 'No liquidity today' } }), { canAccept: true, now: NOW });
    expect(declined).toMatchObject({ mood: 'alert', label: 'Declined' });
    expect(declined.body).toContain('No liquidity today');
  });
});

const trade = (over: Partial<PortalTrade['trade']> = {}, rest: Partial<PortalTrade> = {}): PortalTrade => ({
  trade: {
    ref: 'IX-260919-0002',
    direction: 'SELL_USDT',
    status: 'AWAITING_FIRST_LEG',
    base: { amount: '25000.000000', currency: 'USDT' },
    inr: { amount: '2550000.00', currency: 'INR' },
    clientRate: '102.000000',
    network: 'TRON',
    openedAt: EARLIER,
    depositInstructions: { address: 'TXdeposit', amount: '25000.000000', network: 'TRON' },
    ...over,
  },
  settlement: {
    tradeRef: 'IX-260919-0002',
    status: 'PENDING',
    expected: { amount: '2550000.00', currency: 'INR' },
    paid: { amount: '0.00', currency: 'INR' },
    remaining: { amount: '2550000.00', currency: 'INR' },
    payments: [],
  },
  stages: [],
  incoming: null,
  onHold: false,
  completedAt: null,
  receipt: false,
  destination: 'HDFC Bank •••• 8219',
  ...rest,
});

describe('trade', () => {
  it('waits for the client’s USDT and says exactly how much', () => {
    const s = tradeAssistant(trade());
    expect(s).toMatchObject({ mood: 'waiting', label: 'Awaiting USDT' });
    expect(s.title).toBe('Send 25,000 USDT');
  });

  it('verifies a transfer the chain has shown but not yet made final', () => {
    const s = tradeAssistant(trade({ status: 'FIRST_LEG_DETECTED' }, { incoming: { txHash: 'ab', amount: '25000.000000', state: 'DETECTED', detectedAt: NOW.toString() } }));
    expect(s).toMatchObject({ mood: 'verifying', label: 'Verifying' });
  });

  it('waits for a BUY client’s INR, confirmed by the desk', () => {
    const s = tradeAssistant(trade({ direction: 'BUY_USDT', depositInstructions: null }));
    expect(s).toMatchObject({ mood: 'waiting', label: 'Awaiting INR' });
    expect(s.body).toMatch(/UTR/);
  });

  it('reports a payout in flight as being confirmed, and one not yet sent as still to come', () => {
    const paying = trade({ status: 'PARTIALLY_SETTLED' });
    expect(tradeAssistant(paying)).toMatchObject({ mood: 'waiting', label: 'Paying out', title: '₹2,550,000 still to come' });
    const confirming = { ...paying, settlement: { ...paying.settlement, payments: [{ ref: 'L1', amount: '1000000.00', status: 'PROCESSING', reference: null, confirmedAt: null }] } };
    expect(tradeAssistant(confirming)).toMatchObject({ mood: 'verifying', label: 'Confirming payout' });
  });

  it('is pleased with a settled trade, and says whether its receipt is ready', () => {
    const s = tradeAssistant(trade({ status: 'COMPLETED' }, { receipt: true }));
    expect(s).toMatchObject({ mood: 'success', label: 'Completed' });
    expect(s.body).toBe('₹2,550,000 paid in full to HDFC Bank •••• 8219. The settlement receipt is ready.');
  });

  it('asks for attention when the desk holds a trade, or has cancelled it — without the desk’s reasons', () => {
    expect(tradeAssistant(trade({ status: 'SETTLING' }, { onHold: true }))).toMatchObject({ mood: 'alert', label: 'On hold' });
    expect(tradeAssistant(trade({ status: 'CANCELLED' }))).toMatchObject({ mood: 'alert', label: 'Cancelled' });
  });
});

const row = (over: Partial<HistoryRow>): HistoryRow => ({
  ref: 'IX-260919-0001',
  direction: 'SELL_USDT',
  status: 'COMPLETED',
  base: '100000.000000',
  inr: '10200000.00',
  clientRate: '102.000000',
  openedAt: EARLIER,
  closedAt: NOW.toString(),
  onHold: false,
  receipt: true,
  ...over,
});

describe('history', () => {
  it('points at the trade waiting for the client’s funds before anything else in progress', () => {
    const rows = [row({ ref: 'IX-3', status: 'SETTLING', closedAt: null }), row({ ref: 'IX-2', status: 'AWAITING_FIRST_LEG', closedAt: null }), row({})];
    const s = historyAssistant(rows, { all: 3, open: 2, completed: 1 });
    expect(s).toMatchObject({ mood: 'focused', label: 'Needs you' });
    expect(s.title).toBe('IX-2 is waiting for your USDT');
  });

  it('puts a held trade first of all', () => {
    const rows = [row({ ref: 'IX-2', status: 'AWAITING_FIRST_LEG', closedAt: null }), row({ ref: 'IX-3', status: 'SETTLING', onHold: true, closedAt: null })];
    expect(historyAssistant(rows, { all: 2, open: 2, completed: 0 })).toMatchObject({ mood: 'alert', title: 'IX-3 is paused' });
  });

  it('is calm when everything is settled, and when there is nothing yet', () => {
    expect(historyAssistant([row({})], { all: 1, open: 0, completed: 1 })).toMatchObject({ mood: 'none', label: 'All settled' });
    expect(historyAssistant([], { all: 0, open: 0, completed: 0 })).toMatchObject({ mood: 'none', label: 'No trades yet' });
  });

  it('draws a row’s stages from its status alone — and none for a cancelled trade', () => {
    expect(lifecycleSteps('SELL_USDT', 'AWAITING_FIRST_LEG')!.map((s) => s.status)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(lifecycleSteps('BUY_USDT', 'AWAITING_FIRST_LEG')![1]).toMatchObject({ label: 'INR received', detail: 'waiting for your INR' });
    expect(lifecycleSteps('SELL_USDT', 'FIRST_LEG_DETECTED')![1]!.detail).toBe('seen, waiting to be final');
    expect(lifecycleSteps('SELL_USDT', 'SETTLING')!.map((s) => s.status)).toEqual(['done', 'done', 'current', 'pending']);
    expect(lifecycleSteps('SELL_USDT', 'COMPLETED')!.every((s) => s.status === 'done')).toBe(true);
    expect(lifecycleSteps('SELL_USDT', 'CANCELLED')).toBeNull();
  });
});

describe('destinations', () => {
  it('knows which directions an active destination makes possible', () => {
    expect(readiness(both)).toEqual({ sell: true, buy: true });
    expect(readiness({ banks: [{ ...bank, status: 'ARCHIVED' }], wallets: [{ ...wallet, purpose: 'SOURCE' }] })).toEqual({ sell: false, buy: false });
    expect(destinationsAssistant(both)).toMatchObject({ mood: 'none', label: 'Ready' });
    expect(destinationsAssistant({ banks: [bank], wallets: [] })).toMatchObject({ label: 'Ready to sell', title: 'Buying USDT needs a wallet' });
    expect(destinationsAssistant(none)).toMatchObject({ mood: 'alert', label: 'Setup needed' });
  });
});
