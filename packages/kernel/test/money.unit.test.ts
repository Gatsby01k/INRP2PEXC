import { describe, expect, it } from 'vitest';
import { DomainError, Money, Rate, divRound, formatMinorToDecimal, isUuid, parseDecimalToMinor, uuidv7 } from '../src/index.ts';

describe('decimal parsing — never rounds user input', () => {
  it.each([
    ['0', 2, 0n],
    ['10200000.00', 2, 1020000000n],
    ['102', 6, 102000000n],
    ['100000.000001', 6, 100000000001n],
    ['-5.5', 2, -550n],
  ])('%s with exponent %i', (input, exp, expected) => {
    expect(parseDecimalToMinor(input, exp)).toBe(expected);
  });

  it.each(['1,000.00', '1e6', ' 1', '1.', '.5', '01', '', 'NaN', '1_000'])('rejects malformed "%s"', (input) => {
    expect(() => parseDecimalToMinor(input, 2)).toThrowError(DomainError);
  });

  it('rejects excess precision instead of rounding', () => {
    expect(() => Money.parse('10.001', 'INR')).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT_PRECISION' }));
    expect(() => Money.parse('1.0000001', 'USDT')).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT_PRECISION' }));
    expect(() => Rate.parse('102.0000001', 'CLIENT')).toThrow(expect.objectContaining({ code: 'INVALID_AMOUNT_PRECISION' }));
  });

  it('formats without grouping or locale', () => {
    expect(formatMinorToDecimal(1020000000n, 2)).toBe('10200000.00');
    expect(formatMinorToDecimal(-1n, 6)).toBe('-0.000001');
    expect(Money.parse('100000', 'USDT').toDecimalString()).toBe('100000.000000');
  });
});

describe('Money', () => {
  it('cannot be coerced to a JS number', () => {
    const m = Money.parse('1.00', 'INR');
    expect(() => +(m as unknown as number)).toThrow(TypeError);
    expect(() => (m as unknown as number) * 2).toThrow(TypeError);
    expect(`${m}`).toBe('1.00 INR');
  });

  it('refuses cross-currency arithmetic', () => {
    const inr = Money.parse('1', 'INR') as Money;
    const usdt = Money.parse('1', 'USDT') as Money;
    expect(() => inr.add(usdt as never)).toThrow(expect.objectContaining({ code: 'CURRENCY_MISMATCH' }));
  });

  it('serializes as decimal string, never a JSON number', () => {
    expect(JSON.stringify(Money.parse('10200000', 'INR'))).toBe('{"amount":"10200000.00","currency":"INR"}');
  });

  it('rejects non-bigint minor units', () => {
    expect(() => Money.ofMinor(1 as unknown as bigint, 'INR')).toThrow(DomainError);
  });
});

describe('Rate kinds are not interchangeable (FI-01)', () => {
  it('is a compile-time error to pass a route rate where a client rate is required', () => {
    const route = Rate.parse('104.20', 'ROUTE');
    const takesClient = (r: Rate<'CLIENT'>) => r.micro;
    // @ts-expect-error — RouteRate is not assignable to ClientRate
    takesClient(route);
    expect(route.kind).toBe('ROUTE');
  });

  it('rejects zero and negative rates', () => {
    expect(() => Rate.parse('0', 'CLIENT')).toThrow(expect.objectContaining({ code: 'INVALID_RATE' }));
    expect(() => Rate.parse('-1', 'ROUTE')).toThrow(DomainError);
  });
});

describe('rounding table', () => {
  it.each([
    [10n, 4n, 'DOWN', 2n],
    [10n, 4n, 'UP', 3n],
    [10n, 4n, 'HALF_EVEN', 2n],
    [14n, 4n, 'HALF_EVEN', 4n],
    [11n, 4n, 'HALF_EVEN', 3n],
    [9n, 4n, 'HALF_EVEN', 2n],
    [12n, 4n, 'UP', 3n],
    [0n, 7n, 'UP', 0n],
  ] as const)('%s / %s %s = %s', (n, d, mode, expected) => {
    expect(divRound(n, d, mode)).toBe(expected);
  });

  it('refuses negative numerators and non-positive denominators', () => {
    expect(() => divRound(-1n, 2n, 'DOWN')).toThrow(DomainError);
    expect(() => divRound(1n, 0n, 'DOWN')).toThrow(DomainError);
  });
});

describe('uuidv7', () => {
  it('produces valid, version-7, time-ordered ids', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    for (const id of ids) {
      expect(isUuid(id)).toBe(true);
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
