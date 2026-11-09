import { describe, expect, it } from 'vitest';
import { Money, Rate, computeP2pEconomics, isDomainError, marketRateMicro } from '../src/index.ts';

const r = (decimal: string) => Rate.parse(decimal, 'ROUTE').micro;
const usdt = (a: string) => Money.parse(a, 'USDT');
const inr = (a: string) => Money.parse(a, 'INR');

describe('a trader’s market rate (ADR 0028)', () => {
  it('moves the market by the trader’s offset and puts it on the paisa grid in the trader’s favour', () => {
    // Selling USDT at the ask + 0.30%: 101.00 × 1.003 = 101.303 → up to 101.31.
    expect(marketRateMicro({ side: 'SELL_USDT', referenceMicro: r('101'), offsetBps: 30, limitMicro: null })).toBe(r('101.31'));
    // Buying USDT at the bid − 0.25%: 100.80 × 0.9975 = 100.548 → down to 100.54.
    expect(marketRateMicro({ side: 'BUY_USDT', referenceMicro: r('100.8'), offsetBps: -25, limitMicro: null })).toBe(r('100.54'));
    // Exactly on the grid stays put.
    expect(marketRateMicro({ side: 'SELL_USDT', referenceMicro: r('100'), offsetBps: 100, limitMicro: null })).toBe(r('101'));
  });

  it('never sells below, or buys above, the trader’s own bound', () => {
    expect(marketRateMicro({ side: 'SELL_USDT', referenceMicro: r('95'), offsetBps: 0, limitMicro: r('99.5') })).toBe(r('99.5'));
    expect(marketRateMicro({ side: 'SELL_USDT', referenceMicro: r('101'), offsetBps: 0, limitMicro: r('99.5') })).toBe(r('101'));
    expect(marketRateMicro({ side: 'BUY_USDT', referenceMicro: r('106'), offsetBps: 0, limitMicro: r('102') })).toBe(r('102'));
    expect(marketRateMicro({ side: 'BUY_USDT', referenceMicro: r('100'), offsetBps: 0, limitMicro: r('102') })).toBe(r('100'));
  });

  it('refuses an offset beyond ten percent or not in whole basis points', () => {
    for (const offsetBps of [1001, -1001, 2.5]) {
      try {
        marketRateMicro({ side: 'SELL_USDT', referenceMicro: r('100'), offsetBps, limitMicro: null });
        throw new Error('accepted');
      } catch (e) {
        expect(isDomainError(e, 'INVALID_ARGUMENT')).toBe(true);
      }
    }
  });
});

describe('the network the client pays on INRP2P’s own deal (ADR 0028)', () => {
  const network = usdt('4.5');

  it('a client buying 1,000 USDT pays for 1,004.5 and receives 1,000; INRP2P keeps the spread', () => {
    const e = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: usdt('1000'), clientRate: Rate.parse('101', 'CLIENT'), routeRate: Rate.parse('100.5', 'ROUTE') }, { clientNetwork: network });
    expect(e.base.toDecimalString()).toBe('1000.000000');
    expect(e.clientInr.toDecimalString()).toBe('101454.50');
    // The trader delivers what the rupees buy at its own rate, rounded up; the margin carries the network.
    expect(e.routeBase.toDecimalString()).toBe('1009.497513');
    expect(e.grossMarginBase.toDecimalString()).toBe('9.497513');
    expect(e.grossMarginBase.sub(network).toDecimalString()).toBe('4.997513');
    expect(e.clientNetworkBase?.toDecimalString()).toBe('4.500000');
  });

  it('a client selling 1,000 USDT sends 1,000 and is paid for 995.5', () => {
    const e = computeP2pEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt('1000'), clientRate: Rate.parse('100', 'CLIENT'), routeRate: Rate.parse('100.5', 'ROUTE') }, { clientNetwork: network });
    expect(e.base.toDecimalString()).toBe('1000.000000');
    expect(e.clientInr.toDecimalString()).toBe('99550.00');
    expect(e.routeBase.toDecimalString()).toBe('990.547263');
    expect(e.base.sub(e.routeBase).equals(e.grossMarginBase)).toBe(true);
  });

  it('a fixed rupee amount leaves the network either side of what the rupees price', () => {
    const buy = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'QUOTE', amount: inr('101000'), clientRate: Rate.parse('101', 'CLIENT'), routeRate: Rate.parse('100', 'ROUTE') }, { clientNetwork: network });
    expect(buy.base.toDecimalString()).toBe('995.500000');
    const sell = computeP2pEconomics({ direction: 'SELL_USDT', fixedSide: 'QUOTE', amount: inr('100000'), clientRate: Rate.parse('100', 'CLIENT'), routeRate: Rate.parse('101', 'ROUTE') }, { clientNetwork: network });
    expect(sell.base.toDecimalString()).toBe('1004.500000');
  });

  it('refuses an amount the network would eat', () => {
    try {
      computeP2pEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt('4.5'), clientRate: Rate.parse('100', 'CLIENT'), routeRate: Rate.parse('101', 'ROUTE') }, { clientNetwork: network });
      throw new Error('accepted');
    } catch (e) {
      expect(isDomainError(e, 'INVALID_AMOUNT')).toBe(true);
    }
  });

  it('is exactly the old economics without a network', () => {
    const a = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: usdt('1000'), clientRate: Rate.parse('101', 'CLIENT'), routeRate: Rate.parse('100.5', 'ROUTE') });
    const b = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: usdt('1000'), clientRate: Rate.parse('101', 'CLIENT'), routeRate: Rate.parse('100.5', 'ROUTE') }, {});
    expect(a).toEqual(b);
    expect(a.clientNetworkBase).toBeUndefined();
  });
});

describe('the bank an IFSC belongs to', () => {
  it('names the banks traders settle with by the four letters of the code, and nothing else', async () => {
    const { bankNameOfIfsc } = await import('../src/index.ts');
    expect(bankNameOfIfsc('HDFC0001234')).toBe('HDFC Bank');
    expect(bankNameOfIfsc('icic0000104')).toBe('ICICI Bank');
    expect(bankNameOfIfsc('SBIN')).toBe('State Bank of India');
    expect(bankNameOfIfsc('UTIB0')).toBe('Axis Bank');
    expect(bankNameOfIfsc('ZZZZ0001234')).toBeNull();
    expect(bankNameOfIfsc('HD')).toBeNull();
  });
});
