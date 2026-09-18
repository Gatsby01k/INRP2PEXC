import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import type { DeskAccess } from './access.ts';
import { microToDecimal } from './strip.ts';

export interface OrderRow {
  readonly tradeId: string;
  readonly ref: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly direction: DirectionValue;
  readonly base: string;
  readonly quoteInr: string;
  readonly lifecycle: string;
  readonly hold: boolean;
  readonly openedAt: string;
  readonly completedAt: string | null;
  readonly clientRate?: string;
  readonly margin?: string;
}

export interface OrderFilter {
  readonly state?: 'OPEN' | 'COMPLETED' | 'CANCELLED' | 'ALL';
  readonly direction?: DirectionValue;
  readonly clientId?: string;
  readonly limit?: number;
}

/** The Orders list: every trade, newest first, filtered the way a desk actually filters. */
export async function listOrders(ex: Executor, access: DeskAccess, filter: OrderFilter = {}): Promise<readonly OrderRow[]> {
  const state = filter.state ?? 'ALL';
  const rows = await sql<{
    id: string; ref: string; client_id: string; client_name: string; direction: DirectionValue;
    base_minor: bigint; quote_inr_minor: bigint; lifecycle_state: string; hold: boolean;
    opened_at: Date; completed_at: Date | null; client_rate_micro: bigint; gross_margin_inr_minor: bigint;
  }>`
    select t.id, t.ref, t.client_id, c.display_name as client_name, t.direction,
           e.base_minor, e.quote_inr_minor, t.lifecycle_state, t.hold, t.opened_at, t.completed_at,
           e.client_rate_micro, e.gross_margin_inr_minor
    from trade t
    join client c on c.id = t.client_id
    join trade_economics e on e.trade_id = t.id
    where (${state}::text = 'ALL'
           or (${state}::text = 'OPEN' and t.lifecycle_state not in ('COMPLETED', 'CANCELLED'))
           or t.lifecycle_state = ${state}::text)
      and (${filter.direction ?? null}::text is null or t.direction = ${filter.direction ?? null}::text)
      and (${filter.clientId ?? null}::uuid is null or t.client_id = ${filter.clientId ?? null}::uuid)
    order by t.opened_at desc
    limit ${filter.limit ?? 100}`.execute(ex);
  return rows.rows.map((r) => toOrder(r, access));
}

/**
 * The ⌘K search (UX_FLOWS §2): find a trade by its own reference, by a client's name, or by the **evidence** —
 * a UTR or a transaction hash someone read off a bank statement or a block explorer. Matching is exact on
 * references (normalized the way the domain normalizes them) and a prefix match on names, so a search never
 * returns a "close enough" trade an operator might act on by mistake.
 */
export async function searchOrders(ex: Executor, access: DeskAccess, term: string, opts: { limit?: number } = {}): Promise<readonly OrderRow[]> {
  const raw = term.trim();
  if (raw.length < 2) return [];
  const upper = raw.toUpperCase();
  const hash = raw.toLowerCase().replace(/^0x/, '');
  const rows = await sql<{
    id: string; ref: string; client_id: string; client_name: string; direction: DirectionValue;
    base_minor: bigint; quote_inr_minor: bigint; lifecycle_state: string; hold: boolean;
    opened_at: Date; completed_at: Date | null; client_rate_micro: bigint; gross_margin_inr_minor: bigint;
  }>`
    select distinct t.id, t.ref, t.client_id, c.display_name as client_name, t.direction,
           e.base_minor, e.quote_inr_minor, t.lifecycle_state, t.hold, t.opened_at, t.completed_at,
           e.client_rate_micro, e.gross_margin_inr_minor
    from trade t
    join client c on c.id = t.client_id
    join trade_economics e on e.trade_id = t.id
    left join settlement_leg l on l.trade_id = t.id
    left join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null
    left join fiat_transfer f on f.id = a.fiat_transfer_id
    left join crypto_transfer x on x.id = a.crypto_transfer_id
    where upper(t.ref) = ${upper}
       or c.display_name ilike ${`${raw}%`}
       or upper(btrim(f.utr)) = ${upper}
       or x.tx_hash = ${hash}
    order by t.opened_at desc
    limit ${opts.limit ?? 20}`.execute(ex);
  return rows.rows.map((r) => toOrder(r, access));
}

function toOrder(
  r: {
    id: string; ref: string; client_id: string; client_name: string; direction: DirectionValue;
    base_minor: bigint; quote_inr_minor: bigint; lifecycle_state: string; hold: boolean;
    opened_at: Date; completed_at: Date | null; client_rate_micro: bigint; gross_margin_inr_minor: bigint;
  },
  access: DeskAccess,
): OrderRow {
  const row: OrderRow = {
    tradeId: r.id,
    ref: r.ref,
    clientId: r.client_id,
    clientName: r.client_name,
    direction: r.direction,
    base: Money.ofMinor(r.base_minor, 'USDT').toDecimalString(),
    quoteInr: Money.ofMinor(r.quote_inr_minor, 'INR').toDecimalString(),
    lifecycle: r.lifecycle_state,
    hold: r.hold,
    openedAt: r.opened_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
  };
  if (!access.economics) return row;
  return { ...row, clientRate: microToDecimal(r.client_rate_micro), margin: Money.ofMinor(r.gross_margin_inr_minor, 'INR').toDecimalString() };
}
