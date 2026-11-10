import { describe, expect, it } from 'vitest';
import { type NotificationFacts, type OrderFacts, draftFor, orderAlertText } from '../src/index.ts';

/** What the database refuses in a client-facing message (migration 0017): the desk's own vocabulary. */
const INTERNAL = /(route|margin|spread|provider|custody|dealer|obligation|liquidity|suspense)/i;
const order: NotificationFacts = { orderRef: 'TO-261110-0007', side: 'SELL_USDT', base: '700', inr: '74550', rate: '105.20', escrow: { minutes: 30 } };

/**
 * The hand-offs of a P2P deal, in the words each side reads (migration 0049). A step that has just become someone's is said
 * as theirs, with its time — never "you will be told when it is your turn" to the side whose turn it already is.
 */
describe('a deal’s hand-offs', () => {
  it('tells a trader selling USDT that the escrow is its move, and how long it has', () => {
    const d = draftFor('TRADER_ORDER_ACCEPTED', order);
    expect(d.title).toBe('Your move: put 700 USDT in escrow for TO-261110-0007');
    expect(d.body).toContain('within 30 minutes');
    expect(d.body).toContain('Late, and the order is cancelled');
    expect(d.href).toBe('/traders/orders/TO-261110-0007');
  });

  it('tells a trader buying USDT that the seller moves first, and what it will then pay', () => {
    const d = draftFor('TRADER_ORDER_ACCEPTED', { ...order, side: 'BUY_USDT' });
    expect(d.title).toBe('Order TO-261110-0007 is confirmed');
    expect(d.body).toBe('The seller locks 700 USDT in escrow first. You are told the moment it is locked — then you pay ₹74,550.');
  });

  it('keeps the old words for an order that is not a P2P deal', () => {
    expect(draftFor('TRADER_ORDER_ACCEPTED', { orderRef: 'TO-1', side: 'SELL_USDT' }).body).toBe('The trade is open. You will be told when it is your turn to send.');
  });

  it('tells a seller whose USDT is locked that the buyer pays next — not that its rupees are on their way', () => {
    const d = draftFor('TRADER_PAYMENT_CONFIRMED', order);
    expect(d.title).toBe('Your USDT is locked for TO-261110-0007');
    expect(d.body).toContain('The buyer now pays you ₹74,550');
    // A trader that bought: its rupees were confirmed, and its USDT follows — as before.
    expect(draftFor('TRADER_PAYMENT_CONFIRMED', { ...order, side: 'BUY_USDT' }).body).toBe('INRP2P confirmed your ₹74,550. Your USDT is on its way.');
  });

  it('tells the buyer its time to pay has started, with the time on an Indian clock', () => {
    const d = draftFor('P2P_PAY_NOW', { tradeRef: 'IX-261110-0003', base: '700', inr: '74550', direction: 'BUY_USDT', p2p: { audience: 'CLIENT', payee: false, until: new Date('2026-11-10T09:05:00Z') } });
    expect(d).toMatchObject({ title: 'Pay now — the seller’s USDT is locked', subjectRef: 'IX-261110-0003', href: '/trades/IX-261110-0003' });
    expect(d.body).toBe('IX-261110-0003: 700 USDT is locked in escrow for you. Pay ₹74,550 by 14:35 IST: the seller’s account is on the trade. Pay from your own registered account, then say you paid.');
  });

  it('tells the seller the buyer says it paid — to either side, on its own page', () => {
    const client = draftFor('P2P_PAYMENT_SENT', { tradeRef: 'IX-261110-0004', inr: '51750', p2p: { audience: 'CLIENT', payee: true, rail: 'IMPS' } });
    expect(client).toMatchObject({ title: 'The buyer says they paid', href: '/trades/IX-261110-0004' });
    expect(client.body).toContain('sent ₹51,750 by IMPS');
    expect(client.body).toContain('Confirm only once the money is in your account');
    const trader = draftFor('P2P_PAYMENT_SENT', { ...order, p2p: { audience: 'TRADER', payee: true, rail: 'UPI' } });
    expect(trader).toMatchObject({ subjectRef: 'TO-261110-0007', href: '/traders/orders/TO-261110-0007' });
    expect(draftFor('P2P_PAYMENT_SENT', { ...order, p2p: { audience: 'TRADER', payee: true, deskDeal: true } }).href).toBe('/desk/deals/TO-261110-0007');
  });

  it('tells a client that buys what happens first: the seller locks the USDT, then it is told to pay', () => {
    const d = draftFor('TRADE_OPENED', { tradeRef: 'IX-261110-0003', direction: 'BUY_USDT' });
    expect(d.body).toBe('IX-261110-0003 is open. The seller locks the USDT in escrow first — you are told the moment it is time to pay.');
  });

  it('tells a trader its side is out of capacity, in the side’s own currency, and what to do', () => {
    const sell = draftFor('TRADER_SIDE_EMPTY', { side: 'SELL_USDT', sideEmpty: { currency: 'USDT', left: '49.5' } });
    expect(sell.title).toBe('Your Sell USDT side is out of capacity');
    expect(sell.body).toBe('Completed orders used it up: 49.5 USDT is left, less than your smallest order. You get no new sell orders until you add USDT capacity on Traders.');
    const buy = draftFor('TRADER_SIDE_EMPTY', { side: 'BUY_USDT', sideEmpty: { currency: 'INR', left: '0' } });
    expect(buy.body).toContain('₹0 is left');
    expect(buy.body).toContain('until you add INR capacity on Traders');
  });

  it('says none of it in the desk’s own vocabulary — the database would refuse the message', () => {
    const drafts = [
      draftFor('TRADER_ORDER_ACCEPTED', order), draftFor('TRADER_ORDER_ACCEPTED', { ...order, side: 'BUY_USDT' }), draftFor('TRADER_PAYMENT_CONFIRMED', order),
      draftFor('P2P_PAY_NOW', { tradeRef: 'IX-1', base: '700', inr: '74550', p2p: { audience: 'CLIENT', payee: false } }),
      draftFor('P2P_PAYMENT_SENT', { tradeRef: 'IX-1', inr: '74550', p2p: { audience: 'CLIENT', payee: true } }),
      draftFor('TRADER_SIDE_EMPTY', { side: 'SELL_USDT' }), draftFor('TRADE_OPENED', { tradeRef: 'IX-1', direction: 'BUY_USDT' }),
    ];
    for (const d of drafts) expect(`${d.title} ${d.body}`).not.toMatch(INTERNAL);
  });
});

describe('the Telegram alert for an order that has just opened', () => {
  const facts: OrderFacts = { orderId: 'o', ref: 'TO-261110-0007', traderClientId: 'c', side: 'SELL_USDT', traderBaseMinor: 700_000_000n, inrMinor: 7_455_000n, rateMicro: 105_200_000n, p2p: true, desk: null };

  it('is the seller’s move on a P2P deal, not a promise to tell it later', () => {
    const text = orderAlertText(facts, 'STARTED')!;
    expect(text).toMatch(/^Your move · TO-261110-0007/);
    expect(text).toContain('Put 700 USDT in escrow now');
    expect(text).not.toContain('You will be told when it is your turn');
  });

  it('tells a trader buying that the seller locks the USDT first', () => {
    expect(orderAlertText({ ...facts, side: 'BUY_USDT' }, 'STARTED')).toContain('The seller locks the USDT in escrow first; you are told when to pay.');
  });
});
