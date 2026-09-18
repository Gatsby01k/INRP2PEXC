import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';

export interface PnlPeriod {
  /** IST day boundaries, inclusive (`YYYY-MM-DD`). */
  readonly from: string;
  readonly to: string;
}

export interface PnlSummary {
  readonly realizedGrossMargin: Money<'INR'>;
  readonly completedVolume: Money<'USDT'>;
  readonly completedTrades: number;
  readonly openExpectedMargin: Money<'INR'>;
}

/**
 * P&L as FINANCIAL_INVARIANTS §4 defines it: realized margin is the ledger's credits to `REVENUE:GROSS_MARGIN`
 * in the period — which only completion and approved adjustments post (FI-43) — and volume counts completed
 * trades only. Open expected margin is reported separately and never merged into the realized figure.
 */
export async function pnlSummary(ex: Executor, period: PnlPeriod): Promise<PnlSummary> {
  const realized = await sql<{ net: string }>`
    select coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end), 0)::text as net
    from ledger_entry e
    join ledger_account a on a.id = e.account_id
    join ledger_journal j on j.id = e.journal_id
    where a.code = 'REVENUE:GROSS_MARGIN'
      and (j.posted_at AT TIME ZONE 'Asia/Kolkata')::date between ${period.from}::date and ${period.to}::date`.execute(ex);
  const completed = await sql<{ volume: string; trades: string }>`
    select coalesce(sum(e.base_minor), 0)::text as volume, count(*)::text as trades
    from trade t join trade_economics e on e.trade_id = t.id
    where t.lifecycle_state = 'COMPLETED'
      and (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date between ${period.from}::date and ${period.to}::date`.execute(ex);
  const open = await sql<{ margin: string }>`
    select coalesce(sum(e.gross_margin_inr_minor), 0)::text as margin
    from trade t join trade_economics e on e.trade_id = t.id
    where t.lifecycle_state not in ('COMPLETED', 'CANCELLED')`.execute(ex);
  return {
    realizedGrossMargin: Money.ofMinor(BigInt(realized.rows[0]!.net), 'INR'),
    completedVolume: Money.ofMinor(BigInt(completed.rows[0]!.volume), 'USDT'),
    completedTrades: Number.parseInt(completed.rows[0]!.trades, 10),
    openExpectedMargin: Money.ofMinor(BigInt(open.rows[0]!.margin), 'INR'),
  };
}

export interface ReconciliationIssue {
  readonly routeObligationId: string;
  readonly side: 'ROUTE_DELIVERS' | 'EXCHANGE_DELIVERS';
  readonly remaining: string;
  readonly ledger: string;
}

/**
 * FI-64: for every open obligation, the remaining side amount must equal the ledger balance of the route
 * account lines carrying that obligation. Anything this returns is a reconciliation defect, not a warning.
 */
export async function routeObligationMismatches(ex: Executor): Promise<ReconciliationIssue[]> {
  const rows = await sql<{ id: string; side: 'ROUTE_DELIVERS' | 'EXCHANGE_DELIVERS'; remaining: string; ledger: string }>`
    with alloc as (
      select route_obligation_id, side, sum(amount_minor) as allocated
      from route_settlement_allocation group by route_obligation_id, side
    ),
    led as (
      select e.route_obligation_id,
             case when a.code like 'ASSET:ROUTE_RECEIVABLE%' then 'ROUTE_DELIVERS' else 'EXCHANGE_DELIVERS' end as side,
             sum(case when a.code like 'ASSET:ROUTE_RECEIVABLE%'
                      then (case e.direction when 'DR' then e.amount_minor else -e.amount_minor end)
                      else (case e.direction when 'CR' then e.amount_minor else -e.amount_minor end) end) as balance
      from ledger_entry e join ledger_account a on a.id = e.account_id
      where e.route_obligation_id is not null
        and (a.code like 'ASSET:ROUTE_RECEIVABLE%' or a.code like 'LIAB:ROUTE_PAYABLE%')
      group by e.route_obligation_id, 2
    )
    select o.id,
           s.side,
           (inrp2p_route_obligation_side(o.id, s.side) - coalesce(alloc.allocated, 0))::text as remaining,
           coalesce(led.balance, 0)::text as ledger
    from route_obligation o
    cross join (values ('ROUTE_DELIVERS'), ('EXCHANGE_DELIVERS')) as s(side)
    left join alloc on alloc.route_obligation_id = o.id and alloc.side = s.side
    left join led on led.route_obligation_id = o.id and led.side = s.side
    where o.status <> 'CANCELLED'
      and (inrp2p_route_obligation_side(o.id, s.side) - coalesce(alloc.allocated, 0)) <> coalesce(led.balance, 0)`.execute(ex);
  return rows.rows.map((r) => ({ routeObligationId: r.id, side: r.side, remaining: r.remaining, ledger: r.ledger }));
}
