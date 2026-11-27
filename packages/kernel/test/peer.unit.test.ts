import { describe, expect, it } from 'vitest';
import { Money, computePeerEconomics, fitPeerDeal, peerLimitInrMinor, peerMeeting } from '../src/index.ts';

const r = (rupees: string): bigint => {
  const [w, f = ''] = rupees.split('.');
  return BigInt(w!) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const market = { bidMicro: r('103.925'), askMicro: r('104.09') };
const USDT = (s: string) => Money.parse(s, 'USDT');
const INR = (s: string) => Money.parse(s, 'INR');

describe('where two clients meet (ADR 0033)', () => {
  it('the production case: a seller from ₹102 and a buyer up to ₹100 do not cross — each is told the other’s price, the fee on it', () => {
    const m = peerMeeting({ direction: 'BUY_USDT', limitMicro: r('100') }, { direction: 'SELL_USDT', limitMicro: r('102') }, market, 25);
    expect(m.kind).toBe('GAP');
    if (m.kind !== 'GAP') return;
    // The buyer would pay ₹102 and INRP2P's quarter percent: ₹102.26, up to the paisa. The seller would get ₹100 less it: ₹99.75.
    expect(m.takerMeetsAtMicro).toBe(r('102.26'));
    expect(m.makerMeetsAtMicro).toBe(r('99.75'));
  });

  it('meeting the price it was shown crosses, and the buyer never pays more than it was told', () => {
    const m = peerMeeting({ direction: 'BUY_USDT', limitMicro: r('102.26') }, { direction: 'SELL_USDT', limitMicro: r('102') }, market, 25);
    expect(m.kind).toBe('CROSS');
    if (m.kind !== 'CROSS') return;
    expect(m.takerRateMicro).toBeLessThanOrEqual(r('102.26'));
    expect(m.makerRateMicro).toBeGreaterThanOrEqual(r('102'));
    expect(m.takerRateMicro - m.makerRateMicro).toBeLessThanOrEqual(r('0.26'));
  });

  it('two clients at the market both get the market, and INRP2P keeps at most its spread', () => {
    const m = peerMeeting({ direction: 'BUY_USDT', limitMicro: null }, { direction: 'SELL_USDT', limitMicro: null }, market, 25);
    expect(m).toMatchObject({ kind: 'CROSS', takerRateMicro: r('104.09'), makerRateMicro: r('103.93') });
  });

  it('a wide crossing meets near the market’s middle, inside both bounds, with the quarter percent between', () => {
    const m = peerMeeting({ direction: 'SELL_USDT', limitMicro: r('100') }, { direction: 'BUY_USDT', limitMicro: r('110') }, market, 25);
    expect(m.kind).toBe('CROSS');
    if (m.kind !== 'CROSS') return;
    expect(m.centreMicro).toBe((market.bidMicro + market.askMicro) / 2n);
    // The taker sells: it gets less than the buyer pays, by the fee and a paisa of rounding at most.
    expect(m.makerRateMicro - m.takerRateMicro).toBeGreaterThan(0n);
    expect(m.makerRateMicro - m.takerRateMicro).toBeLessThanOrEqual(r('0.28'));
    expect(m.takerRateMicro).toBeGreaterThan(r('103.5'));
  });

  it('a bound with no market to read is nothing to price on', () => {
    expect(peerMeeting({ direction: 'BUY_USDT', limitMicro: null }, { direction: 'SELL_USDT', limitMicro: r('102') }, { bidMicro: null, askMicro: null }, 25)).toEqual({ kind: 'NO_MARKET' });
    // Two named prices need no market at all.
    expect(peerMeeting({ direction: 'BUY_USDT', limitMicro: r('103') }, { direction: 'SELL_USDT', limitMicro: r('102') }, { bidMicro: null, askMicro: null }, 25).kind).toBe('CROSS');
  });

  it('refuses two requests of the same side', () => {
    expect(() => peerMeeting({ direction: 'BUY_USDT', limitMicro: null }, { direction: 'BUY_USDT', limitMicro: null }, market, 25)).toThrow();
  });
});

describe('a meeting’s economics', () => {
  const allowance = USDT('4.5');

  it('a taker buying pays half the network as its own line; the seller’s side carries the other half', () => {
    const e = computePeerEconomics({ direction: 'BUY_USDT', fixedSide: 'QUOTE', amount: INR('9970.50'), takerRateMicro: r('102.26'), makerRateMicro: r('102'), allowance });
    expect(e.clientNetworkBase.minor).toBe(USDT('2.25').minor);
    expect(e.makerNetworkBase.minor).toBe(USDT('2.25').minor);
    expect(e.clientInr.minor).toBe(INR('9970.50').minor);
    // ₹9,970.50 at ₹102.26 is 97.501466 USDT; less the buyer's half: 95.251466.
    expect(e.base.minor).toBe(USDT('95.251466').minor);
    // The seller: ₹9,970.50 at ₹102 is 97.75 USDT, and its half of the network: 100.
    expect(e.routeBase.minor).toBe(USDT('100').minor);
    expect(e.grossMarginBase.minor).toBe(e.routeBase.minor - e.base.minor);
    expect(e.netMarginBase.minor).toBeGreaterThanOrEqual(0n);
    expect(e.netMarginBase.minor).toBe(USDT('0.248534').minor);
  });

  it('a taker selling is paid for its USDT less its half; the buying maker receives its USDT less the other half', () => {
    const e = computePeerEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: USDT('100'), takerRateMicro: r('99.75'), makerRateMicro: r('100'), allowance });
    expect(e.clientInr.minor).toBe(INR('9750.56').minor);
    expect(e.routeBase.minor).toBe(USDT('97.5056').minor - USDT('2.25').minor);
    expect(e.grossMarginBase.minor).toBe(e.base.minor - e.routeBase.minor);
    expect(e.netMarginBase.minor).toBeGreaterThanOrEqual(0n);
  });

  it('never leaves a negative margin', () => {
    expect(() => computePeerEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: USDT('100'), takerRateMicro: r('101'), makerRateMicro: r('102'), allowance })).toThrow();
  });
});

