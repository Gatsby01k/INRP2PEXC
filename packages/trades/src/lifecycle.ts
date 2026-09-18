import { sql } from 'kysely';
import { DomainError, Money, type TradeEconomics, requireUuid } from '@inrp2p/kernel';
import { type Executor, type LockResource, type TradeLifecycleState, type Tx, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';

export interface TradeRow {
  readonly id: string;
  readonly ref: string;
  readonly client_id: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly lifecycle_state: TradeLifecycleState;
  readonly hold: boolean;
  readonly version: number;
}

/** `SELECT … FOR UPDATE` in global lock order (ARCHITECTURE §4). Everything about a trade starts here. */
export async function lockTrade(tx: Tx, tradeId: string): Promise<TradeRow> {
  assertLockOrder(tx, 'trade');
  const rows = await sql<TradeRow>`select id, ref, client_id, direction, lifecycle_state, hold, version from trade where id = ${requireUuid(tradeId, 'tradeId')} for update`.execute(tx);
  const row = rows.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'trade not found');
  return row;
}

export async function lockInOrderRow(tx: Tx, resource: LockResource, table: string, id: string): Promise<void> {
  assertLockOrder(tx, resource);
  const r = await sql`select 1 from ${sql.table(table)} where id = ${id} for update`.execute(tx);
  if (r.rows.length === 0) throw new DomainError('NOT_FOUND', `${table} not found`);
}

export interface EffectiveObligations {
  /** What the client must send us (SELL: USDT, BUY: INR), after posted adjustments. */
  readonly receivable: Money;
  /** What we must pay the client (SELL: INR, BUY: USDT), after posted adjustments. */
  readonly payout: Money;
  readonly receivableAsset: 'INR' | 'USDT';
  readonly payoutAsset: 'INR' | 'USDT';
}

/** Effective terms = frozen economics ⊕ posted adjustments (FI-12), computed by the same SQL the triggers use. */
export async function effectiveObligations(ex: Executor, tradeId: string): Promise<EffectiveObligations> {
  const r = await sql<{ direction: 'SELL_USDT' | 'BUY_USDT'; payout: bigint; receivable: bigint }>`
    select e.direction,
           inrp2p_trade_payout_obligation(e.trade_id) as payout,
           inrp2p_trade_receivable_obligation(e.trade_id) as receivable
    from trade_economics e where e.trade_id = ${requireUuid(tradeId, 'tradeId')}`.execute(ex);
  const row = r.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'trade economics not found');
  const sell = row.direction === 'SELL_USDT';
  const receivableAsset = sell ? 'USDT' : 'INR';
  const payoutAsset = sell ? 'INR' : 'USDT';
  return {
    receivable: Money.ofMinor(BigInt(row.receivable), receivableAsset),
    payout: Money.ofMinor(BigInt(row.payout), payoutAsset),
    receivableAsset,
    payoutAsset,
  };
}

export interface LegTotals {
  /** Confirmed client-side funds. */
  readonly received: bigint;
  /** Confirmed payouts. */
  readonly paid: bigint;
  /** Payout legs that are PENDING, PROCESSING or COMPLETED — the FI-20 commitment. */
  readonly committed: bigint;
}

export async function legTotals(ex: Executor, tradeId: string): Promise<LegTotals> {
  const r = await sql<{ received: bigint; paid: bigint; committed: bigint }>`
    select
      coalesce(sum(amount_minor) filter (where side = 'CLIENT_TO_EXCHANGE' and status = 'COMPLETED'), 0)::bigint as received,
      coalesce(sum(amount_minor) filter (where side = 'EXCHANGE_TO_CLIENT' and status = 'COMPLETED'), 0)::bigint as paid,
      coalesce(sum(amount_minor) filter (where side = 'EXCHANGE_TO_CLIENT' and status in ('PENDING', 'PROCESSING', 'COMPLETED')), 0)::bigint as committed
    from settlement_leg where trade_id = ${requireUuid(tradeId, 'tradeId')}`.execute(ex);
  const row = r.rows[0]!;
  return { received: BigInt(row.received), paid: BigInt(row.paid), committed: BigInt(row.committed) };
}

