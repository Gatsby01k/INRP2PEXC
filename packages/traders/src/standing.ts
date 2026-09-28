import { sql } from 'kysely';
import type { Executor, TraderSide } from '@inrp2p/db';
import type { BlockFacts, TraderStanding } from './eligibility.ts';
import { type ReserveFigures, reserveFigures, reserveFunded } from './reserve.ts';

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
}

/** A trader's blocks with the operator's ceilings folded in, and what open offers already promise. */
export async function readBlocks(ex: Executor, traderId: string): Promise<BlockRead[]> {
  const r = await sql<{
    id: string; route_id: string; side: TraderSide; status: 'ACTIVE' | 'PAUSED'; rate_micro: string | null; capacity_minor: string; reserved_minor: string;
    min_order_minor: string | null; max_order_minor: string | null; version: number; offered: string;
    max_order_inr_minor: string | null; max_order_usdt_minor: string | null; max_capacity_inr_minor: string | null; max_capacity_usdt_minor: string | null;
  }>`
    select b.id, b.route_id, b.side, b.status, b.rate_micro::text, b.capacity_minor::text, b.reserved_minor::text,
           b.min_order_minor::text, b.max_order_minor::text, b.version,
           (select coalesce(sum(o.capacity_minor), 0) from trader_order o
             where o.block_id = b.id and o.status = 'OFFERED' and o.offer_expires_at > inrp2p_now())::text as offered,
           t.max_order_inr_minor::text, t.max_order_usdt_minor::text, t.max_capacity_inr_minor::text, t.max_capacity_usdt_minor::text
    from trader_block b join trader_profile t on t.id = b.trader_id
    where b.trader_id = ${traderId}
    order by b.side`.execute(ex);
  const big = (v: string | null) => (v === null ? null : BigInt(v));
  return r.rows.map((b) => {
    const inr = b.side === 'BUY_USDT';
    return {
      id: b.id,
      routeId: b.route_id,
      side: b.side,
      status: b.status,
      rateMicro: big(b.rate_micro),
      capacityMinor: BigInt(b.capacity_minor),
      reservedMinor: BigInt(b.reserved_minor),
      offeredMinor: BigInt(b.offered),
      minOrderMinor: big(b.min_order_minor),
      maxOrderMinor: big(b.max_order_minor),
      operatorMaxOrderMinor: big(inr ? b.max_order_inr_minor : b.max_order_usdt_minor),
      operatorMaxCapacityMinor: big(inr ? b.max_capacity_inr_minor : b.max_capacity_usdt_minor),
      version: b.version,
    };
  });
}
