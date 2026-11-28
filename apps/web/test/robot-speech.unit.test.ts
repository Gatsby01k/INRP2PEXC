import { describe, expect, it } from 'vitest';
import type { ExchangeView, HistoryRow, PortalTrade } from '@inrp2p/portal';
import { INTRO, accountSpeech, chatRisk, chatRiskSpeech, dealSpeech, destinationsSpeech, idleSpeech, payerNameSpeech, pricingSpeech, quoteSpeech, waitingSpeech } from '../src/app/(client)/_robot/speech.ts';

/**
 * Bhai's own words on the stages, held to the rules: a line read at a glance and at most one quieter one after it (three
 * for the first hello), every figure one of record, and a guard at each moment money is lost in P2P.
 */

const NOW = Date.parse('2026-09-19T09:11:00.000Z');
const EARLIER = '2026-09-19T09:05:00.000Z';
const LATER = '2026-09-19T09:16:00.000Z';

const row = (over: Partial<HistoryRow> = {}): HistoryRow => ({
  ref: 'IX-260918-0003',
  direction: 'SELL_USDT',
  status: 'COMPLETED',
  base: '1000.000000',
  inr: '96400.00',
  clientRate: '96.400000',
  openedAt: EARLIER,
  closedAt: EARLIER,
  onHold: false,
  receipt: true,
  ...over,
});

const request = {
  gatheringUntil: null as string | null,
  waitingUntil: null as string | null,
  readyNow: null,
  waiting: null as NonNullable<ExchangeView['request']>['waiting'],
  canReprice: false,
  peer: null as NonNullable<ExchangeView['request']>['peer'],
  ref: 'RQ-260919-0007',
  direction: 'SELL_USDT' as const,
  fixedSide: 'BASE' as const,
  amount: '25000.000000',
  currency: 'USDT' as const,
  targetRate: null,
  destination: 'HDFC Bank •••• 8219',
  status: 'OPEN' as const,
  statusReason: null,
  noPrice: false,
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
  sentAt: EARLIER,
  expiresAt: LATER,
  status: 'SENT' as const,
  networkFeeIncluded: null,
  networkFee: null,
};

type Deal = NonNullable<PortalTrade['p2p']>;
const deal = (over: Partial<Deal> = {}): Deal =>
  ({
    step: 'ESCROW',
    turn: 'SELLER',
    dueBy: '2026-09-19T09:40:00.000Z',
    inr: '816000.00',
    escrowFunded: false,
    payTo: null,
    payments: [],
    escrowReturn: null,
    dispute: null,
    unwind: null,
    payWindow: null,
    receiptLate: false,
    chat: { you: 'SELLER', messages: [], support: 'NONE', canPost: true },
    now: new Date(NOW).toISOString(),
    ...over,
  }) as Deal;

const trade = (p2p: Deal, over: Partial<PortalTrade> = {}, direction: 'SELL_USDT' | 'BUY_USDT' = 'SELL_USDT'): PortalTrade => ({
  trade: {
    ref: 'IX-260919-0002',
    direction,
    status: 'AWAITING_FIRST_LEG',
    base: { amount: '8000.000000', currency: 'USDT' },
    inr: { amount: '816000.00', currency: 'INR' },
    clientRate: '102.000000',
    network: 'TRON',
    openedAt: EARLIER,
    depositInstructions: { address: 'TXdeposit', amount: '8000.000000', network: 'TRON' },
    networkFee: null,
  } as PortalTrade['trade'],
  settlement: null as unknown as PortalTrade['settlement'],
  stages: [
    { key: 'accepted', status: 'done', at: EARLIER, detail: null },
    { key: 'funded', status: 'current', at: null, detail: null },
    { key: 'settling', status: 'pending', at: null, detail: null },
    { key: 'completed', status: 'pending', at: null, detail: null },
  ],
  incoming: null,
  onHold: false,
  completedAt: null,
  receipt: false,
  destination: 'HDFC Bank •••• 8219',
  fromAccounts: [],
  p2p,
  ...over,
});

/** A line of dialogue: the line itself read at a glance, then at most one quieter one. */
function wellFormed(lines: readonly string[]) {
  expect(lines.length).toBeGreaterThanOrEqual(1);
  expect(lines.length).toBeLessThanOrEqual(2);
  expect(lines[0]!.length, lines[0]).toBeLessThanOrEqual(48);
  if (lines[1]) expect(lines[1].length, lines[1]).toBeLessThanOrEqual(70);
}