const ALLOWED: Readonly<Record<TradeLifecycleState, readonly TradeLifecycleState[]>> = Object.freeze({
  AWAITING_FIRST_LEG: ['FIRST_LEG_DETECTED', 'CANCELLED'],
  FIRST_LEG_DETECTED: ['AWAITING_FIRST_LEG', 'FIRST_LEG_CONFIRMED', 'CANCELLED'],
  FIRST_LEG_CONFIRMED: ['SETTLING', 'CANCELLED'],
  SETTLING: ['PARTIALLY_SETTLED', 'COMPLETED', 'CANCELLED'],
  PARTIALLY_SETTLED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
});

/**
 * The only way a trade changes state (FI-13). Writes the transition history row and the audit event with it,
 * and lets the database whitelist re-check the pair. The caller already holds the trade row lock.
 */
export async function transitionTrade(
  ctx: TxContext,
  trade: TradeRow,
  to: TradeLifecycleState,
  opts: { reason?: string; extra?: Record<string, unknown> } = {},
): Promise<void> {
  const from = trade.lifecycle_state;
  if (from === to) return;
  if (!ALLOWED[from].includes(to)) throw new DomainError('INVALID_TRANSITION', `trade ${trade.ref} cannot go ${from} → ${to}`);
  const now = sql<Date>`inrp2p_now()`;
  await ctx.tx
    .updateTable('trade')
    .set({
      lifecycle_state: to,
      version: trade.version + 1,
      ...(to === 'COMPLETED' ? { completed_at: now } : {}),
      ...(to === 'CANCELLED' ? { cancelled_at: now } : {}),
    })
    .where('id', '=', trade.id)
    .where('version', '=', trade.version)
    .execute();
  await ctx.tx
    .insertInto('trade_transition')
    .values({ trade_id: trade.id, from_state: from, to_state: to, command: ctx.commandName, actor: ctx.actor.id ?? 'SYSTEM', correlation_id: ctx.correlationId })
    .execute();
  await appendAudit(ctx, {
    action: `trade.${TRANSITION_ACTIONS[to] ?? to.toLowerCase()}`,
    entityType: 'trade',
    entityId: trade.id,
    before: { lifecycle_state: from },
    after: { lifecycle_state: to, ...(opts.reason ? { reason: opts.reason } : {}), ...(opts.extra ?? {}) },
  });
}

const TRANSITION_ACTIONS: Partial<Record<TradeLifecycleState, string>> = {
  FIRST_LEG_DETECTED: 'first_leg_detected',
  AWAITING_FIRST_LEG: 'first_leg_reverted',
  FIRST_LEG_CONFIRMED: 'first_leg_confirmed',
  SETTLING: 'settling',
  PARTIALLY_SETTLED: 'partially_settled',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

/** Reads the frozen economics as kernel money values (for ledger rules). */
export async function tradeEconomics(ex: Executor, tradeId: string): Promise<TradeEconomics & { routeId: string; executionMode: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE'; clientId: string; routeObligationId: string }> {
  const row = await ex
    .selectFrom('trade_economics as e')
    .innerJoin('trade as t', 't.id', 'e.trade_id')
    .innerJoin('route_obligation as o', 'o.trade_id', 'e.trade_id')
    .select(['e.direction', 'e.fixed_side', 'e.base_minor', 'e.quote_inr_minor', 'e.route_value_inr_minor', 'e.gross_margin_inr_minor', 'e.route_id', 'e.route_execution_mode', 't.client_id', 'o.id as obligation_id'])
    .where('e.trade_id', '=', requireUuid(tradeId, 'tradeId'))
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'trade economics not found');
  return {
    direction: row.direction,
    fixedSide: row.fixed_side,
    base: Money.ofMinor(row.base_minor, 'USDT'),
    clientInr: Money.ofMinor(row.quote_inr_minor, 'INR'),
    routeInr: Money.ofMinor(row.route_value_inr_minor, 'INR'),
    grossMargin: Money.ofMinor(row.gross_margin_inr_minor, 'INR'),
    routeId: row.route_id,
    executionMode: row.route_execution_mode,
    clientId: row.client_id,
    routeObligationId: row.obligation_id,
  };
}
