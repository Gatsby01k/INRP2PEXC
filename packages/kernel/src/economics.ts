import { DomainError } from './errors.ts';
import { inrToUsdt, usdtToInr } from './conversion.ts';
import type { Money } from './money.ts';
import type { ClientRate, RouteRate } from './rate.ts';

export type Direction = 'SELL_USDT' | 'BUY_USDT';
export type FixedSide = 'BASE' | 'QUOTE';

export type EconomicsInput =
  | { direction: Direction; fixedSide: 'BASE'; amount: Money<'USDT'>; clientRate: ClientRate; routeRate: RouteRate }
  | { direction: Direction; fixedSide: 'QUOTE'; amount: Money<'INR'>; clientRate: ClientRate; routeRate: RouteRate };

export interface TradeEconomics {
  readonly direction: Direction;
  readonly fixedSide: FixedSide;
  readonly base: Money<'USDT'>;
  readonly clientInr: Money<'INR'>;
  readonly routeInr: Money<'INR'>;
  /** Derived, never input (FI-02). May be negative; permission to send is checked elsewhere. */
  readonly grossMargin: Money<'INR'>;
}

/**
 * Pure quote economics exactly as FINANCIAL_INVARIANTS §1.3. Rounding is chosen by who pays:
 * amounts the exchange pays round DOWN, amounts the client pays round UP, route value is
 * conservative (SELL proceeds DOWN, BUY cost UP).
 */
export function computeTradeEconomics(input: EconomicsInput): TradeEconomics {
  const { direction, clientRate, routeRate } = input;
  if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'amount must be positive');

  let base: Money<'USDT'>;
  let clientInr: Money<'INR'>;

  if (direction === 'SELL_USDT') {
    if (input.fixedSide === 'BASE') {
      base = input.amount;
      clientInr = usdtToInr(base, clientRate, 'DOWN');
    } else {
      clientInr = input.amount;
      base = inrToUsdt(clientInr, clientRate, 'UP');
    }
    const routeInr = usdtToInr(base, routeRate, 'DOWN');
    return Object.freeze({ direction, fixedSide: input.fixedSide, base, clientInr, routeInr, grossMargin: routeInr.sub(clientInr) });
  }

  if (input.fixedSide === 'BASE') {
    base = input.amount;
    clientInr = usdtToInr(base, clientRate, 'UP');
  } else {
    clientInr = input.amount;
    base = inrToUsdt(clientInr, clientRate, 'DOWN');
  }
  const routeInr = usdtToInr(base, routeRate, 'UP');
  return Object.freeze({ direction, fixedSide: input.fixedSide, base, clientInr, routeInr, grossMargin: clientInr.sub(routeInr) });
}
