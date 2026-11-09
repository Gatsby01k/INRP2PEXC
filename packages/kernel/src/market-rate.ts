import { DomainError } from './errors.ts';
import { divRound } from './rounding.ts';

/** Rupee-paisa per USDT in micro-rupees: the grid a market rate is set on. */
export const MARKET_RATE_STEP_MICRO = 10_000n;
/** The furthest a trader may set its rate from the market, either way: ten percent. */
export const MAX_MARKET_OFFSET_BPS = 1000;

/** The side of a trader: the USDT it buys (paying rupees) or sells (being paid rupees). */
export type TraderSideKind = 'BUY_USDT' | 'SELL_USDT';

export interface MarketRateTerms {
  readonly side: TraderSideKind;
  /** The confirmed market reference of the deals the side fills: the bid for a side buying USDT, the ask for one selling. */
  readonly referenceMicro: bigint;
  /** Where the trader stands against it, in whole basis points: positive is a higher rate, negative a lower one. */
  readonly offsetBps: number;
  /**
   * The trader's own bound, whatever the market does: a side selling USDT never sells below it, a side buying USDT never
   * buys above it. Null when it set none.
   */
  readonly limitMicro: bigint | null;
}

/** Whether a market offset is one a trader may stand behind. */
export function assertMarketOffset(offsetBps: number): void {
  if (!Number.isInteger(offsetBps) || offsetBps < -MAX_MARKET_OFFSET_BPS || offsetBps > MAX_MARKET_OFFSET_BPS) {
    throw new DomainError('INVALID_ARGUMENT', `a market rate is set within ${MAX_MARKET_OFFSET_BPS / 100}% of the market, in whole basis points`, { field: 'marketOffset' });
  }
}

/**
 * A trader's market rate (ADR 0028): the market reference of the deals its side fills, moved by the trader's own offset,
 * put on the rupee-paisa grid in the trader's favour (up for a side being paid rupees, down for one paying them) and held
 * at the trader's own bound. It is the trader's standing instruction applied to one confirmed reference — the only way a
 * route rate is ever derived from a reference (FI-01) — and the database derives it the same way (IX143).
 */
export function marketRateMicro(terms: MarketRateTerms): bigint {
  assertMarketOffset(terms.offsetBps);
  if (terms.referenceMicro <= 0n) throw new DomainError('INVALID_RATE', 'the market reference must be positive');
  if (terms.limitMicro !== null && terms.limitMicro <= 0n) throw new DomainError('INVALID_RATE', 'a rate limit must be positive');
  const sells = terms.side === 'SELL_USDT';
  const scaled = terms.referenceMicro * BigInt(10_000 + terms.offsetBps);
  const pegged = divRound(scaled, 10_000n * MARKET_RATE_STEP_MICRO, sells ? 'UP' : 'DOWN') * MARKET_RATE_STEP_MICRO;
  if (terms.limitMicro === null) return pegged;
  return sells ? (pegged < terms.limitMicro ? terms.limitMicro : pegged) : (pegged > terms.limitMicro ? terms.limitMicro : pegged);
}

/** One confirmed market reference a market rate may be derived from: its snapshot, and its rate. */
export interface MarketReference {
  readonly snapshotId: string;
  readonly micro: bigint;
}

/**
 * The market references fresh enough to price on, by the direction of the client's deal: the bid (`SELL_USDT`) and the
 * ask (`BUY_USDT`). A side buying USDT fills clients who sell, so its market rate is set against the bid; a side selling
 * USDT against the ask. Null for a direction whose reference is missing or too old — a market rate then has no rate.
 */
export interface MarketReferences {
  readonly SELL_USDT: MarketReference | null;
  readonly BUY_USDT: MarketReference | null;
}

/** No market to set a rate against: what a reader passes when it never needs a market rate's figure. */
export const NO_MARKET: MarketReferences = Object.freeze({ SELL_USDT: null, BUY_USDT: null });

/** The reference a trader's side is set against: the direction of the deals it fills. */
export const referenceDirectionOf = (side: TraderSideKind): 'SELL_USDT' | 'BUY_USDT' => (side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT');
