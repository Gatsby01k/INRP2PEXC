import { DomainError } from './errors.ts';
import { RATE_EXPONENT } from './currency.ts';
import { formatMinorToDecimal, parseDecimalToMinor } from './decimal.ts';

/** The three price concepts are distinct types and can never be assigned to each other (FI-01). */
export type RateKind = 'CLIENT' | 'ROUTE' | 'REFERENCE';

export class Rate<K extends RateKind> {
  /** INR per 1 USDT in micro-rupees (10⁻⁶ INR). */
  readonly micro: bigint;
  readonly kind: K;

  private constructor(micro: bigint, kind: K) {
    if (typeof micro !== 'bigint' || micro <= 0n) throw new DomainError('INVALID_RATE', 'rate must be a positive bigint');
    this.micro = micro;
    this.kind = kind;
    Object.freeze(this);
  }

  static parse<K extends RateKind>(decimal: string, kind: K): Rate<K> {
    return new Rate(parseDecimalToMinor(decimal, RATE_EXPONENT), kind);
  }

  static ofMicro<K extends RateKind>(micro: bigint, kind: K): Rate<K> {
    return new Rate(micro, kind);
  }

  toDecimalString(): string {
    return formatMinorToDecimal(this.micro, RATE_EXPONENT);
  }

  toJSON(): { rate: string; kind: K } {
    return { rate: this.toDecimalString(), kind: this.kind };
  }

  valueOf(): never {
    throw new TypeError('Rate cannot be coerced to a number');
  }
}

export type ClientRate = Rate<'CLIENT'>;
export type RouteRate = Rate<'ROUTE'>;
export type ReferenceRate = Rate<'REFERENCE'>;
