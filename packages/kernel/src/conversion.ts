import { DomainError } from './errors.ts';
import { RATE_EXPONENT, exponentOf, pow10 } from './currency.ts';
import { Money } from './money.ts';
import type { Rate, RateKind } from './rate.ts';
import { type RoundingMode, divRound } from './rounding.ts';

/** 10^(USDT exponent + rate exponent − INR exponent) = 10¹⁰ */
const SCALE = pow10(exponentOf('USDT') + RATE_EXPONENT - exponentOf('INR'));

/** inr_minor = round(usdt_minor × rate_micro / 10¹⁰, mode) — FINANCIAL_INVARIANTS §1.2 */
export function usdtToInr(usdt: Money<'USDT'>, rate: Rate<RateKind>, mode: RoundingMode): Money<'INR'> {
  if (usdt.currency !== 'USDT') throw new DomainError('CURRENCY_MISMATCH', 'expected USDT');
  if (usdt.isNegative()) throw new DomainError('NEGATIVE_AMOUNT');
  return Money.ofMinor(divRound(usdt.minor * rate.micro, SCALE, mode), 'INR');
}

/** usdt_minor = round(inr_minor × 10¹⁰ / rate_micro, mode) — FINANCIAL_INVARIANTS §1.2 */
export function inrToUsdt(inr: Money<'INR'>, rate: Rate<RateKind>, mode: RoundingMode): Money<'USDT'> {
  if (inr.currency !== 'INR') throw new DomainError('CURRENCY_MISMATCH', 'expected INR');
  if (inr.isNegative()) throw new DomainError('NEGATIVE_AMOUNT');
  return Money.ofMinor(divRound(inr.minor * SCALE, rate.micro, mode), 'USDT');
}
