import { Money, Rate } from '@inrp2p/kernel';
import { formatInr, formatRate, formatUsdtHeadline, splitMinor } from '@inrp2p/ui/format';

/** Display helpers for trader screens: every figure arrives as a decimal string of record and is only formatted here. */
export const inr = (amount: string) => formatInr(Money.parse(amount, 'INR'));
export const usdt = (amount: string) => formatUsdtHeadline(Money.parse(amount, 'USDT'));
export const rate = (value: string) => `${formatRate(Rate.parse(value, 'ROUTE'))} / USDT`;
export const amountIn = (currency: 'INR' | 'USDT', amount: string) => (currency === 'INR' ? inr(amount) : usdt(amount));
/** A balance at a glance — what is available or held — to the cent, never rounded up: 17,173.28 USDT, not 17,173.285171. */
export const balanceIn = (currency: 'INR' | 'USDT', amount: string) => {
  if (currency === 'INR') return inr(amount);
  const d = splitMinor(Money.parse(amount, 'USDT').minor, 6);
  const cents = d.fraction.slice(0, 2);
  return `${d.negative ? '−' : ''}${d.whole}${cents === '00' ? '' : `.${cents}`} USDT`;
};
export const isZero = (amount: string) => !/[1-9]/.test(amount);

/** Domain refusals arrive as clauses ("you can withdraw up to 200 USDT now"); shown as sentences. */
export function sentence(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

export const sideTitle = (side: 'BUY_USDT' | 'SELL_USDT') => (side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT');

/** TRX for reading, grouped, to the hundredth (truncated: a display, never a computation). */
export function trx(amount: string): string {
  const [whole = '0', frac = ''] = amount.replace(/^-/, '').split('.');
  const cents = (frac + '00').slice(0, 2);
  return `${amount.startsWith('-') ? '−' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents === '00' ? '' : `.${cents}`} TRX`;
}
