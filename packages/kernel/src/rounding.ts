import { DomainError } from './errors.ts';

export type RoundingMode = 'DOWN' | 'UP' | 'HALF_EVEN';

/**
 * Exact integer division with one explicit rounding step. Money conversions only ever
 * divide non-negative numerators by positive denominators.
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new DomainError('INVALID_ARGUMENT', 'denominator must be positive');
  if (numerator < 0n) throw new DomainError('NEGATIVE_AMOUNT', 'numerator must be non-negative');
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r === 0n) return q;
  switch (mode) {
    case 'DOWN':
      return q;
    case 'UP':
      return q + 1n;
    case 'HALF_EVEN': {
      const twice = r * 2n;
      if (twice > denominator) return q + 1n;
      if (twice < denominator) return q;
      return q % 2n === 0n ? q : q + 1n;
    }
  }
}
