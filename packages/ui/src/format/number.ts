import { divRound, formatMinorToDecimal, pow10, type RoundingMode } from '@inrp2p/kernel';

/**
 * Locale-independent display formatting (DECISIONS D-11). No Intl, no floating point:
 * all values arrive as bigint minor units and are grouped with international three-digit
 * separators. Formatting never feeds back into computation.
 */
export function groupDigits(integerDigits: string): string {
  if (!/^\d+$/.test(integerDigits)) throw new Error(`expected digits, got "${integerDigits}"`);
  let out = '';
  for (let i = 0; i < integerDigits.length; i++) {
    const fromEnd = integerDigits.length - i;
    out += integerDigits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ',';
  }
  return out;
}

export interface DecimalDisplay {
  negative: boolean;
  whole: string;
  fraction: string;
}

/** Splits minor units into grouped whole part and fraction digits at `exponent`. */
export function splitMinor(minor: bigint, exponent: number): DecimalDisplay {
  const plain = formatMinorToDecimal(minor < 0n ? -minor : minor, exponent);
  const [whole = '0', fraction = ''] = plain.split('.');
  return { negative: minor < 0n, whole: groupDigits(whole), fraction };
}

/** Re-scales minor units to fewer decimals for display (e.g. USDT 6 dp → 2 dp summaries). */
export function rescaleMinor(minor: bigint, fromExponent: number, toExponent: number, mode: RoundingMode = 'HALF_EVEN'): bigint {
  if (toExponent >= fromExponent) return minor * pow10(toExponent - fromExponent);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const r = divRound(abs, pow10(fromExponent - toExponent), mode);
  return negative ? -r : r;
}

/** Integer percentage with two decimals, computed exactly: e.g. 45000n/102000n → "44.12". Clamped to 0–100. */
export function percentString(part: bigint, whole: bigint): string {
  if (whole <= 0n || part <= 0n) return '0.00';
  if (part >= whole) return '100.00';
  const basisHundredths = divRound(part * 10000n, whole, 'DOWN');
  return formatMinorToDecimal(basisHundredths, 2);
}
