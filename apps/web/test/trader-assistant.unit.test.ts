import { describe, expect, it } from 'vitest';
import type { OrderSummary, TraderHome } from '@inrp2p/traders';
import { draftFor } from '@inrp2p/notifications';
import { traderHomeAssistant, traderOrdersAssistant } from '../src/app/(client)/_assistant/traders.ts';

/**
 * The robot on the Traders screens reports the trader's own projection and nothing else: one mood, one short
 * sentence, and the most time-critical thing first. Each case is a state a trader can really be in.
 */

const order = (over: Partial<OrderSummary> & Pick<OrderSummary, 'ref' | 'stage'>): OrderSummary => ({
  side: 'BUY_USDT',
  status: over.stage === 'OFFER' ? 'OFFERED' : over.stage === 'HELD' ? 'ACCEPTED' : over.stage === 'COMPLETED' ? 'COMPLETED' : 'IN_PROGRESS',
  usdt: '1000.000000',
  inr: '104700.00',
  rate: '104.700000',
  offeredAt: '2026-09-27T17:50:00.000Z',
  offerExpiresAt: '2026-09-27T17:52:00.000Z',
  holdUntil: null,
  startedAt: null,
  completedAt: null,
  closedAt: null,
  closeNote: null,
  reward: null,
  youOwe: null,
  ...over,
});

const reserve = {
  balance: '700.000000', required: '500.000000', locked: '500.000000', available: '200.000000', pendingRelease: '0.000000', shortfall: '0.000000',
  engaged: true, depositAddress: null, withdrawal: null, history: [],
};

const home = (over: Partial<TraderHome> = {}): TraderHome => ({
  state: 'APPROVED',
  ref: 'TR-0002',
  canApply: true,
  canAct: true,
  application: null,
  available: true,
  controlNote: null,
  assignmentsEnabled: true,
  issues: [],
  blocks: [{
    side: 'BUY_USDT', currency: 'INR', status: 'ACTIVE', capacity: '600000.00', held: '0.00', available: '600000.00', rate: '104.700000', minOrder: '50000.00', maxOrder: '300000.00',
    limitMaxOrder: null, limitMaxCapacity: null, issues: [], version: 2,
  }],
  reserve,
  offers: [],
  active: [],
  recentlyCompleted: null,
  earnings: null,
  registered: { bank: 'Kotak Mahindra Bank ••••1234', wallet: 'TAjV…CTnD', walletAddress: 'TAjV000000000000000000000000000CTnD' },
  proposal: { bank: null, wallet: null },
  openOrders: 0,
  paymentDetailsPublished: true,
  now: '2026-09-27T17:51:00.000Z',
  ...over,
});

const application = (over: Partial<NonNullable<TraderHome['application']>> = {}): NonNullable<TraderHome['application']> => ({
  fullName: 'Kiran Capital', entityType: 'COMPANY', offersBuy: true, offersSell: false, typicalInr: '100000.00', typicalUsdt: null, dailyInr: '500000.00', dailyUsdt: null,
  experience: 'BINANCE', profileLink: null, telegram: '@kiran_p2p', phoneLast4: null,
  bank: { label: 'Kotak Mahindra Bank ••••1234', state: 'PENDING_REVIEW', note: null },
  wallet: { label: 'TRC20 · TAjV…CTnD', state: 'PENDING_REVIEW', note: null },
  appliedAt: '2026-09-27T17:00:00.000Z', reviewNote: null,
  ...over,
});

