import { Money } from '@inrp2p/kernel';
import { formatInr, formatUsdtHeadline } from '@inrp2p/ui/format';
import type { Currency } from './Legs.tsx';

/** An amount for a leg's box, whose currency tag already names the unit: "25,000", "2,550,000.50". */
export function legAmount(amount: string, currency: Currency): string {
  return currency === 'USDT' ? formatUsdtHeadline(Money.parse(amount, 'USDT'), { unit: false }) : formatInr(Money.parse(amount, 'INR')).replace('₹', '');
}
