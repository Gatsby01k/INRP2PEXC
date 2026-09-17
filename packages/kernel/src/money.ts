import { DomainError } from './errors.ts';
import { type CurrencyCode, exponentOf, isCurrencyCode } from './currency.ts';
import { formatMinorToDecimal, parseDecimalToMinor } from './decimal.ts';

/**
 * Exact money value in integer minor units. Deliberately has no numeric coercion:
 * `valueOf`/`Symbol.toPrimitive` throw so money can never silently become a JS number.
 */
export class Money<C extends CurrencyCode = CurrencyCode> {
  readonly minor: bigint;
  readonly currency: C;

  private constructor(minor: bigint, currency: C) {
    if (typeof minor !== 'bigint') throw new DomainError('INVALID_AMOUNT', 'minor units must be bigint');
    if (!isCurrencyCode(currency)) throw new DomainError('INVALID_ARGUMENT', `unknown currency ${String(currency)}`);
    this.minor = minor;
    this.currency = currency;
    Object.freeze(this);
  }

  static ofMinor<C extends CurrencyCode>(minor: bigint, currency: C): Money<C> {
    return new Money(minor, currency);
  }

  static parse<C extends CurrencyCode>(decimal: string, currency: C): Money<C> {
    return new Money(parseDecimalToMinor(decimal, exponentOf(currency)), currency);
  }

  static zero<C extends CurrencyCode>(currency: C): Money<C> {
    return new Money(0n, currency);
  }

  private same(other: Money): void {
    if (other.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', `${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money<C>): Money<C> {
    this.same(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  sub(other: Money<C>): Money<C> {
    this.same(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money<C> {
    return new Money(-this.minor, this.currency);
  }

  compare(other: Money<C>): -1 | 0 | 1 {
    this.same(other);
    return this.minor < other.minor ? -1 : this.minor > other.minor ? 1 : 0;
  }

  equals(other: Money): boolean {
    return other.currency === this.currency && other.minor === this.minor;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  /** Ungrouped decimal string, e.g. "10200000.00". Display formatting lives in the UI package. */
  toDecimalString(): string {
    return formatMinorToDecimal(this.minor, exponentOf(this.currency));
  }

  toJSON(): { amount: string; currency: C } {
    return { amount: this.toDecimalString(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimalString()} ${this.currency}`;
  }

  valueOf(): never {
    throw new TypeError('Money cannot be coerced to a number');
  }

  [Symbol.toPrimitive](hint: string): string {
    if (hint === 'string') return this.toString();
    throw new TypeError('Money cannot be coerced to a number');
  }
}
