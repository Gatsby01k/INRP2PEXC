import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { lockTrader } from './access.ts';
import { closeUnstartedOrder, lockOrder } from './offers.ts';

/**
 * The contract between quotes and trader orders — the only part of the trader programme the quote module sees.
 * A quote on a trader route prices that trader's accepted order; accepting the quote starts the order; closing the
 * request closes the order. Kept apart from the rest of the programme so the quote module depends on this and
 * nothing heavier (the database enforces the same contract independently, IX075).
 */
async function businessNow(ctx: TxContext): Promise<Date> {
  const r = await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ctx.tx);
  return r.rows[0]!.now;
}

/**
 * Called by the request commands when a request closes (declined, withdrawn, expired): a live offer is withdrawn
 * and an accepted order gives its capacity back. The caller holds the request lock.
 */
export async function closeOrdersForRequest(ctx: TxContext, requestId: string): Promise<number> {
  return closeOrdersForRequests(ctx, [requestId]);
}

/**
 * The same for several requests closing together (a desk blocking a client, ADR 0020): every trader first, then every
 * order, then the blocks the orders give capacity back to — the global lock order, however many orders there are.
 */
export async function closeOrdersForRequests(ctx: TxContext, requestIds: readonly string[]): Promise<number> {
  if (requestIds.length === 0) return 0;
  const live = await ctx.tx.selectFrom('trader_order').select(['id', 'trader_id']).where('trade_request_id', 'in', [...requestIds]).where('status', 'in', ['OFFERED', 'ACCEPTED']).orderBy('id').execute();
  for (const traderId of [...new Set(live.map((o) => o.trader_id))].sort()) await lockTrader(ctx, traderId);
  const orders = [];
  for (const o of live) orders.push(await lockOrder(ctx, o.id));
  for (const order of orders) {
    if (order.status === 'OFFERED') await closeUnstartedOrder(ctx, order, 'WITHDRAWN', 'REQUEST_CLOSED');
    else if (order.status === 'ACCEPTED') await closeUnstartedOrder(ctx, order, 'RELEASED', 'REQUEST_CLOSED');
  }
  return live.length;
}

export interface OrderForQuote {
  readonly orderId: string;
  readonly ref: string;
  readonly snapshotId: string;
  readonly baseMinor: bigint;
  readonly inrMinor: bigint;
  readonly holdUntil: Date;
  /** The client rate the order was sized at (an INR-fixed request, or any P2P order — ADR 0019). */
  readonly plannedClientRateMicro: bigint | null;
}

/**
 * What a quote on a trader route must price: that trader's accepted order for this request — its snapshot, its USDT
 * and its INR — while the order still holds capacity. Called by `quote.create` and `quote.send` under the request
 * lock; the database checks the same thing again when the quote row is written.
 */
export async function requireOrderForQuote(ctx: TxContext, input: { requestId: string; routeId: string }): Promise<OrderForQuote> {
  const peek = await ctx.tx
    .selectFrom('trader_order')
    .select(['id'])
    .where('trade_request_id', '=', input.requestId)
    .where('route_id', '=', input.routeId)
    .where('status', '=', 'ACCEPTED')
    .executeTakeFirst();
  if (!peek) throw new DomainError('TRADER_ORDER_REQUIRED', 'this route belongs to a trader: route the request to it and wait for the trader to accept before quoting');
  const order = await lockOrder(ctx, peek.id);
  if (order.status !== 'ACCEPTED') throw new DomainError('TRADER_ORDER_REQUIRED', 'the trader order is no longer accepted');
  const now = await businessNow(ctx);
  if (!order.hold_until || now >= order.hold_until) throw new DomainError('TRADER_ORDER_HOLD_EXPIRED', "the trader's hold on this order has ended; route the request again");
  return { orderId: order.id, ref: order.ref, snapshotId: order.route_rate_snapshot_id!, baseMinor: order.base_minor, inrMinor: order.inr_minor, holdUntil: order.hold_until, plannedClientRateMicro: order.planned_client_rate_micro };
}

/**
 * The client accepted a quote on a trader route: the trader's order starts, bound to the trade and its route
 * obligation (the database checks they are the accepted terms). Runs in the acceptance transaction; any failure fails
 * the acceptance.
 */
export async function startOrderForTrade(ctx: TxContext, input: { requestId: string; routeId: string; quoteId: string; tradeId: string; routeObligationId: string }): Promise<{ orderId: string }> {
  const peek = await ctx.tx
    .selectFrom('trader_order')
    .select(['id', 'trader_id'])
    .where('trade_request_id', '=', input.requestId)
    .where('route_id', '=', input.routeId)
    .where('status', '=', 'ACCEPTED')
    .executeTakeFirst();
  if (!peek) throw new DomainError('TRADER_ORDER_REQUIRED', 'the trader order behind this quote is no longer held');
  const order = await lockOrder(ctx, peek.id);
  if (order.status !== 'ACCEPTED') throw new DomainError('TRADER_ORDER_REQUIRED', 'the trader order behind this quote is no longer held');
  const profile = await ctx.tx.selectFrom('trader_profile').select(['client_id']).where('id', '=', order.trader_id).executeTakeFirstOrThrow();
  await ctx.tx
    .updateTable('trader_order')
    .set({
      status: 'IN_PROGRESS',
      trade_id: input.tradeId,
      route_obligation_id: input.routeObligationId,
      quote_id: input.quoteId,
      started_at: sql<Date>`inrp2p_now()`,
      // No reward exists any more; the columns and IX113 go with the next migration.
      reward_bps: 0,
      reward_inr_minor: 0n,
      version: order.version + 1,
    })
    .where('id', '=', order.id)
    .execute();
  await appendAudit(ctx, {
    action: 'trader_order.started', entityType: 'trader_order', entityId: order.id,
    before: { status: 'ACCEPTED' }, after: { status: 'IN_PROGRESS', trade_id: input.tradeId, route_obligation_id: input.routeObligationId },
  });
  await enqueueOutbox(ctx, { type: 'trader.order_started', aggregateType: 'trader_order', aggregateId: order.id, payload: { orderId: order.id, traderId: order.trader_id, clientId: profile.client_id } });
  return { orderId: order.id };
}

