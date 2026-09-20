import { sql } from 'kysely';
import { Money, Rate } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { type PnlPeriod, pnlSummary } from '@inrp2p/settlement';

/**
 * The P&L screen (UX_FLOWS §2 `/pnl`): realized against expected, and the trades behind both.
 *
 * The one rule this screen exists to enforce is that those two numbers never merge. Realized margin is what the
 * ledger has recognised — credits to `REVENUE:GROSS_MARGIN`, which only completion and approved adjustments
 * post (FI-43). Expected margin is what open trades would make if they all settled as agreed, which is a
 * forecast about the future and not revenue. A P&L that added them would overstate what the business has made,
 * so the summary reports them separately and every row says which kind it is.
 */
export interface PnlRow {
  readonly tradeRef: string;
  readonly clientName: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly status: string;
  readonly base: string;
  readonly inr: string;
  readonly clientRate: string;
  readonly routeRate: string;
  readonly margin: string;
  readonly kind: 'realized' | 'expected';
  readonly at: string;
}

/**
 * The summary as the page carries it: decimal strings, not `Money`.
 *
 * Every read model in this system hands out strings, and this one has to for a second reason — it crosses a
 * server/client boundary, where a class instance arrives as a plain object with its methods gone. The screen
 * parses what it needs back into `Money`, which is where the currency is re-asserted.
 */
export interface PnlPageSummary {
  readonly realizedGrossMargin: string;
  readonly completedVolume: string;
  readonly completedTrades: number;
  readonly openExpectedMargin: string;
  readonly openTrades: number;
}

export interface PnlPage {
  readonly period: PnlPeriod;
  readonly summary: PnlPageSummary;
  /** Trades that completed in the period (realized), then trades still open (expected), newest first in each. */
  readonly rows: readonly PnlRow[];
  /**
   * Realized margin as the **ledger** has it, next to the same figure summed from the completed trades. They
   * must agree; the screen shows both because a P&L that only ever reported its own arithmetic could not tell
   * anyone it had drifted (FI-44).
   */
  readonly ledgerCheck: { readonly ledger: string; readonly trades: string; readonly agrees: boolean };
}

export async function pnlPage(ex: Executor, period: PnlPeriod): Promise<PnlPage> {
  const summary = await pnlSummary(ex, period);

  const rows = await sql<{
    ref: string; display_name: string; direction: 'SELL_USDT' | 'BUY_USDT'; lifecycle_state: string;
    base_minor: bigint; quote_inr_minor: bigint; client_rate_micro: bigint; route_rate_micro: bigint;
    gross_margin_inr_minor: bigint; at: Date; kind: 'realized' | 'expected';
  }>`
    select t.ref, c.display_name, t.direction, t.lifecycle_state,
           e.base_minor, e.quote_inr_minor, e.client_rate_micro, e.route_rate_micro, e.gross_margin_inr_minor,
           coalesce(t.completed_at, t.opened_at) as at,
           case when t.lifecycle_state = 'COMPLETED' then 'realized' else 'expected' end as kind
    from trade t
    join trade_economics e on e.trade_id = t.id
    join client c on c.id = t.client_id
    where (t.lifecycle_state = 'COMPLETED'
             and (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date between ${period.from}::date and ${period.to}::date)
       or t.lifecycle_state not in ('COMPLETED', 'CANCELLED')
    order by kind, at desc, t.ref
    limit 500`.execute(ex);

  // The completed trades' own margin, summed the long way. `pnlSummary` reads the ledger; if these disagree,
  // something posted a journal the trades do not explain, or completed a trade without posting one.
  const completed = rows.rows.filter((r) => r.kind === 'realized').reduce((sum, r) => sum + r.gross_margin_inr_minor, 0n);

  return {
    period,
    summary: {
      realizedGrossMargin: summary.realizedGrossMargin.toDecimalString(),
      completedVolume: summary.completedVolume.toDecimalString(),
      completedTrades: summary.completedTrades,
      openExpectedMargin: summary.openExpectedMargin.toDecimalString(),
      openTrades: summary.openTrades,
    },
    rows: rows.rows.map((r) => ({
      tradeRef: r.ref,
      clientName: r.display_name,
      direction: r.direction,
      status: r.lifecycle_state,
      base: Money.ofMinor(r.base_minor, 'USDT').toDecimalString(),
      inr: Money.ofMinor(r.quote_inr_minor, 'INR').toDecimalString(),
      clientRate: Rate.ofMicro(r.client_rate_micro, 'CLIENT').toDecimalString(),
      routeRate: Rate.ofMicro(r.route_rate_micro, 'ROUTE').toDecimalString(),
      margin: Money.ofMinor(r.gross_margin_inr_minor, 'INR').toDecimalString(),
      kind: r.kind,
      at: r.at.toISOString(),
    })),
    ledgerCheck: {
      ledger: summary.realizedGrossMargin.toDecimalString(),
      trades: Money.ofMinor(completed, 'INR').toDecimalString(),
      agrees: summary.realizedGrossMargin.minor === completed,
    },
  };
}

/** The IST day `inrp2p_now()` is in — the period a P&L page opens on. */
export async function istToday(ex: Executor): Promise<string> {
  const r = await sql<{ day: string }>`select to_char((inrp2p_now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') as day`.execute(ex);
  return r.rows[0]!.day;
}
