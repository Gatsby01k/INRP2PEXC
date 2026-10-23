import { DomainError } from './errors.ts';
import { inrToUsdt, usdtToInr } from './conversion.ts';
import { Money } from './money.ts';
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
  /**
   * P2P (ADR 0019) only: the USDT the trader delivers (client buys) or receives (client sells), and the exchange's margin
   * in USDT — the rupees move once, straight between client and trader, so `routeInr = clientInr` and `grossMargin` is 0.
   */
  readonly routeBase?: Money<'USDT'>;
  readonly grossMarginBase?: Money<'USDT'>;
  /**
   * A desk's deal (ADR 0020, FI-99) only: the platform's fee in USDT — the part of `grossMarginBase` that is INRP2P's. On a
   * deal the desk fills itself it is the whole margin.
   */
  readonly platformFeeBase?: Money<'USDT'>;
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
    assertPriceable(base, clientInr, routeInr);
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
  assertPriceable(base, clientInr, routeInr);
  return Object.freeze({ direction, fixedSide: input.fixedSide, base, clientInr, routeInr, grossMargin: clientInr.sub(routeInr) });
}

/**
 * A trade needs something on every side: an amount so small that one side rounds to zero (a few micro-USDT, a
 * paisa at an extreme rate) is not a trade, and is refused here rather than by a database constraint later.
 */
function assertPriceable(base: Money<'USDT'>, clientInr: Money<'INR'>, routeInr: Money<'INR'>): void {
  if (!base.isPositive() || !clientInr.isPositive() || !routeInr.isPositive()) {
    throw new DomainError('INVALID_AMOUNT', 'amount is too small to price at these rates');
  }
}

/**
 * P2P economics (ADR 0019, FI-97): the client pays (or receives) exactly the rupees the trader receives (or pays), so
 * there is one rupee amount; the exchange's margin is the USDT between the client's amount and the trader's. Rounding
 * still goes against whoever is paid: the client's rupees as in `computeTradeEconomics`, the trader's USDT so the
 * exchange never gives more (client sells: DOWN) nor takes less (client buys: UP) than the trader's own rate says.
 */
export function computeP2pEconomics(input: EconomicsInput): TradeEconomics & { readonly routeBase: Money<'USDT'>; readonly grossMarginBase: Money<'USDT'> } {
  const { direction, clientRate, routeRate } = input;
  if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'amount must be positive');
  const buy = direction === 'BUY_USDT';
  let base: Money<'USDT'>;
  let inr: Money<'INR'>;
  if (input.fixedSide === 'BASE') {
    base = input.amount;
    inr = usdtToInr(base, clientRate, buy ? 'UP' : 'DOWN');
  } else {
    inr = input.amount;
    base = inrToUsdt(inr, clientRate, buy ? 'DOWN' : 'UP');
  }
  const routeBase = inrToUsdt(inr, routeRate, buy ? 'UP' : 'DOWN');
  assertPriceable(base, inr, inr);
  if (!routeBase.isPositive()) throw new DomainError('INVALID_AMOUNT', 'amount is too small to price at these rates');
  const grossMarginBase = buy ? routeBase.sub(base) : base.sub(routeBase);
  return Object.freeze({ direction, fixedSide: input.fixedSide, base, clientInr: inr, routeInr: inr, grossMargin: inr.sub(inr), routeBase, grossMarginBase });
}

/**
 * The platform's fee on a desk's deal (ADR 0020, FI-99): `bps` basis points of the deal's USDT, rounded up — the desk pays
 * it, and what a payer owes is rounded against it (FINANCIAL_INVARIANTS §1.2). The database recomputes it the same way.
 */
export function platformFeeOf(base: Money<'USDT'>, bps: number): Money<'USDT'> {
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000) throw new DomainError('INVALID_ARGUMENT', 'fee basis points must be a whole number from 0 to 1000', { field: 'feeBps' });
  if (base.isNegative()) throw new DomainError('INVALID_AMOUNT', 'a fee is charged on a positive amount');
  return Money.ofMinor((base.minor * BigInt(bps) + 9999n) / 10000n, 'USDT');
}

export type DeskEconomicsInput =
  | { direction: Direction; fixedSide: 'BASE'; amount: Money<'USDT'>; clientRate: ClientRate; feeBps: number }
  | { direction: Direction; fixedSide: 'QUOTE'; amount: Money<'INR'>; clientRate: ClientRate; feeBps: number };

export type DeskEconomics = TradeEconomics & { readonly routeBase: Money<'USDT'>; readonly grossMarginBase: Money<'USDT'>; readonly platformFeeBase: Money<'USDT'> };

/**
 * A deal a desk fills with its own liquidity (ADR 0020, FI-99). It runs P2P (ADR 0019): one rupee amount, straight between
 * the client and the desk, at the desk's own rate — rounded against the client as always. The desk's USDT differs from the
 * client's only by the platform's fee, taken from the escrow: a client selling sends `base` and the desk receives
 * `base − fee`; a client buying receives `base` and the desk delivers `base + fee`. The fee is the deal's whole margin.
 */
export function computeDeskEconomics(input: DeskEconomicsInput): DeskEconomics {
  const { direction, clientRate } = input;
  if (!input.amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'amount must be positive');
  const buy = direction === 'BUY_USDT';
  let base: Money<'USDT'>;
  let inr: Money<'INR'>;
  if (input.fixedSide === 'BASE') {
    base = input.amount;
    inr = usdtToInr(base, clientRate, buy ? 'UP' : 'DOWN');
  } else {
    inr = input.amount;
    base = inrToUsdt(inr, clientRate, buy ? 'DOWN' : 'UP');
  }
  assertPriceable(base, inr, inr);
  const fee = platformFeeOf(base, input.feeBps);
  const routeBase = buy ? base.add(fee) : base.sub(fee);
  if (!routeBase.isPositive()) throw new DomainError('INVALID_AMOUNT', 'amount is too small to carry the platform fee');
  return Object.freeze({ direction, fixedSide: input.fixedSide, base, clientInr: inr, routeInr: inr, grossMargin: inr.sub(inr), routeBase, grossMarginBase: fee, platformFeeBase: fee });
}
