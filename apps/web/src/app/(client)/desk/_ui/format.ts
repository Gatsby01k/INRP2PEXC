import { Money, Rate, type DeskEconomics, computeDeskEconomics, isDomainError } from '@inrp2p/kernel';
import { formatInr, formatInrCompact, splitMinor } from '@inrp2p/ui/format';

/**
 * Figures on the desk's screens. Every amount arrives as the decimal string of record and is only formatted here: rupees
 * with paise only when there are some, USDT with the decimals it has (at least two when it has any), rates in rupees.
 */
export const inr = (amount: string) => formatInr(Money.parse(amount, 'INR'));
export const inrShort = (amount: string) => formatInrCompact(Money.parse(amount, 'INR'));

export function usdt(amount: string, unit = true): string {
  const d = splitMinor(Money.parse(amount, 'USDT').minor, 6);
  const kept = d.fraction.replace(/0+$/, '');
  const fraction = kept ? `.${kept.length < 2 ? kept.padEnd(2, '0') : kept}` : '';
  return `${d.negative ? '−' : ''}${d.whole}${fraction}${unit ? ' USDT' : ''}`;
}

/** A balance at a glance — capacity, a deposit — to the cent, never rounded up: 17,173.28 USDT. */
export function usdtShort(amount: string): string {
  const d = splitMinor(Money.parse(amount, 'USDT').minor, 6);
  const cents = d.fraction.slice(0, 2);
  return `${d.negative ? '−' : ''}${d.whole}${cents === '00' ? '' : `.${cents}`} USDT`;
}

export function rate(value: string): string {
  const d = splitMinor(Rate.parse(value, 'CLIENT').micro, 6);
  return `₹${d.whole}.${d.fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

export const isZero = (amount: string) => !/[1-9]/.test(amount);

/** What the desk asks over what it pays, per USDT: its spread, signed when it is upside down. */
export function rateGap(ask: string, bid: string): string {
  const diff = Rate.parse(ask, 'CLIENT').micro - Rate.parse(bid, 'CLIENT').micro;
  const d = splitMinor(diff < 0n ? -diff : diff, 6);
  return `${diff < 0n ? '−' : ''}₹${d.whole}.${d.fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

/** The client's direction, as the desk says it: a client selling USDT is the desk buying it. */
export const DESK_SIDE = {
  SELL_USDT: { you: 'You buy USDT', short: 'Buys', client: 'Client sells USDT', verb: 'sells' },
  BUY_USDT: { you: 'You sell USDT', short: 'Sells', client: 'Client buys USDT', verb: 'buys' },
} as const;

export const initial = (name: string) => name.trim().charAt(0).toUpperCase() || '·';

/** Domain refusals arrive as clauses; shown as sentences. */
export function sentence(message: string): string {
  const t = message.trim();
  if (!t) return t;
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

/** "in 12 min", "in 3 h", "2 h ago" — for times a person reads at a glance. */
export function relative(target: number, now: number): string {
  const diff = target - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const text = minutes < 1 ? 'a moment' : minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** What a deal at these terms comes to, as the quote will price it — or why it cannot be priced. */
export function previewDeal(input: { direction: 'SELL_USDT' | 'BUY_USDT'; fixedSide: 'BASE' | 'QUOTE'; amount: string; rate: string; feeBps: number }): DeskEconomics | string | null {
  if (!input.amount.trim() || !input.rate.trim()) return null;
  try {
    const clientRate = Rate.parse(input.rate.trim(), 'CLIENT');
    if (clientRate.micro <= 0n) return 'Enter a rate above zero.';
    return input.fixedSide === 'BASE'
      ? computeDeskEconomics({ direction: input.direction, fixedSide: 'BASE', amount: Money.parse(input.amount.trim(), 'USDT'), clientRate, feeBps: input.feeBps })
      : computeDeskEconomics({ direction: input.direction, fixedSide: 'QUOTE', amount: Money.parse(input.amount.trim(), 'INR'), clientRate, feeBps: input.feeBps });
  } catch (e) {
    if (isDomainError(e)) return e.code === 'INVALID_AMOUNT' ? 'That amount is too small for a deal.' : 'Check the amount and the rate.';
    return 'Check the amount and the rate.';
  }
}

/** The fee in percent, the way a person says it: 25 basis points → "0.25%". */
export const percent = (bps: number) => `${(bps / 100).toFixed(2).replace(/0$/, '')}%`;
