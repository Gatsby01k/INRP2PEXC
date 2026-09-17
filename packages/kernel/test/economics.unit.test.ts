import { describe, expect, it } from 'vitest';
import { Money, Rate, computeTradeEconomics, inrToUsdt, usdtToInr } from '../src/index.ts';

const client = (r: string) => Rate.parse(r, 'CLIENT');
const route = (r: string) => Rate.parse(r, 'ROUTE');
const usdt = (a: string) => Money.parse(a, 'USDT');
const inr = (a: string) => Money.parse(a, 'INR');

describe('canonical exact-money scenario (FINANCIAL_INVARIANTS §1.4)', () => {
  it('SELL 100,000 USDT @ client 102.00 / route 104.20 → ₹10,200,000 obligation and ₹220,000 margin', () => {
    const e = computeTradeEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt('100000'), clientRate: client('102.00'), routeRate: route('104.20') });
    expect(e.base.minor).toBe(100_000_000_000n);
    expect(e.clientInr.minor).toBe(1_020_000_000n);
    expect(e.routeInr.minor).toBe(1_042_000_000n);
    expect(e.grossMargin.minor).toBe(22_000_000n);
    expect(e.clientInr.toDecimalString()).toBe('10200000.00');
    expect(e.routeInr.toDecimalString()).toBe('10420000.00');
    expect(e.grossMargin.toDecimalString()).toBe('220000.00');
    expect(e.routeInr.sub(e.clientInr).equals(e.grossMargin)).toBe(true);
  });
});

describe('reverse direction (BUY_USDT)', () => {
  it('BUY 100,000 USDT @ client 102.00 / route 100.00 → client pays ₹10,200,000, cost ₹10,000,000, margin ₹200,000', () => {
    const e = computeTradeEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: usdt('100000'), clientRate: client('102.00'), routeRate: route('100.00') });
    expect(e.clientInr.toDecimalString()).toBe('10200000.00');
    expect(e.routeInr.toDecimalString()).toBe('10000000.00');
    expect(e.grossMargin.toDecimalString()).toBe('200000.00');
    expect(e.clientInr.sub(e.routeInr).equals(e.grossMargin)).toBe(true);
  });

  it('BUY with INR fixed: ₹10,200,000 @ 102.00 → exactly 100,000 USDT', () => {
    const e = computeTradeEconomics({ direction: 'BUY_USDT', fixedSide: 'QUOTE', amount: inr('10200000'), clientRate: client('102'), routeRate: route('100') });
    expect(e.base.toDecimalString()).toBe('100000.000000');
    expect(e.clientInr.toDecimalString()).toBe('10200000.00');
    expect(e.grossMargin.toDecimalString()).toBe('200000.00');
  });

  it('SELL with INR fixed: ₹10,200,000 @ 102.00 → client must send exactly 100,000 USDT', () => {
    const e = computeTradeEconomics({ direction: 'SELL_USDT', fixedSide: 'QUOTE', amount: inr('10200000'), clientRate: client('102'), routeRate: route('104.20') });
    expect(e.base.toDecimalString()).toBe('100000.000000');
    expect(e.grossMargin.toDecimalString()).toBe('220000.00');
  });

  it('margin sign follows direction: a mispriced quote yields negative margin, never silently flipped', () => {
    const sell = computeTradeEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt('1000'), clientRate: client('105'), routeRate: route('104.20') });
    expect(sell.grossMargin.toDecimalString()).toBe('-800.00');
    const buy = computeTradeEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: usdt('1000'), clientRate: client('99'), routeRate: route('100') });
    expect(buy.grossMargin.toDecimalString()).toBe('-1000.00');
  });
});

describe('rounding by who pays (FINANCIAL_INVARIANTS §1.2)', () => {
  // 0.000001 USDT × ₹102.123457 = ₹0.000102123457 → sub-paise
  const tiny = usdt('0.000001');
  it('amount the exchange pays rounds DOWN; amount the client pays rounds UP', () => {
    expect(usdtToInr(tiny, client('102.123457'), 'DOWN').minor).toBe(0n);
    expect(usdtToInr(tiny, client('102.123457'), 'UP').minor).toBe(1n);
  });

  it.each([
    // [direction, fixedSide, amount, clientRate, routeRate, base, clientInr, routeInr, margin]
    ['SELL_USDT', 'BASE', '1.234567', '83.333333', '84.000001', '1.234567', '102.88', '103.70', '0.82'],
    ['BUY_USDT', 'BASE', '1.234567', '84.000001', '83.333333', '1.234567', '103.71', '102.89', '0.82'],
    ['SELL_USDT', 'QUOTE', '100.00', '83.333333', '84.000001', '1.200001', '100.00', '100.80', '0.80'],
    ['BUY_USDT', 'QUOTE', '100.00', '84.000001', '83.333333', '1.190476', '100.00', '99.21', '0.79'],
  ] as const)('%s %s %s', (direction, fixedSide, amount, cr, rr, base, clientInr, routeInr, margin) => {
    const e = fixedSide === 'BASE'
      ? computeTradeEconomics({ direction, fixedSide, amount: usdt(amount), clientRate: client(cr), routeRate: route(rr) })
      : computeTradeEconomics({ direction, fixedSide, amount: inr(amount), clientRate: client(cr), routeRate: route(rr) });
    expect(e.base.toDecimalString()).toBe(base);
    expect(e.clientInr.toDecimalString()).toBe(clientInr);
    expect(e.routeInr.toDecimalString()).toBe(routeInr);
    expect(e.grossMargin.toDecimalString()).toBe(margin);
  });

  it('conversion is exact for large values (no float drift)', () => {
    const big = usdt('987654321.123456');
    expect(usdtToInr(big, client('104.123456'), 'DOWN').toDecimalString()).toBe('102837981248.70');
    expect(inrToUsdt(inr('10200000.00'), client('102'), 'DOWN').toDecimalString()).toBe('100000.000000');
  });

  it('rejects non-positive amounts', () => {
    expect(() => computeTradeEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt('0'), clientRate: client('1'), routeRate: route('1') })).toThrow();
  });
});
