import { DomainError, Money, type ClientRate, type Rate, type RateKind, RATE_EXPONENT, divRound, exponentOf } from '@inrp2p/kernel';
import { rescaleMinor, splitMinor } from './number.ts';

export type InrFraction = 'auto' | 'always' | 'never';

/**
 * INR with international grouping: ₹10,200,000 · ₹10,200,000.00.
 * `auto` shows paise only when non-zero; `always` for receipts and evidence rows.
 * `never` is only allowed when paise are zero — it never silently hides money.
 */
export function formatInr(amount: Money<'INR'>, opts: { fraction?: InrFraction; sign?: 'auto' | 'always' } = {}): string {
  if (amount.currency !== 'INR') throw new DomainError('CURRENCY_MISMATCH', 'formatInr expects INR');
  const mode = opts.fraction ?? 'auto';
  const d = splitMinor(amount.minor, exponentOf('INR'));
  const hasPaise = d.fraction !== '00';
  if (mode === 'never' && hasPaise) throw new DomainError('INVALID_AMOUNT_PRECISION', 'cannot hide non-zero paise');
  const body = mode === 'always' || (mode === 'auto' && hasPaise) ? `${d.whole}.${d.fraction}` : d.whole;
  const sign = d.negative ? '−' : opts.sign === 'always' && amount.minor > 0n ? '+' : '';
  return `${sign}₹${body}`;
}

export type UsdtPrecision = 'summary' | 'exact';

/** USDT: 2 dp in summaries (display rounding HALF_EVEN), full 6 dp in deposit instructions and receipts. */
export function formatUsdt(amount: Money<'USDT'>, opts: { precision?: UsdtPrecision; unit?: boolean } = {}): string {
  if (amount.currency !== 'USDT') throw new DomainError('CURRENCY_MISMATCH', 'formatUsdt expects USDT');
  const exact = (opts.precision ?? 'summary') === 'exact';
  const exp = exact ? exponentOf('USDT') : 2;
  const minor = exact ? amount.minor : rescaleMinor(amount.minor, exponentOf('USDT'), 2);
  const d = splitMinor(minor, exp);
  const unit = opts.unit === false ? '' : ' USDT';
  return `${d.negative ? '−' : ''}${d.whole}.${d.fraction}${unit}`;
}

/** Whole-unit USDT for headline amounts where the value is integral: "100,000 USDT". Falls back to summary precision. */
export function formatUsdtHeadline(amount: Money<'USDT'>, opts: { unit?: boolean } = {}): string {
  const d = splitMinor(amount.minor, exponentOf('USDT'));
  if (/^0+$/.test(d.fraction)) return `${d.negative ? '−' : ''}${d.whole}${opts.unit === false ? '' : ' USDT'}`;
  return formatUsdt(amount, { precision: 'exact', ...(opts.unit === undefined ? {} : { unit: opts.unit }) });
}

/**
 * Rates are shown with at least 2 decimals and never lose stored precision:
 * 102000000 → ₹102.00 · 102125000 → ₹102.125 · 102123456 → ₹102.123456.
 */
export function formatRate(rate: Rate<RateKind>, opts: { unit?: boolean } = {}): string {
  const d = splitMinor(rate.micro, RATE_EXPONENT);
  const fraction = d.fraction.replace(/0+$/, '').padEnd(2, '0');
  return `₹${d.whole}.${fraction}${opts.unit ? ' / USDT' : ''}`;
}

export function formatClientRate(rate: ClientRate): string {
  return formatRate(rate);
}

const COMPACT_UNITS: readonly (readonly [bigint, string])[] = [
  [1_000_000_000n, 'B'],
  [1_000_000n, 'M'],
  [1_000n, 'k'],
];

/** One-decimal compact form of a non-negative whole number, rounded HALF_EVEN, unit promoted after rounding. */
function compactWhole(whole: bigint): string | null {
  // COMPACT_UNITS is ordered large → small; start at the largest unit not exceeding the value.
  let i = COMPACT_UNITS.findIndex(([divisor]) => whole >= divisor);
  if (i === -1) return null;
  for (;;) {
    const [divisor, suffix] = COMPACT_UNITS[i]!;
    const tenths = divRound(whole * 10n, divisor, 'HALF_EVEN');
    const bigger = COMPACT_UNITS[i - 1];
    if (bigger && tenths >= (bigger[0] / divisor) * 10n) {
      i -= 1;
      continue;
    }
    return `${tenths / 10n}${tenths % 10n === 0n ? '' : `.${tenths % 10n}`}${suffix}`;
  }
}

/**
 * Compact INR for summaries only (brief: "₹6.5M received", "₹800k"). Exact figures are
 * required wherever the amount is evidence (legs, receipts, quotes).
 */
export function formatInrCompact(amount: Money<'INR'>): string {
  const negative = amount.minor < 0n;
  const rupees = rescaleMinor(negative ? -amount.minor : amount.minor, 2, 0);
  const c = compactWhole(rupees);
  return c === null ? formatInr(amount) : `${negative ? '−' : ''}₹${c}`;
}

export function formatUsdtCompact(amount: Money<'USDT'>): string {
  const negative = amount.minor < 0n;
  const whole = rescaleMinor(negative ? -amount.minor : amount.minor, 6, 0);
  const c = compactWhole(whole);
  return c === null ? formatUsdt(amount, { unit: false }) : `${negative ? '−' : ''}${c}`;
}

export { Money };
