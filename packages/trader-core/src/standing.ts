import { sql } from 'kysely';
import { type MarketReference, type MarketReferences, marketRateMicro, referenceDirectionOf } from '@inrp2p/kernel';
import type { Executor, InrRailValue, RateBasis, TraderSide } from '@inrp2p/db';
import type { BlockFacts, TraderStanding } from './eligibility.ts';
import { type ReserveFigures, reserveFigures, reserveFunded } from './reserve-figures.ts';

export interface StandingRead {
  readonly standing: TraderStanding;
  readonly reserve: ReserveFigures;
}

/** A trader's standing, read in the caller's transaction (under its trader lock when it is about to act on it). */
export async function readStanding(ex: Executor, traderId: string): Promise<StandingRead> {
  const row = await ex
    .selectFrom('trader_profile as t')
    .innerJoin('bank_account as b', 'b.id', 't.bank_account_id')
    .innerJoin('crypto_wallet as w', 'w.id', 't.wallet_id')
    .select(['t.status', 't.available', 't.assignments_enabled', 'b.status as bank_status', 'w.status as wallet_status', 'w.purpose as wallet_purpose'])
    .where('t.id', '=', traderId)
    .executeTakeFirstOrThrow();
  const reserve = await reserveFigures(ex, traderId);
  return {
    reserve,
    standing: {
      status: row.status,
      available: row.available,
      assignmentsEnabled: row.assignments_enabled,
      reserveSet: reserve.required !== null,
      reserveFunded: reserveFunded(reserve),
      destinationsActive: row.bank_status === 'ACTIVE' && row.wallet_status === 'ACTIVE' && row.wallet_purpose === 'BOTH',
    },
  };
}

export interface BlockRead extends BlockFacts {
  readonly id: string;
  readonly routeId: string;
  readonly version: number;
  /**
   * ADR 0025: the trader's firm offer — until when INRP2P may fill orders at this side's rate within its limits without
   * asking, and whose commitment that is. `firm` is whether it still stands now (business clock). ADR 0028: a side at a
   * market rate may be firm until the trader turns it off (`instantOpenEnded`, no end of its own).
   */
  readonly instantUntil: Date | null;
  readonly instantSetBy: string | null;
  readonly instantOpenEnded: boolean;
  readonly firm: boolean;
  /** The INR rails this side pays or is paid by. */
  readonly rails: readonly InrRailValue[];
  /**
   * ADR 0028: whether the rate is the trader's own number (`fixedRateMicro`) or set against the market — the reference of
   * the deals the side fills, moved by `marketOffsetBps`, held at `rateLimitMicro`. For a market rate, `rateMicro` is the
   * rate those terms give on `market` (the reference it was derived from), and null while no reference is fresh enough.
   */
  readonly rateBasis: RateBasis;
  readonly fixedRateMicro: bigint | null;
  readonly marketOffsetBps: number | null;
  readonly rateLimitMicro: bigint | null;
  readonly market: MarketReference | null;
}

/**
 * A trader's blocks with the operator's ceilings folded in, and what open offers already promise. A side at a market rate
 * is given the rate its terms give on `market` — the references fresh enough to price on, which the caller reads through
 * the pricing policy (`marketReferences`); `NO_MARKET` when it never needs the figure.
 */
export async function readBlocks(ex: Executor, traderId: string, market: MarketReferences): Promise<BlockRead[]> {
  const r = await sql<{
    id: string; route_id: string; side: TraderSide; status: 'ACTIVE' | 'PAUSED'; rate_micro: string | null; capacity_minor: string; reserved_minor: string;
    min_order_minor: string | null; max_order_minor: string | null; version: number; offered: string;
    max_order_inr_minor: string | null; max_order_usdt_minor: string | null; max_capacity_inr_minor: string | null; max_capacity_usdt_minor: string | null;
    instant_until: Date | null; instant_set_by: string | null; instant_open_ended: boolean; firm: boolean; rails: InrRailValue[];
    rate_basis: RateBasis; market_offset_bps: number | null; rate_limit_micro: string | null;
  }>`
    select b.id, b.route_id, b.side, b.status, b.rate_micro::text, b.capacity_minor::text, b.reserved_minor::text,
           b.min_order_minor::text, b.max_order_minor::text, b.version, b.instant_until, b.instant_set_by, b.instant_open_ended,
           (b.instant_open_ended or coalesce(b.instant_until > inrp2p_now(), false)) as firm, b.rails,
           b.rate_basis, b.market_offset_bps, b.rate_limit_micro::text,
           (select coalesce(sum(o.capacity_minor), 0) from trader_order o
             where o.block_id = b.id and o.status = 'OFFERED' and o.offer_expires_at > inrp2p_now())::text as offered,
           t.max_order_inr_minor::text, t.max_order_usdt_minor::text, t.max_capacity_inr_minor::text, t.max_capacity_usdt_minor::text
    from trader_block b join trader_profile t on t.id = b.trader_id
    where b.trader_id = ${traderId}
    order by b.side`.execute(ex);
  const big = (v: string | null) => (v === null ? null : BigInt(v));
  return r.rows.map((b) => {
    const inr = b.side === 'BUY_USDT';
    const limit = big(b.rate_limit_micro);
    const reference = b.rate_basis === 'MARKET' ? market[referenceDirectionOf(b.side)] : null;
    const rateMicro = b.rate_basis === 'FIXED'
      ? big(b.rate_micro)
      : reference ? marketRateMicro({ side: b.side, referenceMicro: reference.micro, offsetBps: b.market_offset_bps!, limitMicro: limit }) : null;
    return {
      id: b.id,
      routeId: b.route_id,
      side: b.side,
      status: b.status,
      rateMicro,
      rateBasis: b.rate_basis,
      fixedRateMicro: big(b.rate_micro),
      marketOffsetBps: b.market_offset_bps,
      rateLimitMicro: limit,
      market: reference,
      capacityMinor: BigInt(b.capacity_minor),
      reservedMinor: BigInt(b.reserved_minor),
      offeredMinor: BigInt(b.offered),
      minOrderMinor: big(b.min_order_minor),
      maxOrderMinor: big(b.max_order_minor),
      operatorMaxOrderMinor: big(inr ? b.max_order_inr_minor : b.max_order_usdt_minor),
      operatorMaxCapacityMinor: big(inr ? b.max_capacity_inr_minor : b.max_capacity_usdt_minor),
      version: b.version,
      instantUntil: b.instant_until,
      instantSetBy: b.instant_set_by,
      instantOpenEnded: b.instant_open_ended,
      firm: b.firm,
      rails: b.rails,
    };
  });
}
