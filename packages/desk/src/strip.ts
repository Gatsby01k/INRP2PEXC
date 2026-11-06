import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import type { DeskAccess } from './access.ts';
import { istToday } from './pnl.ts';

export interface DeskStrip {
  readonly openTrades: number;
  readonly tradesOnHold: number;
  /** What INRP2P earned today in USDT, from the ledger: its margin and its fees on P2P deals. Absent without `pnl:view`. */
  readonly realizedMarginTodayUsdt?: string;
  readonly istDay: string;
}

/**
 * The operational strip (UX_FLOWS W5): the trades in flight and what the day earned. Every figure is read from the system
 * of record at request time. A P2P deal is priced by its trader and settles from its own escrow (ADR 0019), so there is no
 * rate, capacity or treasury of the desk's own to show here.
 */
export async function deskStrip(ex: Executor, access: DeskAccess): Promise<DeskStrip> {
  // Two round trips: the IST day with what does not depend on it, then the one figure that does.
  const [day, trades] = await Promise.all([
    istToday(ex),
    sql<{ open: string; hold: string }>`
      select count(*) filter (where lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as open,
             count(*) filter (where hold and lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as hold
      from trade`.execute(ex),
  ]);
  const strip: DeskStrip = {
    openTrades: Number.parseInt(trades.rows[0]!.open, 10),
    tradesOnHold: Number.parseInt(trades.rows[0]!.hold, 10),
    istDay: day,
  };
  if (!access.pnl) return strip;
  const margin = await sql<{ net: string }>`
    select coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end), 0)::text as net
    from ledger_entry e
    join ledger_account a on a.id = e.account_id
    join ledger_journal j on j.id = e.journal_id
    where a.code in ('REVENUE:GROSS_MARGIN', 'REVENUE:PLATFORM_FEE') and a.currency = 'USDT' and (j.posted_at at time zone 'Asia/Kolkata')::date = ${day}::date`.execute(ex);
  return { ...strip, realizedMarginTodayUsdt: Money.ofMinor(BigInt(margin.rows[0]!.net), 'USDT').toDecimalString() };
}

/** Rates are stored as micro-units (6 dp). Kept as an exact string; never a float. */
export function microToDecimal(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
