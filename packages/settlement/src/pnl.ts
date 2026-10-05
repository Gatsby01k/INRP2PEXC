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
  readonly openTrades: number;
  /** Trader rewards recognised in the period (`EXPENSE:TRADER_REWARDS`, accrued when an order completes). */
  readonly traderRewards: Money<'INR'>;
  /** Fee lines the ledger has recorded in the period (`EXPENSE:FEES`, INR) — bank charges once reconciliation records them. */
  readonly recordedFees: Money<'INR'>;
  /** Realized gross margin less rewards and recorded fees. It may be negative, and is then shown as such. */
  readonly netAfterRewardsAndFees: Money<'INR'>;
  /** Rewards accrued and not yet paid, now (`LIAB:TRADER_REWARD_PAYABLE`): an obligation, visible until it is paid. */
  readonly rewardsPayable: Money<'INR'>;
  /** Realized margin free to pay them, now, across active accounts (migration 0030) — the only money that may. */
  readonly freeMargin: Money<'INR'>;
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
  // Completed volume is the effective base: frozen economics plus approved base adjustments (§4 "+ adjustments").
  const completed = await sql<{ volume: string; trades: string }>`
    select coalesce(sum(e.base_minor + coalesce((select sum(a.delta_base_minor) from financial_adjustment a
                                                 where a.trade_id = t.id and a.status = 'POSTED'), 0)), 0)::text as volume,
           count(*)::text as trades
    from trade t join trade_economics e on e.trade_id = t.id
    where t.lifecycle_state = 'COMPLETED'
      and (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date between ${period.from}::date and ${period.to}::date`.execute(ex);
  const open = await sql<{ margin: string; trades: string }>`
    select coalesce(sum(e.gross_margin_inr_minor), 0)::text as margin, count(*)::text as trades
    from trade t join trade_economics e on e.trade_id = t.id
    where t.lifecycle_state not in ('COMPLETED', 'CANCELLED')`.execute(ex);
  // What the period cost, from the ledger: rewards recognised and fee lines recorded. Costs the ledger does not carry
  // (TRX for transfers, the custody provider's invoice, bank charges until reconciliation records them) are not
  // invented here; the screen lists them as not deducted, with who covers them (ADR 0016 §6).
  const costs = await sql<{ rewards: string; fees: string }>`
    select coalesce(sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) filter (where a.code = 'EXPENSE:TRADER_REWARDS'), 0)::text as rewards,
           coalesce(sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) filter (where a.code = 'EXPENSE:FEES' and e.currency = 'INR'), 0)::text as fees
    from ledger_entry e
    join ledger_account a on a.id = e.account_id
    join ledger_journal j on j.id = e.journal_id
    where a.code in ('EXPENSE:TRADER_REWARDS', 'EXPENSE:FEES')
      and (j.posted_at AT TIME ZONE 'Asia/Kolkata')::date between ${period.from}::date and ${period.to}::date`.execute(ex);
  const now = await sql<{ payable: string; free: string }>`
    select coalesce((select -sum(b.dr_minus_cr_minor) from ledger_account_balance b where b.code like 'LIAB:TRADER_REWARD_PAYABLE:%' and b.currency = 'INR'), 0)::bigint::text as payable,
           coalesce((select sum(greatest(inrp2p_inr_account_free_margin(a.id), 0)) from inr_settlement_account a where a.status = 'ACTIVE'), 0)::bigint::text as free`.execute(ex);
  const gross = BigInt(realized.rows[0]!.net);
  const rewards = BigInt(costs.rows[0]!.rewards);
  const fees = BigInt(costs.rows[0]!.fees);
  return {
    realizedGrossMargin: Money.ofMinor(gross, 'INR'),
    completedVolume: Money.ofMinor(BigInt(completed.rows[0]!.volume), 'USDT'),
    completedTrades: Number.parseInt(completed.rows[0]!.trades, 10),
    openExpectedMargin: Money.ofMinor(BigInt(open.rows[0]!.margin), 'INR'),
    openTrades: Number.parseInt(open.rows[0]!.trades, 10),
    traderRewards: Money.ofMinor(rewards, 'INR'),
    recordedFees: Money.ofMinor(fees, 'INR'),
    netAfterRewardsAndFees: Money.ofMinor(gross - rewards - fees, 'INR'),
    rewardsPayable: Money.ofMinor(BigInt(now.rows[0]!.payable), 'INR'),
    freeMargin: Money.ofMinor(BigInt(now.rows[0]!.free), 'INR'),
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
