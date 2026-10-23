import { describe, expect, it } from 'vitest';
import { Money, Rate, computeDeskEconomics, computeP2pEconomics, computeTradeEconomics, inrToUsdt, platformFeeOf, usdtToInr } from '../src/index.ts';

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

describe('amounts too small to trade', () => {
  it('refuses a SELL dust amount whose INR side rounds down to zero, instead of leaving it to a database constraint', () => {
    const clientRate = Rate.parse('102.000000', 'CLIENT');
    const routeRate = Rate.parse('104.200000', 'ROUTE');
    // 0.000001 USDT is worth ₹0.000102: nothing on the INR side survives rounding.
    expect(() => computeTradeEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: Money.parse('0.000001', 'USDT'), clientRate, routeRate }))
      .toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT' }));
    // A BUY rounds the INR the client pays up, so the same amount still prices (at ₹0.01): not dust.
    expect(computeTradeEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: Money.parse('0.000001', 'USDT'), clientRate, routeRate }).clientInr.toDecimalString()).toBe('0.01');
    // The smallest amount that prices on every side is still accepted.
    expect(computeTradeEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: Money.parse('0.0001', 'USDT'), clientRate, routeRate }).clientInr.toDecimalString()).toBe('0.01');
  });
});

describe('P2P economics (ADR 0019): one rupee amount, the margin in USDT', () => {
  it('a client buying USDT pays the trader exactly what the trader receives; the trader delivers more USDT than the client gets', () => {
    const e = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: Money.parse('500', 'USDT'), clientRate: client('101.500000'), routeRate: route('100.000000') });
    expect(e.clientInr.toDecimalString()).toBe('50750.00');
    expect(e.routeInr.toDecimalString()).toBe('50750.00');
    expect(e.routeBase.toDecimalString()).toBe('507.500000');
    expect(e.grossMarginBase.toDecimalString()).toBe('7.500000');
    expect(e.grossMargin.isZero()).toBe(true);
  });

  it('a client selling USDT gives more USDT than the trader receives for the same rupees', () => {
    const e = computeP2pEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: Money.parse('1000', 'USDT'), clientRate: client('98.500000'), routeRate: route('100.000000') });
    expect(e.clientInr.toDecimalString()).toBe('98500.00');
    expect(e.routeBase.toDecimalString()).toBe('985.000000');
    expect(e.grossMarginBase.toDecimalString()).toBe('15.000000');
  });

  it('rounds against whoever is paid, and fixes the rupees when the client names them', () => {
    const buy = computeP2pEconomics({ direction: 'BUY_USDT', fixedSide: 'QUOTE', amount: Money.parse('10000.00', 'INR'), clientRate: client('101.300000'), routeRate: route('100.100000') });
    expect(buy.base.toDecimalString()).toBe('98.716683'); // the client gets DOWN
    expect(buy.routeBase.toDecimalString()).toBe('99.900100'); // the trader delivers UP
    const sell = computeP2pEconomics({ direction: 'SELL_USDT', fixedSide: 'QUOTE', amount: Money.parse('10000.00', 'INR'), clientRate: client('98.300000'), routeRate: route('99.900000') });
    expect(sell.base.toDecimalString()).toBe('101.729400'); // the client gives UP
    expect(sell.routeBase.toDecimalString()).toBe('100.100100'); // the trader receives DOWN
  });
});

describe('a desk’s own deal (ADR 0020, FI-99): one rupee amount at the desk’s rate, the platform’s fee in USDT', () => {
  it('charges the policy’s basis points of the client’s USDT, rounded up', () => {
    expect(platformFeeOf(usdt('10000'), 25).toDecimalString()).toBe('25.000000');
    // 1234.567891 × 0.25% = 3.08641972… → 3.086420 (the desk pays: rounded against it)
    expect(platformFeeOf(usdt('1234.567891'), 25).toDecimalString()).toBe('3.086420');
    expect(platformFeeOf(usdt('10000'), 0).isZero()).toBe(true);
    expect(() => platformFeeOf(usdt('10'), 1001)).toThrow(/basis points/);
    expect(() => platformFeeOf(usdt('10'), 2.5)).toThrow(/basis points/);
  });

  it('a client selling: the desk pays the rupees and receives the client’s USDT less the fee', () => {
    const e = computeDeskEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt('10000'), clientRate: client('100.900000'), feeBps: 25 });
    expect(e.clientInr.toDecimalString()).toBe('1009000.00');
    expect(e.routeInr.equals(e.clientInr)).toBe(true);
    expect(e.grossMargin.isZero()).toBe(true);
    expect(e.routeBase.toDecimalString()).toBe('9975.000000');
    expect(e.platformFeeBase.toDecimalString()).toBe('25.000000');
    expect(e.grossMarginBase.equals(e.platformFeeBase)).toBe(true);
    expect(e.base.sub(e.routeBase).equals(e.platformFeeBase)).toBe(true);
  });

  it('a client buying: the desk receives the rupees and delivers the client’s USDT plus the fee', () => {
    const e = computeDeskEconomics({ direction: 'BUY_USDT', fixedSide: 'BASE', amount: usdt('10000'), clientRate: client('102.100000'), feeBps: 25 });
    expect(e.clientInr.toDecimalString()).toBe('1021000.00');
    expect(e.routeBase.toDecimalString()).toBe('10025.000000');
    expect(e.routeBase.sub(e.base).equals(e.platformFeeBase)).toBe(true);
  });

  it('rounds the client’s side against the client when it names the rupees, and the fee follows its USDT', () => {
    const buy = computeDeskEconomics({ direction: 'BUY_USDT', fixedSide: 'QUOTE', amount: inr('10000.00'), clientRate: client('101.300000'), feeBps: 25 });
    expect(buy.base.toDecimalString()).toBe('98.716683'); // the client gets DOWN
    expect(buy.platformFeeBase.toDecimalString()).toBe('0.246792');
    expect(buy.routeBase.toDecimalString()).toBe('98.963475');
    const sell = computeDeskEconomics({ direction: 'SELL_USDT', fixedSide: 'QUOTE', amount: inr('10000.00'), clientRate: client('98.300000'), feeBps: 25 });
    expect(sell.base.toDecimalString()).toBe('101.729400'); // the client gives UP
    expect(sell.platformFeeBase.toDecimalString()).toBe('0.254324');
    expect(sell.routeBase.toDecimalString()).toBe('101.475076');
  });

  it('refuses an amount too small to price', () => {
    expect(() => computeDeskEconomics({ direction: 'SELL_USDT', fixedSide: 'BASE', amount: usdt('0.000001'), clientRate: client('100'), feeBps: 25 })).toThrow(/too small/);
  });
});
