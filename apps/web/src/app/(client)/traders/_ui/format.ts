import { Money, Rate } from '@inrp2p/kernel';
import { formatInr, formatRate, formatUsdtHeadline } from '@inrp2p/ui/format';

/** Display helpers for trader screens: every figure arrives as a decimal string of record and is only formatted here. */
export const inr = (amount: string) => formatInr(Money.parse(amount, 'INR'));
export const usdt = (amount: string) => formatUsdtHeadline(Money.parse(amount, 'USDT'));
export const rate = (value: string) => `${formatRate(Rate.parse(value, 'ROUTE'))} / USDT`;
export const amountIn = (currency: 'INR' | 'USDT', amount: string) => (currency === 'INR' ? inr(amount) : usdt(amount));
export const isZero = (amount: string) => !/[1-9]/.test(amount);

/** Domain refusals arrive as clauses ("you can withdraw up to 200 USDT now"); shown as sentences. */
export function sentence(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(first) ? first : `${first}.`;
}

export const sideTitle = (side: 'BUY_USDT' | 'SELL_USDT') => (side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT');
