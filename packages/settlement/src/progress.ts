import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import type { Executor, TradeLifecycleState, TxContext } from '@inrp2p/db';
import { enqueueOutbox } from '@inrp2p/outbox';
import { postJournal, tradeCompleteJournal } from '@inrp2p/ledger';
import { releaseReservation } from '@inrp2p/inr-accounts';
import { releaseDepositAssignment, releaseTreasuryReservation } from '@inrp2p/treasury';
import { type TradeRow, effectiveObligations, legTotals, reloadTrade, tradeEconomics, transitionTrade } from '@inrp2p/trades';

/** Client legs detected but not yet confirmed: while any exist, the client's side is still arriving. */
export async function clientLegsInFlight(ex: Executor, tradeId: string): Promise<number> {
  const r = await sql<{ n: string }>`
    select count(*)::text as n from settlement_leg
    where trade_id = ${tradeId} and side = 'CLIENT_TO_EXCHANGE' and status = 'PROCESSING'`.execute(ex);
  return Number.parseInt(r.rows[0]!.n, 10);
}

/**
 * T7: both sides of the client's trade are settled. Margin moves from deferred to realized (FI-43), the
 * remaining commitments are released, and the deposit address goes to cooldown. Completion never waits for the
 * route obligation (FI-62) — a residual may stay open.
 */
export async function completeTrade(ctx: TxContext, trade: TradeRow, econ: Awaited<ReturnType<typeof tradeEconomics>>): Promise<void> {
  const reservations = await ctx.tx.selectFrom('capacity_reservation').select('id').where('trade_id', '=', trade.id).where('status', '=', 'ACTIVE').orderBy('id').execute();
  for (const r of reservations) await releaseReservation(ctx, r.id, 'TRADE_COMPLETED');
  await releaseTreasuryReservation(ctx, { tradeId: trade.id, reason: 'TRADE_COMPLETED' });
  if (trade.direction === 'SELL_USDT') {
    const assignment = await ctx.tx.selectFrom('deposit_assignment').select('id').where('trade_id', '=', trade.id).where('released_at', 'is', null).executeTakeFirst();
    if (assignment) await releaseDepositAssignment(ctx, { tradeId: trade.id, reason: 'TRADE_COMPLETED' });
  }
  // The realized margin is the effective one: frozen margin ⊕ margin deltas of posted adjustments (FI-12, FI-43),
  // so the deferred-margin account ends this trade at zero.
  const deltas = await ctx.tx
    .selectFrom('financial_adjustment')
    .select(({ fn }) => fn.sum<string>('delta_margin_inr_minor').as('total'))
    .where('trade_id', '=', trade.id)
    .where('status', '=', 'POSTED')
    .executeTakeFirst();
  const effectiveMargin = Money.ofMinor(econ.grossMargin.minor + BigInt(deltas?.total ?? '0'), 'INR');
  await transitionTrade(ctx, trade, 'COMPLETED', { extra: { gross_margin: effectiveMargin } });
  const journal = tradeCompleteJournal({ ...econ, grossMargin: effectiveMargin }, { tradeId: trade.id });
  if (journal) await postJournal(ctx, journal);
  await enqueueOutbox(ctx, { type: 'receipt.generate', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id, clientId: trade.client_id } });
}

/**
 * Moves a trade forward when something other than a movement made it settle (T4, T7).
 *
 * Movements advance a trade in the command that confirms them. But a trade can also become settled with no
 * movement at all: the last blocking case is resolved after the client's top-up already confirmed, or an approved
 * adjustment brings the obligation down to exactly what was received or paid (`await_top_up`,
 * `adjust_trade_to_received`, a write-off of an unpaid remainder — DOMAIN_MODEL §3). Without this step such a trade
 * waits forever for a confirmation that will never come.
 *
 * The caller holds the trade row lock; the row is re-read because hold and version may have moved earlier in the
 * same transaction. Only the predicates the movement commands already use are applied here (FI-21), and the
 * database re-checks completion on its own.
 */
export async function advanceTrade(ctx: TxContext, tradeId: string): Promise<TradeLifecycleState> {
  const trade = await reloadTrade(ctx.tx, tradeId);
  if (trade.hold) return trade.lifecycle_state;
  const { payout, receivable } = await effectiveObligations(ctx.tx, trade.id);
  const totals = await legTotals(ctx.tx, trade.id);

  if (trade.lifecycle_state === 'FIRST_LEG_DETECTED') {
    if (totals.received === 0n || totals.received !== receivable.minor) return trade.lifecycle_state;
    if ((await clientLegsInFlight(ctx.tx, trade.id)) > 0) return trade.lifecycle_state;
    await transitionTrade(ctx, trade, 'FIRST_LEG_CONFIRMED', { extra: { received: Money.ofMinor(totals.received, receivable.currency) } });
    await enqueueOutbox(ctx, { type: 'desk.payout_actionable', aggregateType: 'trade', aggregateId: trade.id, payload: { tradeId: trade.id } });
    return 'FIRST_LEG_CONFIRMED';
  }

  if (trade.lifecycle_state === 'SETTLING' || trade.lifecycle_state === 'PARTIALLY_SETTLED') {
    const settled = totals.paid === payout.minor && totals.committed === totals.paid && totals.received === receivable.minor;
    if (!settled) return trade.lifecycle_state;
    await completeTrade(ctx, trade, await tradeEconomics(ctx.tx, trade.id));
    return 'COMPLETED';
  }
  return trade.lifecycle_state;
}
