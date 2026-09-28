import { Money, Rate } from '@inrp2p/kernel';
import { formatInr, formatInrCompact, formatIstDate, formatIstDateTime, formatIstTime, formatRate, formatUsdt, formatUsdtCompact, formatUsdtHeadline } from '@inrp2p/ui/format';

/**
 * The desk's formatting, on top of the design system's deterministic formatters (DECISIONS D-11). Every read model
 * hands out decimal strings; these parse them back into `Money`/`Rate` — which re-asserts the currency — and never
 * go near a float or the runtime locale.
 */
export type Asset = 'INR' | 'USDT';

export const inr = (amount: string, opts: { sign?: boolean; paise?: boolean } = {}): string =>
  formatInr(Money.parse(amount, 'INR'), { ...(opts.sign ? { sign: 'always' as const } : {}), ...(opts.paise ? { fraction: 'always' as const } : {}) });

/** USDT to two places (summary) unless `exact`; whole-number amounts drop the zeros ("100,000 USDT"). */
export const usdt = (amount: string, opts: { exact?: boolean; unit?: boolean } = {}): string => {
  const m = Money.parse(amount, 'USDT');
  const unit = opts.unit ?? true;
  if (opts.exact) return formatUsdt(m, { precision: 'exact', unit });
  const headline = formatUsdtHeadline(m, { unit });
  return headline.includes('.') ? formatUsdt(m, { unit }) : headline;
};

export const money = (amount: string, asset: Asset, opts: { exact?: boolean } = {}): string => (asset === 'INR' ? inr(amount) : usdt(amount, opts));

export const inrCompact = (amount: string): string => formatInrCompact(Money.parse(amount, 'INR'));
export const usdtCompact = (amount: string): string => `${formatUsdtCompact(Money.parse(amount, 'USDT'))} USDT`;

/** Rates keep every stored decimal beyond two (₹102.125), and never gain one. */
export const rate = (value: string): string => formatRate(Rate.parse(value, 'REFERENCE'));

/** Difference between two rates, signed, as a rate ("+₹0.20"). */
export function rateDelta(next: string, previous: string): { text: string; sign: -1 | 0 | 1 } {
  const a = Rate.parse(next, 'REFERENCE').micro;
  const b = Rate.parse(previous, 'REFERENCE').micro;
  const d = a - b;
  if (d === 0n) return { text: '±₹0.00', sign: 0 };
  const abs = d < 0n ? -d : d;
  return { text: `${d < 0n ? '−' : '+'}${formatRate(Rate.ofMicro(abs, 'REFERENCE'))}`, sign: d < 0n ? -1 : 1 };
}

export const isPositive = (amount: string, asset: Asset): boolean => Money.parse(amount, asset).isPositive();
export const isNegative = (amount: string, asset: Asset): boolean => Money.parse(amount, asset).isNegative();
export const sub = (a: string, b: string, asset: Asset): string => Money.parse(a, asset).sub(Money.parse(b, asset)).toDecimalString();

/** Whole-percent share of `part` in `whole`, clamped 0–100, exact integer arithmetic (for meters only). */
export function share(part: string, whole: string, asset: Asset): number {
  const p = Money.parse(part, asset).minor;
  const w = Money.parse(whole, asset).minor;
  if (w <= 0n || p <= 0n) return 0;
  const pct = (p * 1000n) / w;
  return Math.min(100, Number(pct) / 10);
}

export const side = (direction: string): 'SELL' | 'BUY' => (direction === 'SELL_USDT' ? 'SELL' : 'BUY');
export const pair = (direction: string): string => (direction === 'SELL_USDT' ? 'USDT → INR' : 'INR → USDT');
export const payoutAsset = (direction: string): Asset => (direction === 'SELL_USDT' ? 'INR' : 'USDT');
export const receivableAsset = (direction: string): Asset => (direction === 'SELL_USDT' ? 'USDT' : 'INR');

export const time = (iso: string): string => formatIstTime(new Date(iso));
export const dateTime = (iso: string): string => formatIstDateTime(new Date(iso));
export const date = (iso: string): string => formatIstDate(new Date(iso));

/** "just now", "12 min", "3 h 20 min", "4 d" — elapsed between two instants, never negative. */
export function age(fromIso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} d`;
}

/** Compact age for table cells: "12m", "3h", "4d". */
export function ageShort(fromIso: string, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function countdown(toIso: string, nowMs: number): { text: string; seconds: number } {
  const total = Math.max(0, Math.floor((new Date(toIso).getTime() - nowMs) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  return { text: `${pad(Math.floor(total / 60))}:${pad(total % 60)}`, seconds: total };
}

export const LIFECYCLE: Record<string, string> = {
  AWAITING_FIRST_LEG: 'Awaiting client funds',
  FIRST_LEG_DETECTED: 'Funds detected',
  FIRST_LEG_CONFIRMED: 'Funds confirmed',
  SETTLING: 'Settling',
  PARTIALLY_SETTLED: 'Partially settled',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const titleCase = (value: string): string => value.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Plain words for an exception type ("Short payment", not "USDT_WRONG_AMOUNT"). */
export const CASE_TITLE: Record<string, string> = {
  USDT_WRONG_AMOUNT: 'Wrong amount received',
  USDT_OVERPAYMENT: 'Overpayment',
  USDT_UNEXPECTED_SENDER: 'Unregistered sender',
  WRONG_NETWORK: 'Sent on the wrong network',
  TX_NOT_FINAL: 'Transaction not final',
  ROUTE_DIRECT_PAYOUT_MISMATCH: 'Route payout mismatch',
  FUNDS_AFTER_TRADE_CLOSED: 'Funds after the trade closed',
  UNALLOCATED_DEPOSIT: 'Unallocated deposit',
  DEPOSIT_POOL_LOW: 'Deposit address pool low',
  ROUTE_SETTLEMENT_MISMATCH: 'Route settlement mismatch',
  ROUTE_OBLIGATION_OVERDUE: 'Route obligation overdue',
  DUPLICATE_TX_HASH: 'Duplicate transaction',
  DUPLICATE_UTR: 'Duplicate UTR',
  PARTIAL_INR_PAYOUT: 'Partial INR payout',
  INR_PAYOUT_DELAYED: 'Payout delayed',
  BANK_TRANSFER_FAILED: 'Bank transfer failed',
  CLIENT_BANK_CHANGED: 'Client bank account changed',
  ROUTE_CAPACITY_CHANGED: 'Route capacity changed',
  TRADE_CANCELLATION: 'Cancellation requested',
  OPERATOR_MISTAKE: 'Operator correction',
  RECONCILIATION_MISMATCH: 'Reconciliation mismatch',
};

export const caseTitle = (type: string): string => CASE_TITLE[type] ?? titleCase(type);

/** A case's details as label/value pairs an operator can read, amounts formatted where the key says what they are. */
export function caseDetails(details: Record<string, unknown>): { label: string; value: string }[] {
  return Object.entries(details)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    .map(([k, v]) => ({ label: titleCase(k.replace(/([a-z])([A-Z])/g, '$1_$2')), value: String(v) }));
}

/** An amount as typed ("100." while typing) parsed if it is complete, else null — never throws mid-keystroke. */
export function parseAmount<A extends Asset>(value: string, asset: A): Money<A> | null {
  if (value === '' || value.endsWith('.')) return null;
  try {
    return Money.parse(value, asset);
  } catch {
    return null;
  }
}

/** The quoting policy's own limit (desk `deskRequest` default): past it, a quote on that rate is refused. */
export const ROUTE_RATE_STALE_SECONDS = 15 * 60;