describe('the Exchange before a request', () => {
  it('says hello once, in three short lines, to a client with no trades', () => {
    expect(idleSpeech({ recent: [], market: null, greeted: false })).toBe(INTRO);
    expect(INTRO.lines).toEqual(['Hi, I’m Bhai — your INRP2P robot.', 'Tell me an amount, I get you one firm price.', 'The USDT stays locked till the rupees land.']);
    const after = idleSpeech({ recent: [], market: null, greeted: true });
    expect(after.key).toBe('idle');
    wellFormed(after.lines);
  });

  it('remembers the last completed deal with its own figures, and offers the same again in one tap', () => {
    const s = idleSpeech({ recent: [row({ status: 'CANCELLED', ref: 'IX-1' }), row()], market: { SELL_USDT: '97.100000', BUY_USDT: '98.000000' }, greeted: true });
    expect(s.lines).toEqual(['Last time: sold 1,000 USDT at ₹96.40.', 'Market today: ₹97.10.']);
    expect(s.action).toEqual({ label: 'Same again', href: '/exchange?direction=sell&amount=1000' });
  });

  it('says no market figure it does not have', () => {
    const s = idleSpeech({ recent: [row({ direction: 'BUY_USDT', base: '250.500000', clientRate: '98.250000' })], market: { SELL_USDT: '97.1', BUY_USDT: null }, greeted: true });
    expect(s.lines).toEqual(['Last time: bought 250.50 USDT at ₹98.25.']);
    expect(s.action?.href).toBe('/exchange?direction=buy&amount=250.5');
  });
});

describe('a request with the desk', () => {
  it('says when the gathered price lands', () => {
    const s = pricingSpeech({ ...request, gatheringUntil: LATER });
    expect(s.lines).toEqual(['Collecting prices for this amount.', 'The best one lands here by 14:46.']);
  });

  it('says where it will tell the client, while the stage carries the wait’s facts', () => {
    const waiting = { since: EARLIER, until: '2026-09-20T09:05:00.000Z', on: 'TRADERS' as const, tradersTold: 12, tradersOnline: 3, waitHours: 24, heldLapses: 0, ahead: 1, readyNowUsdt: null };
    const on = waitingSpeech({ ...request, waitingUntil: waiting.until, waiting }, { telegram: true, now: NOW });
    expect(on.lines).toEqual(['I’m on it — close the page if you like.', 'Once it’s priced, I hold it 10 min and ping you on Telegram.']);
    expect(waitingSpeech({ ...request, waitingUntil: waiting.until, waiting }, { telegram: false, now: NOW }).lines[1]).toMatch(/here and by email\.$/);
    const market = { ...waiting, on: 'MARKET' as const };
    expect(waitingSpeech({ ...request, waitingUntil: LATER, waiting: market }, { telegram: false, now: NOW }).lines[0]).toBe('The market rate is updating.');
  });
});

describe('a firm quote', () => {
  it('holds the price in its own words, with the time of record', () => {
    expect(quoteSpeech(quote, { canAccept: true, canReprice: true, now: NOW }).lines).toEqual(['One price for all 25,000 USDT.', 'Held till 14:46 — nothing moves till you accept.']);
  });

  it('says the last seconds calmly, and only what can happen next', () => {
    const last = Date.parse(LATER) - 20_000;
    expect(quoteSpeech(quote, { canAccept: true, canReprice: true, now: last }).lines[1]).toMatch(/a tap away/);
    expect(quoteSpeech(quote, { canAccept: true, canReprice: false, now: last }).lines[1]).toMatch(/desk can send/);
  });
});