describe('the trader home robot', () => {
  it('under review, says which submitted detail the desk could not verify', () => {
    const waiting = traderHomeAssistant(home({ state: 'UNDER_REVIEW', application: application() }));
    expect(waiting).toMatchObject({ mood: 'waiting', label: 'Under review' });
    const refused = traderHomeAssistant(home({ state: 'UNDER_REVIEW', application: application({ wallet: { label: 'TRC20 · TAjV…CTnD', state: 'REJECTED', note: 'Not your wallet' } }) }));
    expect(refused).toMatchObject({ mood: 'alert', title: 'The desk could not verify your wallet' });
    expect(refused.body).toContain('Not your wallet');
  });

  it('an approved trader’s replacement details change nothing it reports: the registered ones still settle', () => {
    for (const state of ['PENDING_REVIEW', 'REJECTED'] as const) {
      const r = traderHomeAssistant(home({ available: false, proposal: { bank: { label: 'HDFC Bank ••••9876', state, note: null }, wallet: null } }));
      expect(r).toMatchObject({ mood: 'ready', label: 'Offline' });
    }
  });

  it('before applying, under review, rejected and paused each say exactly that', () => {
    expect(traderHomeAssistant(home({ state: 'NONE', ref: null }))).toMatchObject({ mood: 'ready', title: 'Provide liquidity' });
    expect(traderHomeAssistant(home({ state: 'UNDER_REVIEW' }))).toMatchObject({ mood: 'waiting', label: 'Under review' });
    expect(traderHomeAssistant(home({ state: 'REJECTED', application: application({ reviewNote: 'Bank account name does not match' }) })))
      .toMatchObject({ mood: 'alert', body: 'Bank account name does not match' });
    const paused = traderHomeAssistant(home({ state: 'PAUSED', controlNote: 'Statement check', active: [order({ ref: 'TO-1', stage: 'YOUR_TURN', youOwe: '104700.00' })] }));
    expect(paused).toMatchObject({ mood: 'alert', label: 'Paused' });
    expect(paused.body).toContain('Orders in progress continue.');
    expect(paused.body).toContain('Statement check');
  });

  it('an offer speaks first — it is the thing that expires — even over the trader’s own turn', () => {
    const s = traderHomeAssistant(home({ offers: [order({ ref: 'TO-3', stage: 'OFFER' })], active: [order({ ref: 'TO-2', stage: 'YOUR_TURN', youOwe: '209400.00' })] }));
    expect(s).toMatchObject({ mood: 'focused', label: 'New order', title: 'New order TO-3' });
  });

  it('the trader’s turn names the amount and the order', () => {
    const s = traderHomeAssistant(home({ active: [order({ ref: 'TO-2', stage: 'HELD' }), order({ ref: 'TO-4', stage: 'YOUR_TURN', youOwe: '209400.00' })] }));
    expect(s).toMatchObject({ mood: 'alert', label: 'Your turn', title: 'Send ₹209,400 for TO-4' });
  });

  it('a short reserve is raised before waiting orders, but after anything the trader has to send', () => {
    const short = { ...reserve, shortfall: '100.000000' };
    expect(traderHomeAssistant(home({ issues: ['RESERVE_SHORT'], reserve: short, active: [order({ ref: 'TO-2', stage: 'CHECKING_YOURS' })] })))
      .toMatchObject({ mood: 'alert', title: 'Top up your Security Reserve' });
    expect(traderHomeAssistant(home({ issues: ['RESERVE_SHORT'], reserve: short, active: [order({ ref: 'TO-2', stage: 'YOUR_TURN', youOwe: '1.00' })] })))
      .toMatchObject({ label: 'Your turn' });
  });

  it('a payment being checked is verifying; a finished order with nothing open is success, with the reward only when real', () => {
    expect(traderHomeAssistant(home({ active: [order({ ref: 'TO-2', stage: 'CHECKING_YOURS' })] }))).toMatchObject({ mood: 'verifying', title: 'Checking your payment' });
    const done = traderHomeAssistant(home({ recentlyCompleted: order({ ref: 'TO-1', stage: 'COMPLETED', reward: '157.05' }) }));
    expect(done).toMatchObject({ mood: 'success', title: 'TO-1 completed' });
    expect(done.body).toContain('₹157.05');
    expect(traderHomeAssistant(home({ recentlyCompleted: order({ ref: 'TO-1', stage: 'COMPLETED' }) })).body).not.toMatch(/reward/i);
  });

  it('offline and online without an active side are ready, and say what to do', () => {
    expect(traderHomeAssistant(home({ available: false }))).toMatchObject({ mood: 'ready', title: 'You’re offline' });
    expect(traderHomeAssistant(home({ blocks: [] })).body).toMatch(/Make a side active/);
    expect(traderHomeAssistant(home())).toMatchObject({ mood: 'ready', title: 'You’re online' });
  });

  it('never uses the words the programme forbids', () => {
    const states = [home({ state: 'NONE' }), home(), home({ available: false }), home({ offers: [order({ ref: 'TO-3', stage: 'OFFER' })] })].map(traderHomeAssistant);
    for (const s of states) expect(`${s.label} ${s.title} ${s.body}`).not.toMatch(/yield|passive income|capital efficiency|market making|profit/i);
  });
});

describe('the orders robot', () => {
  it('reports the open order that matters most, whichever tab is showing', () => {
    expect(traderOrdersAssistant([order({ ref: 'TO-2', stage: 'CHECKING_YOURS' }), order({ ref: 'TO-3', stage: 'HELD' })], { active: 2, completed: 1 }))
      .toMatchObject({ mood: 'verifying' });
  });

  it('never says nothing is in progress while an order is open', () => {
    const s = traderOrdersAssistant([], { active: 2, completed: 1 });
    expect(s.title).not.toMatch(/Nothing in progress/);
    expect(s).toMatchObject({ mood: 'waiting', title: '2 orders in progress' });
  });

  it('with nothing open, counts what finished; with nothing at all, says so', () => {
    expect(traderOrdersAssistant([], { active: 0, completed: 1 })).toMatchObject({ title: 'Nothing in progress', body: 'One order finished.' });
    expect(traderOrdersAssistant([], { active: 0, completed: 0 })).toMatchObject({ title: 'Nothing here yet' });
  });
});

describe('trader notifications', () => {
  it('a new order names its side, amount and rate, and links to the order', () => {
    const d = draftFor('TRADER_ORDER_NEW', { orderRef: 'TO-260927-0003', side: 'BUY_USDT', base: '1000', rate: '104.70' });
    expect(d).toMatchObject({ title: 'New order TO-260927-0003', subjectRef: 'TO-260927-0003' });
    expect(d.body).toBe('Buy 1000.000000 USDT at ₹104.70 per USDT. Accept or decline it on Traders.');
    expect(d.href).toContain('TO-260927-0003');
  });

  it('the trader’s turn asks for the right asset on each side', () => {
    expect(draftFor('TRADER_ACTION_REQUIRED', { orderRef: 'TO-1', side: 'BUY_USDT', inr: '209400', base: '2000' }).body).toContain('₹209400.00');
    expect(draftFor('TRADER_ACTION_REQUIRED', { orderRef: 'TO-1', side: 'SELL_USDT', inr: '52600', base: '500' }).title).toBe('Send your USDT for TO-1');
  });

  it('a completed order mentions a reward only when there is one', () => {
    expect(draftFor('TRADER_ORDER_COMPLETED', { orderRef: 'TO-1', reward: '157.05' }).body).toBe('Settled in full. Reward earned: ₹157.05.');
    expect(draftFor('TRADER_ORDER_COMPLETED', { orderRef: 'TO-1' }).body).toBe('Settled in full.');
  });

  it('a pause carries the desk’s reason and says orders in progress continue', () => {
    const d = draftFor('TRADER_PAUSED', { reason: 'Statement check' });
    expect(d.body).toContain('Orders already in progress continue.');
    expect(d.body).toContain('Statement check');
  });
});
