import { type CurrencyCode, exponentOf } from '@inrp2p/kernel';

/**
 * Exact amount entry. Accepts only digits and one decimal point, and refuses to accept more
 * fractional digits than the currency has — it never rounds what a person typed.
 */
export function sanitizeAmountInput(raw: string, currency: CurrencyCode): string | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (cleaned === '') return '';
  const m = /^(\d*)(\.(\d*))?$/.exec(cleaned);
  if (!m) return null;
  const whole = (m[1] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = m[3];
  if (fraction !== undefined && fraction.length > exponentOf(currency)) return null;
  if (whole.length > 15) return null;
  return fraction === undefined ? whole : `${whole || '0'}.${fraction}`;
}
