import { sql } from 'kysely';
import { DomainError, Money, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { lockTrader } from './access.ts';
import { closeUnstartedOrder, lockOrder } from './offers.ts';
import { traderProgram } from './policy.ts';

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
 * The reward model (V1), explicit and configured — never inferred from a market.
 *
 * A trader's rate is its own price; what it makes on that price is its business and appears nowhere here. What
 * INRP2P itself pays a trader is a reward: `reward_bps` (the trader's override, else the programme's) of the
 * order's INR value at the trader's rate, rounded down, fixed when the order starts, and accrued in the ledger when
 * the order completes. With no rate configured there is no reward, and the product says so.
 */
export function rewardFor(inrMinor: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new DomainError('INVALID_ARGUMENT', 'reward basis points must be a non-negative whole number');
  return (inrMinor * BigInt(bps)) / 10_000n;
}

/**
 * Called by the request commands when a request closes (declined, withdrawn, expired): a live offer is withdrawn
 * and an accepted order gives its capacity back. The caller holds the request lock.
 */
export async function closeOrdersForRequest(ctx: TxContext, requestId: string): Promise<number> {
  const live = await ctx.tx.selectFrom('trader_order').select(['id', 'trader_id']).where('trade_request_id', '=', requestId).where('status', 'in', ['OFFERED', 'ACCEPTED']).execute();
  for (const o of live) {
    await lockTrader(ctx, o.trader_id);
    const order = await lockOrder(ctx, o.id);
    if (order.status === 'OFFERED') await closeUnstartedOrder(ctx, order, 'WITHDRAWN', 'REQUEST_CLOSED');
    else if (order.status === 'ACCEPTED') await closeUnstartedOrder(ctx, order, 'RELEASED', 'REQUEST_CLOSED');
  }
  return live.length;
}

/** The trader id behind a route, or null for a desk route. */
export async function traderOfRoute(ex: Executor, routeId: string): Promise<string | null> {
  const r = await ex.selectFrom('liquidity_route').select('trader_id').where('id', '=', requireUuid(routeId, 'routeId')).executeTakeFirst();
  return r?.trader_id ?? null;
}

export interface OrderForQuote {
  readonly orderId: string;
  readonly ref: string;
  readonly snapshotId: string;
  readonly baseMinor: bigint;
  readonly inrMinor: bigint;
  readonly holdUntil: Date;
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
  return { orderId: order.id, ref: order.ref, snapshotId: order.route_rate_snapshot_id!, baseMinor: order.base_minor, inrMinor: order.inr_minor, holdUntil: order.hold_until };
}

/**
 * The client accepted a quote on a trader route: the trader's order starts, bound to the trade and its route
 * obligation (the database checks they are the accepted terms). The reward, if the programme pays one, is fixed
 * now from the order's INR value, so a later change to the programme never changes what this order earns. Runs in
 * the acceptance transaction; any failure here fails the acceptance.
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
  const program = await traderProgram(ctx.tx);
  const profile = await ctx.tx.selectFrom('trader_profile').select(['reward_bps', 'client_id']).where('id', '=', order.trader_id).executeTakeFirstOrThrow();
  const bps = profile.reward_bps ?? program.rewardBps;
  const reward = bps === null ? null : rewardFor(order.inr_minor, bps);
  await ctx.tx
    .updateTable('trader_order')
    .set({
      status: 'IN_PROGRESS',
      trade_id: input.tradeId,
      route_obligation_id: input.routeObligationId,
      quote_id: input.quoteId,
      started_at: sql<Date>`inrp2p_now()`,
      reward_bps: bps,
      reward_inr_minor: reward,
      version: order.version + 1,
    })
    .where('id', '=', order.id)
    .execute();
  await appendAudit(ctx, {
    action: 'trader_order.started', entityType: 'trader_order', entityId: order.id,
    before: { status: 'ACCEPTED' }, after: { status: 'IN_PROGRESS', trade_id: input.tradeId, route_obligation_id: input.routeObligationId, reward_bps: bps, reward: reward === null ? null : Money.ofMinor(reward, 'INR') },
  });
  await enqueueOutbox(ctx, { type: 'trader.order_started', aggregateType: 'trader_order', aggregateId: order.id, payload: { orderId: order.id, traderId: order.trader_id, clientId: profile.client_id } });
  return { orderId: order.id };
}

