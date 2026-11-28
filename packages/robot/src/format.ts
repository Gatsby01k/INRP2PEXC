import { Money, Rate } from '@inrp2p/kernel';

/**
 * Figures as the robot says them: international three-digit grouping, locale-free (D-11), never rounded up into a
 * promise. A USDT amount drops trailing zeros ("1,250.5 USDT"); rupees show paise only when there are any; a rate keeps
 * two decimals ("₹96.40").
 */
const group = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function usdtWords(decimal: string): string {
  const [whole = '0', fraction = ''] = Money.parse(decimal, 'USDT').toDecimalString().split('.');
  const kept = fraction.replace(/0+$/, '');
  return `${group(whole)}${kept ? `.${kept}` : ''} USDT`;
}

export function inrWords(decimal: string): string {
  const [whole = '0', paise = ''] = Money.parse(decimal, 'INR').toDecimalString().split('.');
  return `₹${group(whole)}${/[1-9]/.test(paise) ? `.${paise}` : ''}`;
}

export function rateWords(micro: bigint): string {
  const [whole = '0', fraction = ''] = Rate.ofMicro(micro, 'REFERENCE').toDecimalString().split('.');
  const kept = fraction.replace(/0+$/, '');
  return `₹${group(whole)}.${kept.length >= 2 ? kept : kept.padEnd(2, '0')}`;
}

/** An amount in its own currency, as a request carries it. */
export function amountWords(amount: string, currency: 'USDT' | 'INR'): string {
  return currency === 'USDT' ? usdtWords(amount) : inrWords(amount);
}

/** "14:32 IST" — the time in India, 24-hour. */
export function istTime(d: Date): string {
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + 330;
  const m = minutes % 60;
  const h = ((minutes - m) / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

/** A moment as a person in India reads it from now: "16:06 IST", "tomorrow, 16:06 IST", "1 Dec, 16:06 IST". */
export function istWhen(d: Date, now: Date): string {
  const day = (x: Date) => {
    const t = x.getTime() + 330 * 60_000;
    return (t - (t % 86_400_000)) / 86_400_000;
  };
  const diff = day(d) - day(now);
  if (diff === 0) return istTime(d);
  if (diff === 1) return `tomorrow, ${istTime(d)}`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]}, ${istTime(d)}`;
}

/** The hour of the day in India. */
export function istHour(d: Date): number {
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + 330;
  return ((minutes - (minutes % 60)) / 60) % 24;
}

/** A USDT amount in whole units, grouped, for a figure that is said "about": "2,000". */
export function wholeUsdt(minor: bigint): string {
  return group((minor / 1_000_000n).toString());
}
