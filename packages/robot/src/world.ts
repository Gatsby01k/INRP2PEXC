import { sql } from 'kysely';
import type { DirectionValue, Executor, TraderSide } from '@inrp2p/db';
import { Money } from '@inrp2p/kernel';
import { currentPricingPolicy, marketReferences } from '@inrp2p/pricing';
import { currentPeerPolicy } from '@inrp2p/quotes';
import { traderProgram } from '@inrp2p/trader-core';

/**
 * What the robot knows about the exchange as a whole, read once for a sweep or a brief (ADR 0034 §2.3): the market's
 * reference rates while they are fresh enough to price on, the switches that decide what can happen (automatic prices,
 * reviews by rule, clients meeting clients), the sides that could take an order right now, and last week's demand.
 *
 * Nothing in it identifies a trader to anyone but the robot itself: a side is a capacity and limits, never a name, and
 * the robot only ever says "a trader" or "someone".
 */
export interface RobotWorld {
  readonly now: Date;
  /** The market reference per client direction (micro-rupees per USDT), null when stale: a client selling gets the bid. */
  readonly market: Readonly<Record<DirectionValue, bigint | null>>;
  readonly autoQuote: boolean;
  readonly autoReview: boolean;
  readonly peer: { readonly enabled: boolean; readonly feeBps: number; readonly minDealUsdtMinor: bigint };
  /** Sides that could take an order now: approved, online, assignments on, the side active on a P2P route with a rate. */
  readonly sides: readonly LiveSide[];
  /** Last week's requests to the INRP2P exchange per client direction, and their size in USDT at the market reference. */
  readonly demand: Readonly<Record<DirectionValue, { readonly requests: number; readonly usdtMinor: bigint }>>;
}

export interface LiveSide {
  readonly traderClientId: string;
  readonly side: TraderSide;
  /** The block's own currency: a side buying USDT holds rupees, a side selling USDT holds USDT. */
  readonly currency: 'INR' | 'USDT';
  readonly minMinor: bigint | null;
  readonly maxMinor: bigint | null;
  readonly freeMinor: bigint;
}

/** The trader side a client's direction is filled by. */
export const sideFor = (direction: DirectionValue): TraderSide => (direction === 'SELL_USDT' ? 'BUY_USDT' : 'SELL_USDT');

/** rupee paise ↔ USDT micro-units at a micro-rupee rate: INR minor = USDT minor × rate / 10¹⁰. */
export const inrOf = (usdtMinor: bigint, rateMicro: bigint): bigint => (usdtMinor * rateMicro) / 10_000_000_000n;
export const usdtOf = (inrMinor: bigint, rateMicro: bigint): bigint => (inrMinor * 10_000_000_000n) / rateMicro;

export async function loadWorld(ex: Executor): Promise<RobotWorld> {
  const [now, pricing, program, peer] = await Promise.all([
    sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex).then((r) => r.rows[0]!.now),
    currentPricingPolicy(ex),
    traderProgram(ex),
    currentPeerPolicy(ex),
  ]);
  const refs = await marketReferences(ex, pricing);
  const market = { SELL_USDT: refs.SELL_USDT?.micro ?? null, BUY_USDT: refs.BUY_USDT?.micro ?? null };
  const [blocks, demand] = await Promise.all([
    ex.selectFrom('trader_block as b')
      .innerJoin('trader_profile as t', 't.id', 'b.trader_id')
      .innerJoin('liquidity_route as r', 'r.id', 'b.route_id')
      .select(['t.client_id', 'b.side', 'b.capacity_minor', 'b.reserved_minor', 'b.min_order_minor', 'b.max_order_minor', 'b.rate_basis', 'b.rate_micro', 'b.market_offset_bps'])
      .where('t.status', '=', 'APPROVED').where('t.available', '=', true).where('t.assignments_enabled', '=', true)
      .where('b.status', '=', 'ACTIVE').where('r.execution_mode', '=', 'P2P')
      .execute(),
    ex.selectFrom('trade_request')
      .select(['direction', 'fixed_side', 'requested_base_minor', 'requested_quote_minor'])
      .where('desk_id', 'is', null).where('channel', '=', 'CLIENT_APP')
      .where('created_at', '>', sql<Date>`inrp2p_now() - interval '7 days'`)
      .execute(),
  ]);
  const sides: LiveSide[] = [];
  for (const b of blocks) {
    // A market rate is a rate only while the reference of the deals it fills is fresh (ADR 0028 §2.1).
    const rated = b.rate_basis === 'MARKET' ? b.market_offset_bps !== null && market[b.side === 'BUY_USDT' ? 'SELL_USDT' : 'BUY_USDT'] !== null : b.rate_micro !== null;
    if (!rated) continue;
    const free = b.capacity_minor - b.reserved_minor;
    if (free <= 0n) continue;
    sides.push({ traderClientId: b.client_id, side: b.side, currency: b.side === 'BUY_USDT' ? 'INR' : 'USDT', minMinor: b.min_order_minor, maxMinor: b.max_order_minor, freeMinor: free });
  }
  const totals: Record<DirectionValue, { requests: number; usdtMinor: bigint }> = { SELL_USDT: { requests: 0, usdtMinor: 0n }, BUY_USDT: { requests: 0, usdtMinor: 0n } };
  for (const r of demand) {
    const t = totals[r.direction];
    t.requests += 1;
    if (r.fixed_side === 'BASE' && r.requested_base_minor !== null) t.usdtMinor += r.requested_base_minor;
    else if (r.requested_quote_minor !== null && market[r.direction] !== null) t.usdtMinor += usdtOf(r.requested_quote_minor, market[r.direction]!);
  }
  return {
    now,
    market,
    autoQuote: pricing.autoQuote,
    autoReview: program.autoReview,
    peer: { enabled: peer.enabled, feeBps: peer.feeBps, minDealUsdtMinor: peer.minDealUsdtMinor },
    sides,
    demand: totals,
  };
}

/**
 * Whether a side online now would likely take an amount of a client's direction: within its limits and its free
 * capacity, the amount put in the side's own currency at the market reference. "Likely", because its price may still
 * be outside the market's bounds or the client's own (ADR 0025, 0033) — so the robot says "is online", never "will price".
 */
export function sideTakes(w: RobotWorld, input: { direction: DirectionValue; amount: string; currency: 'USDT' | 'INR'; excludeClientId?: string }): boolean {
  const side = sideFor(input.direction);
  const rate = w.market[input.direction];
  const minor = Money.parse(input.amount, input.currency).minor;
  for (const s of w.sides) {
    if (s.side !== side || s.traderClientId === input.excludeClientId) continue;
    let need: bigint;
    if (s.currency === input.currency) need = minor;
    else if (rate === null) continue;
    else need = s.currency === 'INR' ? inrOf(minor, rate) : usdtOf(minor, rate);
    if (s.minMinor !== null && need < s.minMinor) continue;
    if (s.maxMinor !== null && need > s.maxMinor) continue;
    if (need > s.freeMinor) continue;
    return true;
  }
  return false;
}
