/**
 * Pure input arithmetic for the desk's fields, kept apart from the components so it can be tested on its own.
 * Everything is string and bigint: a rate a dealer types is never a float.
 */

/** Rates carry up to six decimals (micro units); a dealer types two or four, and nothing is ever rounded. */
export function sanitizeRateInput(raw: string): string | null {
  const cleaned = raw.replace(/[,\s₹]/g, '');
  if (cleaned === '') return '';
  const m = /^(\d*)(\.(\d*))?$/.exec(cleaned);
  if (!m) return null;
  const whole = (m[1] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = m[3];
  if (fraction !== undefined && fraction.length > 6) return null;
  if (whole.length > 6) return null;
  return fraction === undefined ? whole : `${whole || '0'}.${fraction}`;
}

/** Steps a rate by `stepMicro` in exact integer micro units, keeping at least two decimals. */
export function stepRate(value: string, stepMicro: bigint): string {
  const m = /^(\d+)(?:\.(\d{0,6}))?$/.exec(value === '' ? '0' : value.endsWith('.') ? `${value}0` : value);
  if (!m) return value;
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0') + stepMicro;
  if (micro <= 0n) return value;
  const whole = micro / 1_000_000n;
  const digits = (micro % 1_000_000n).toString().padStart(6, '0');
  const keep = Math.max(2, digits.replace(/0+$/, '').length, (m[2] ?? '').length);
  return `${whole}.${digits.slice(0, keep)}`;
}
