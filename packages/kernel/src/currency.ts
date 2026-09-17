/**
 * Central currency precision (FINANCIAL_INVARIANTS §1.1). Mirrored by the `currency`
 * table; a migration test asserts both agree.
 */
export const CURRENCIES = {
  USDT: { code: 'USDT', exponent: 6 },
  INR: { code: 'INR', exponent: 2 },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

/** Rates are INR per 1 USDT with 6 decimal places (micro-rupees per USDT). */
export const RATE_EXPONENT = 6;

export function exponentOf(currency: CurrencyCode): number {
  return CURRENCIES[currency].exponent;
}

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCIES, value);
}

export function pow10(exp: number): bigint {
  if (!Number.isInteger(exp) || exp < 0) throw new RangeError('exponent must be a non-negative integer');
  return 10n ** BigInt(exp);
}
