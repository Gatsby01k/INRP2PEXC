import { DomainError } from './errors.ts';
import { formatMinorToDecimal, parseDecimalToMinor } from './decimal.ts';
import { pow10 } from './currency.ts';
import { type RoundingMode, divRound } from './rounding.ts';

/**
 * TRX amounts, in sun (10⁻⁶ TRX). TRX is never a trade currency: it pays the network for the exchange's own
 * transfers, out of a budget kept apart from every trade's money (ADR 0017). So it is not a `Money` currency — no
 * trade, quote, leg or ledger account is ever in TRX — only plain bigint sun with these helpers.
 */
export const TRX_EXPONENT = 6;

export function parseTrx(decimal: string): bigint {
  const sun = parseDecimalToMinor(decimal, TRX_EXPONENT);
  if (sun < 0n) throw new DomainError('INVALID_AMOUNT', 'a TRX amount is never negative');
  return sun;
}

/** Ungrouped decimal TRX, e.g. "14.123456". */
export const formatTrx = (sun: bigint): string => formatMinorToDecimal(sun, TRX_EXPONENT);

/**
 * The INR (paise) value of `sun` TRX: sun × (USDT per TRX, micro) × (INR per USDT, micro) / 10¹⁶, with one rounding
 * step chosen by who pays — UP for what the client is charged, DOWN for what the exchange pays back.
 */
export function trxToInrMinor(sun: bigint, usdtPerTrxMicro: bigint, inrPerUsdtMicro: bigint, mode: RoundingMode): bigint {
  if (sun < 0n || usdtPerTrxMicro <= 0n || inrPerUsdtMicro <= 0n) throw new DomainError('INVALID_ARGUMENT', 'TRX conversion needs a non-negative amount and positive rates');
  // sun/10⁶ TRX × p/10⁶ USDT/TRX × r/10⁶ INR/USDT × 10² paise/INR
  return divRound(sun * usdtPerTrxMicro * inrPerUsdtMicro, pow10(16), mode);
}

/** The USDT (micro) value of `sun` TRX at `usdtPerTrxMicro`. */
export function trxToUsdtMinor(sun: bigint, usdtPerTrxMicro: bigint, mode: RoundingMode): bigint {
  if (sun < 0n || usdtPerTrxMicro <= 0n) throw new DomainError('INVALID_ARGUMENT', 'TRX conversion needs a non-negative amount and a positive rate');
  return divRound(sun * usdtPerTrxMicro, pow10(6), mode);
}
