import { DomainError } from './errors.ts';
import { pow10 } from './currency.ts';

const DECIMAL_RE = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?$/;

/**
 * Parses a plain decimal string into integer minor units. Never rounds: input with more
 * fractional digits than `exponent` is rejected (FINANCIAL_INVARIANTS §1.1).
 * No grouping separators, exponents, whitespace or JS numbers are accepted.
 */
export function parseDecimalToMinor(input: string, exponent: number): bigint {
  if (typeof input !== 'string') throw new DomainError('INVALID_AMOUNT', 'amount must be a decimal string');
  const m = DECIMAL_RE.exec(input);
  if (!m) throw new DomainError('INVALID_AMOUNT', `not a plain decimal: "${input}"`);
  const [, sign, whole, frac = ''] = m;
  if (frac.length > exponent) {
    throw new DomainError('INVALID_AMOUNT_PRECISION', `more than ${exponent} fractional digits: "${input}"`);
  }
  const minor = BigInt(whole!) * pow10(exponent) + BigInt(frac.padEnd(exponent, '0') || '0');
  return sign ? -minor : minor;
}

/** Formats minor units as an ungrouped decimal string with exactly `exponent` digits. */
export function formatMinorToDecimal(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = pow10(exponent);
  const whole = abs / scale;
  const frac = abs % scale;
  const body = exponent === 0 ? whole.toString() : `${whole}.${frac.toString().padStart(exponent, '0')}`;
  return negative ? `-${body}` : body;
}