describe('a P2P deal', () => {
  it('watches TRON for the exact amount', () => {
    expect(dealSpeech(trade(deal()), NOW)!.lines).toEqual(['Watching TRON for your 8,000 USDT.', 'No button to press — I see it land.']);
  });

  it('tells a buyer not to pay before the escrow is locked', () => {
    const s = dealSpeech(trade(deal({ turn: 'SELLER' }), {}, 'BUY_USDT'), NOW)!;
    expect(s.tone).toBe('guard');
    expect(s.lines[0]).toBe('Don’t pay yet.');
  });

  it('tells a buyer it is safe to pay once the USDT is locked', () => {
    const s = dealSpeech(trade(deal({ step: 'PAY', turn: 'BUYER', escrowFunded: true }), {}, 'BUY_USDT'), NOW)!;
    expect(s.lines).toEqual(['USDT locked. Safe to pay now.']);
  });

  it('sends a seller to its bank app, not a screenshot, when the buyer says they paid', () => {
    const s = dealSpeech(trade(deal({ step: 'CONFIRM', turn: 'SELLER', escrowFunded: true })), NOW)!;
    expect(s.tone).toBe('guard');
    expect(s.lines).toEqual(['Check your bank app, not a screenshot.', 'Screenshots and SMS can be faked.']);
  });

  it('says the last five minutes of the client’s own step, calmly', () => {
    const s = dealSpeech(trade(deal({ step: 'CONFIRM', turn: 'SELLER', dueBy: new Date(NOW + 4 * 60_000).toISOString() })), NOW)!;
    expect(s.key).toMatch(/confirm-last$/);
    expect(s.tone).toBe('calm');
    // Not when the time is the other side's.
    expect(dealSpeech(trade(deal({ step: 'PAY', turn: 'BUYER', dueBy: new Date(NOW + 4 * 60_000).toISOString() })), NOW)!.key).toMatch(/pay-sell$/);
  });

  it('never decides a dispute, and offers the same deal again once one is over', () => {
    const disputed = dealSpeech(trade(deal({ step: 'CONFIRM', dispute: { status: 'OPEN' } as Deal['dispute'] })), NOW)!;
    expect(disputed.lines[0]).toMatch(/^INRP2P is checking/);
    for (const step of ['CANCELLED', 'DONE'] as const) {
      expect(dealSpeech(trade(deal({ step, turn: null })), NOW)!.action).toEqual({ label: 'Same again', href: '/exchange?direction=sell&amount=8000' });
    }
  });

  it('is quiet for a trade that is not a P2P deal', () => {
    expect(dealSpeech(trade(null as unknown as Deal), NOW)).toBeNull();
  });

  it('keeps every line short, in every step, both ways, and in its last minutes', () => {
    for (const step of ['ESCROW', 'PAY', 'CONFIRM', 'RELEASE', 'DONE', 'REFUND', 'CANCELLED'] as const) {
      for (const dir of ['SELL_USDT', 'BUY_USDT'] as const) {
        for (const dueBy of ['2026-09-19T09:40:00.000Z', new Date(NOW + 60_000).toISOString()]) {
          for (const turn of ['SELLER', 'BUYER'] as const) {
            const s = dealSpeech(trade(deal({ step, turn, dueBy }), {}, dir), NOW);
            if (s) wellFormed(s.lines);
          }
        }
      }
    }
  });
});

describe('guardian moments in the chat', () => {
  it('sees a deal moving off the platform', () => {
    for (const text of ['call me 98765 43210', '+91 9876543210 pe whatsapp karo', 'my telegram @rahul_trades', 'mail me rahul@gmail.com', 'wa.me/919876543210', 'Message me on Signal']) {
      expect(chatRisk(text), text).toBe('contact');
    }
  });

  it('sees a request to cancel', () => {
    expect(chatRisk('please cancel the order, I will refund')).toBe('cancel');
    expect(chatRisk('bhai cancel kar do')).toBe('cancel');
  });

  it('leaves ordinary messages, UTRs and amounts alone', () => {
    for (const text of ['Paid via IMPS, UTR 610000000002', 'sent ₹8,16,000 just now', 'ok thanks', 'payment done 816000', 'UTR 123456789012']) {
      expect(chatRisk(text), text).toBeNull();
    }
  });

  it('warns about the other side, and about the person’s own draft, differently — in a line each', () => {
    expect(chatRiskSpeech('contact', 'them', 'buyer').lines[0]).toBe('The buyer wants to go off INRP2P.');
    expect(chatRiskSpeech('contact', 'you', 'seller').lines[0]).toBe('Keep it in this chat.');
    expect(chatRiskSpeech('cancel', 'them', 'seller').lines[0]).toBe('The seller wants to cancel.');
    for (const risk of ['contact', 'cancel'] as const) for (const from of ['them', 'you'] as const) wellFormed(chatRiskSpeech(risk, from, 'buyer').lines);
  });

  it('says what a payer-name mismatch means, and nothing on a match', () => {
    expect(payerNameSpeech('MATCH')).toBeNull();
    expect(payerNameSpeech('PARTIAL')!.tone).toBe('guard');
    expect(payerNameSpeech('MISMATCH')!.tone).toBe('alert');
    wellFormed(payerNameSpeech('MISMATCH')!.lines);
  });
});

describe('the screens without a stage', () => {
  it('says what the client can do with what it added, and what to add next', () => {
    expect(destinationsSpeech({ canSell: true, canBuy: true, isAdmin: true }).action).toEqual({ label: 'Get a price', href: '/exchange' });
    expect(destinationsSpeech({ canSell: true, canBuy: false, isAdmin: true }).lines).toEqual(['You can sell now.', 'Add a TRC20 wallet to buy too.']);
    expect(destinationsSpeech({ canSell: false, canBuy: false, isAdmin: false }).lines[0]).toBe('An administrator of your account adds these.');
    for (const canSell of [true, false]) for (const canBuy of [true, false]) for (const isAdmin of [true, false]) wellFormed(destinationsSpeech({ canSell, canBuy, isAdmin }).lines);
  });

  it('asks for Telegram only where it is offered', () => {
    expect(accountSpeech({ telegram: null })).toBeNull();
    expect(accountSpeech({ telegram: false })!.lines[0]).toBe('Connect Telegram.');
    expect(accountSpeech({ telegram: true })!.lines[0]).toMatch(/on Telegram/);
  });
});
