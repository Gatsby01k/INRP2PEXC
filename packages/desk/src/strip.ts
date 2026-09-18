import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { DirectionValue, Executor } from '@inrp2p/db';
import { istToday } from '@inrp2p/inr-accounts';
import type { DeskAccess } from './access.ts';

export interface StripRoute {
  readonly routeId: string;
  readonly routeName: string;
  readonly direction: DirectionValue;
  /** Decimal route rate, or null when no current snapshot exists for that direction. */
  readonly rate: string | null;
  readonly publishedAt: string | null;
}

export interface DeskStrip {
  /** Current route rates per direction. Absent entirely without `economics:view`. */
  readonly routes?: readonly StripRoute[];
  /** INR the desk could pay out today: capacity − used − reserved across ACTIVE accounts (FI-30). */
  readonly inrAvailableToday: string;
  /** USDT the treasury observes minus what open trades have reserved (FI-33). */
  readonly usdtAvailable: string;
  readonly openTrades: number;
  readonly tradesOnHold: number;
  /** Realized gross margin for the IST day, from the ledger. Absent without `pnl:view`. */
  readonly realizedMarginToday?: string;
  readonly istDay: string;
}

/**
 * The operational strip (UX_FLOWS W5): the six numbers a dealer needs before quoting anything. Every figure is
 * read from the system of record at request time — none of it is cached, because a stale capacity number is how
 * a desk promises money it does not have.
 */
export async function deskStrip(ex: Executor, access: DeskAccess): Promise<DeskStrip> {
  const day = await istToday(ex);

  const capacity = await sql<{ available: string }>`
    select coalesce(sum(greatest(d.capacity_minor - d.used_minor - d.reserved_minor, 0)), 0)::text as available
    from inr_account_day d
    join inr_settlement_account a on a.id = d.account_id
    where d.day = ${day}::date and a.status = 'ACTIVE' and a.direction in ('PAYOUT', 'BOTH')`.execute(ex);

  const treasury = await sql<{ available: string }>`
    select coalesce(sum(greatest(observed_balance_minor - reserved_minor, 0)), 0)::text as available
    from treasury_wallet where status = 'ACTIVE' and role in ('HOT', 'DEPOSIT_POOL')`.execute(ex);

  const trades = await sql<{ open: string; hold: string }>`
    select count(*) filter (where lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as open,
           count(*) filter (where hold and lifecycle_state not in ('COMPLETED', 'CANCELLED'))::text as hold
    from trade`.execute(ex);

  const strip: DeskStrip = {
    inrAvailableToday: Money.ofMinor(BigInt(capacity.rows[0]!.available), 'INR').toDecimalString(),
    usdtAvailable: Money.ofMinor(BigInt(treasury.rows[0]!.available), 'USDT').toDecimalString(),
    openTrades: Number.parseInt(trades.rows[0]!.open, 10),
    tradesOnHold: Number.parseInt(trades.rows[0]!.hold, 10),
    istDay: day,
  };
  if (!access.economics && !access.pnl) return strip;

  const extras: { routes?: readonly StripRoute[]; realizedMarginToday?: string } = {};
  if (access.economics) {
    const rows = await sql<{ route_id: string; name: string; direction: DirectionValue; rate: string | null; published_at: Date | null }>`
      select r.id as route_id, r.name, d.direction,
             (select s.rate_micro::text from rate_snapshot s
               where s.route_id = r.id and s.direction = d.direction and s.kind = 'ROUTE'
               order by s.effective_at desc limit 1) as rate,
             (select s.effective_at from rate_snapshot s
               where s.route_id = r.id and s.direction = d.direction and s.kind = 'ROUTE'
               order by s.effective_at desc limit 1) as published_at
      from liquidity_route r
      cross join (values ('SELL_USDT'), ('BUY_USDT')) as d(direction)
      where r.status = 'ACTIVE'
      order by r.name, d.direction`.execute(ex);
    extras.routes = rows.rows.map((r) => ({
      routeId: r.route_id,
      routeName: r.name,
      direction: r.direction,
      rate: r.rate === null ? null : microToDecimal(BigInt(r.rate)),
      publishedAt: r.published_at ? r.published_at.toISOString() : null,
    }));
  }
  if (access.pnl) {
    const margin = await sql<{ net: string }>`
      select coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end), 0)::text as net
      from ledger_entry e
      join ledger_account a on a.id = e.account_id
      join ledger_journal j on j.id = e.journal_id
      where a.code = 'REVENUE:GROSS_MARGIN' and (j.posted_at at time zone 'Asia/Kolkata')::date = ${day}::date`.execute(ex);
    extras.realizedMarginToday = Money.ofMinor(BigInt(margin.rows[0]!.net), 'INR').toDecimalString();
  }
  return { ...strip, ...extras };
}

/** Rates are stored as micro-units (6 dp). Kept as an exact string; never a float. */
export function microToDecimal(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
