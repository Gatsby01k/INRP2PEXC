import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import { type Executor, type ObligationSide, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';

export interface ObligationRow {
  readonly id: string;
  readonly ref: string;
  readonly route_id: string;
  readonly trade_id: string | null;
  readonly execution_mode: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE';
  readonly status: 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'CANCELLED';
  readonly route_delivers_asset: 'INR' | 'USDT';
  readonly route_delivers_minor: bigint;
  readonly exchange_delivers_asset: 'INR' | 'USDT';
  readonly exchange_delivers_minor: bigint;
}

export async function lockObligation(ctx: TxContext, obligationId: string): Promise<ObligationRow> {
  assertLockOrder(ctx.tx, 'route_obligation');
  const rows = await sql<ObligationRow>`
    select id, ref, route_id, trade_id, execution_mode, status, route_delivers_asset, route_delivers_minor, exchange_delivers_asset, exchange_delivers_minor
    from route_obligation where id = ${requireUuid(obligationId, 'routeObligationId')} for update`.execute(ctx.tx);
  const row = rows.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'route obligation not found');
  return row;
}

export async function obligationOfTrade(ex: Executor, tradeId: string): Promise<{ id: string }> {
  const r = await ex.selectFrom('route_obligation').select('id').where('trade_id', '=', tradeId).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'route obligation not found for trade');
  return r;
}

export interface ObligationRemaining {
  readonly routeDelivers: Money;
  readonly exchangeDelivers: Money;
}

/** What each side of the obligation still owes (FI-61, FI-64 compares this to the ledger). */
export async function obligationRemaining(ex: Executor, obligationId: string): Promise<ObligationRemaining> {
  const id = requireUuid(obligationId, 'routeObligationId');
  const o = await sql<{ route_delivers_asset: 'INR' | 'USDT'; exchange_delivers_asset: 'INR' | 'USDT'; route_side: string; exchange_side: string }>`
    select route_delivers_asset, exchange_delivers_asset,
           inrp2p_route_obligation_side(id, 'ROUTE_DELIVERS')::text as route_side,
           inrp2p_route_obligation_side(id, 'EXCHANGE_DELIVERS')::text as exchange_side
    from route_obligation where id = ${id}`.execute(ex);
  const row = o.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'route obligation not found');
  const allocated = await sql<{ side: ObligationSide; total: string }>`
    select side, coalesce(sum(amount_minor), 0)::text as total
    from route_settlement_allocation where route_obligation_id = ${id} group by side`.execute(ex);
  const sum = (side: ObligationSide) => BigInt(allocated.rows.find((r) => r.side === side)?.total ?? '0');
  return {
    routeDelivers: Money.ofMinor(BigInt(row.route_side) - sum('ROUTE_DELIVERS'), row.route_delivers_asset),
    exchangeDelivers: Money.ofMinor(BigInt(row.exchange_side) - sum('EXCHANGE_DELIVERS'), row.exchange_delivers_asset),
  };
}

/**
 * Records that a confirmed route settlement satisfied part of one obligation side and moves the obligation's
 * status. No journal is posted here: the movement already posted the only one (FI-27).
 */
export async function allocateToObligation(
  ctx: TxContext,
  input: { obligation: ObligationRow; side: ObligationSide; routeSettlementId: string; amount: Money; allocatedBy?: string },
): Promise<{ allocationId: string; status: ObligationRow['status'] }> {
  const { obligation, side, amount } = input;
  if (obligation.status === 'CANCELLED') throw new DomainError('INVALID_TRANSITION', 'a cancelled obligation cannot be allocated');
  const before = await obligationRemaining(ctx.tx, obligation.id);
  const remaining = side === 'ROUTE_DELIVERS' ? before.routeDelivers : before.exchangeDelivers;
  if (amount.currency !== remaining.currency) throw new DomainError('CURRENCY_MISMATCH', `the ${side} side is ${remaining.currency}`);
  if (amount.minor > remaining.minor) {
    throw new DomainError('ROUTE_OVER_ALLOCATION', `only ${remaining.toDecimalString()} ${remaining.currency} remains on the ${side} side`, {
      remaining: remaining.minor.toString(), requested: amount.minor.toString(),
    });
  }
  const row = await ctx.tx
    .insertInto('route_settlement_allocation')
    .values({
      route_settlement_id: input.routeSettlementId,
      route_obligation_id: obligation.id,
      side,
      amount_minor: amount.minor,
      allocated_by: input.allocatedBy ?? ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const after = await obligationRemaining(ctx.tx, obligation.id);
  const settled = after.routeDelivers.isZero() && after.exchangeDelivers.isZero();
  const status: ObligationRow['status'] = settled ? 'SETTLED' : 'PARTIALLY_SETTLED';
  if (status !== obligation.status) {
    await ctx.tx
      .updateTable('route_obligation')
      .set({ status, ...(settled ? { settled_at: sql<Date>`inrp2p_now()` } : {}) })
      .where('id', '=', obligation.id)
      .execute();
  }
  await appendAudit(ctx, {
    action: 'route_settlement.allocated', entityType: 'route_obligation', entityId: obligation.id,
    before: { status: obligation.status, remaining: { route_delivers: before.routeDelivers, exchange_delivers: before.exchangeDelivers } },
    after: { status, side, amount, route_settlement_id: input.routeSettlementId, remaining: { route_delivers: after.routeDelivers, exchange_delivers: after.exchangeDelivers } },
  });
  return { allocationId: row.id, status };
}