describe('the size of a meeting', () => {
  const allowance = USDT('4.5');
  const base = { direction: 'BUY_USDT' as const, fixedSide: 'QUOTE' as const, takerRateMicro: r('102.26'), makerRateMicro: r('102'), allowance };

  it('takes the taker’s whole amount when the seller has enough', () => {
    const e = fitPeerDeal({ ...base, limits: { takerAmountMinor: INR('5000').minor, maker: { fixedSide: 'BASE', amountMinor: USDT('100').minor }, maxInrMinor: INR('25000').minor, minBaseMinor: USDT('20').minor } });
    expect(e?.clientInr.minor).toBe(INR('5000').minor);
  });

  it('shrinks to what the seller has: ₹10,000 asked, 100 USDT for sale', () => {
    const e = fitPeerDeal({ ...base, limits: { takerAmountMinor: INR('10000').minor, maker: { fixedSide: 'BASE', amountMinor: USDT('100').minor }, maxInrMinor: INR('25000').minor, minBaseMinor: USDT('20').minor } })!;
    expect(e.routeBase.minor).toBeLessThanOrEqual(USDT('100').minor);
    expect(e.clientInr.minor).toBeLessThan(INR('10000').minor);
    expect(e.clientInr.minor).toBeGreaterThan(INR('9960').minor);
    // Whole rupees, for people.
    expect(e.clientInr.minor % 100n).toBe(0n);
  });

  it('keeps within the lower peer limit, and refuses a meeting below the smallest', () => {
    const capped = fitPeerDeal({ ...base, limits: { takerAmountMinor: INR('90000').minor, maker: { fixedSide: 'BASE', amountMinor: USDT('5000').minor }, maxInrMinor: INR('25000').minor, minBaseMinor: USDT('50').minor } })!;
    expect(capped.clientInr.minor).toBeLessThanOrEqual(INR('25000').minor);
    expect(fitPeerDeal({ ...base, limits: { takerAmountMinor: INR('3000').minor, maker: { fixedSide: 'BASE', amountMinor: USDT('100').minor }, maxInrMinor: INR('25000').minor, minBaseMinor: USDT('50').minor } })).toBeNull();
  });

  it('the peer limit grows with completed deals', () => {
    expect(peerLimitInrMinor(0)).toBe(INR('25000').minor);
    expect(peerLimitInrMinor(3)).toBe(INR('100000').minor);
    expect(peerLimitInrMinor(10)).toBe(INR('500000').minor);
  });
});
