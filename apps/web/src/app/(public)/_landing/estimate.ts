import { Money, Rate } from '@inrp2p/kernel';
import { groupDigits } from '@inrp2p/ui/format';

/** What the converter prints at the market's rate: whole rupees, grouped (D-11), and the rate to the paisa. */
export interface MarketEstimate {
  readonly rupees: string;
  readonly rate: string;
}

/**
 * The rupees an amount of USDT comes to at the market's rate, rounded to the rupee — an estimate, never a price: the
 * converter marks it as one and the firm price still comes from a quote. Null when there is no amount or no rate.
 */
export function marketEstimate(amount: string, rate: string | null): MarketEstimate | null {
  if (!rate || !/[1-9]/.test(amount)) return null;
  let usdtMinor: bigint;
  let rateMicro: bigint;
  try {
    usdtMinor = Money.parse(amount, 'USDT').minor;
    rateMicro = Rate.parse(rate, 'REFERENCE').micro;
  } catch {
    return null;
  }
  if (usdtMinor <= 0n || rateMicro <= 0n) return null;
  // USDT in millionths × rupees per USDT in millionths: rupees in 10⁻¹², to the nearest rupee.
  const rupees = (usdtMinor * rateMicro + 500_000_000_000n) / 1_000_000_000_000n;
  const [whole = '0', fraction = ''] = rate.split('.');
  return { rupees: groupDigits(rupees.toString()), rate: `${groupDigits(whole)}.${(fraction + '00').slice(0, 2)}` };
}
