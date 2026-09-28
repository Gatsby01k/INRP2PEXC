import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import { type TraderOrderStatus, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';

/** Why an order stopped holding a trader's attention or capacity — shown to the trader in its own words. */
export type CloseReason =
  | 'TRADER_OFFLINE'
  | 'TRADER_PAUSED'
  | 'ASSIGNMENTS_DISABLED'
  | 'RATE_CHANGED'
  | 'REQUEST_CLOSED'
  | 'HOLD_ENDED'
  | 'OFFER_EXPIRED'
  | 'DESK_RELEASED'
  | 'TRADE_CANCELLED';

export const CLOSE_REASON_TEXT: Readonly<Record<CloseReason, string>> = Object.freeze({
  TRADER_OFFLINE: 'You switched off before responding.',
  TRADER_PAUSED: 'Your trader account was paused.',
  ASSIGNMENTS_DISABLED: 'New assignments were paused by INRP2P.',
  RATE_CHANGED: 'You changed your rate, so the offer at the old rate was withdrawn.',
  REQUEST_CLOSED: 'The other side no longer needs it.',
  HOLD_ENDED: 'The trade was not confirmed in time. Nothing is held for it any more.',
  OFFER_EXPIRED: 'The offer expired before it was accepted.',
  DESK_RELEASED: 'INRP2P released it. Nothing is held for it any more.',
  TRADE_CANCELLED: 'The trade was cancelled before your side was due. Nothing is held for it any more.',
});

export interface OrderRow {
  readonly id: string;
  readonly ref: string;
  readonly trader_id: string;
  readonly block_id: string;
  readonly route_id: string;
  readonly trade_request_id: string;
  readonly side: 'BUY_USDT' | 'SELL_USDT';
  readonly base_minor: bigint;
  readonly inr_minor: bigint;
  readonly rate_micro: bigint;
  readonly capacity_minor: bigint;
  readonly status: TraderOrderStatus;
  readonly offer_expires_at: Date;
  readonly hold_until: Date | null;
  readonly route_rate_snapshot_id: string | null;
  readonly trade_id: string | null;
  readonly route_obligation_id: string | null;
  readonly delivered_at: Date | null;
  readonly reward_inr_minor: bigint | null;
  readonly planned_client_rate_micro: bigint | null;
  readonly version: number;
}

const ORDER_COLUMNS = [
  'id', 'ref', 'trader_id', 'block_id', 'route_id', 'trade_request_id', 'side', 'base_minor', 'inr_minor', 'rate_micro', 'capacity_minor', 'status',
  'offer_expires_at', 'hold_until', 'route_rate_snapshot_id', 'trade_id', 'route_obligation_id', 'delivered_at', 'reward_inr_minor', 'planned_client_rate_micro', 'version',
] as const;

/** One order `FOR UPDATE`, in the global lock order. */
export async function lockOrder(ctx: TxContext, orderId: string): Promise<OrderRow> {
  assertLockOrder(ctx.tx, 'trader_order');
  const row = await ctx.tx.selectFrom('trader_order').select(ORDER_COLUMNS).where('id', '=', orderId).forUpdate().executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'order not found');
  return row;
}

export async function readOrder(ctx: TxContext, orderId: string): Promise<OrderRow> {
  return ctx.tx.selectFrom('trader_order').select(ORDER_COLUMNS).where('id', '=', orderId).executeTakeFirstOrThrow();
}

/** A block `FOR UPDATE`, after the order it serves (lock order). */
export async function lockBlock(ctx: TxContext, blockId: string) {
  assertLockOrder(ctx.tx, 'trader_block');
  return ctx.tx.selectFrom('trader_block').selectAll().where('id', '=', blockId).forUpdate().executeTakeFirstOrThrow();
}

/** Gives an order's held capacity back to its block. The caller holds the order and block locks. */
export async function releaseHeld(ctx: TxContext, order: OrderRow): Promise<void> {
  const block = await lockBlock(ctx, order.block_id);
  await ctx.tx
    .updateTable('trader_block')
    .set({ reserved_minor: block.reserved_minor - order.capacity_minor, updated_at: sql<Date>`inrp2p_now()`, version: block.version + 1 })
    .where('id', '=', block.id)
    .execute();
}

/**
 * Ends an order that never started: an offer that is withdrawn, declined or expires, or an accepted order whose
 * hold ends. An accepted one gives its capacity back. Emits the event that lets the desk (and, for a withdrawn or
 * expired offer, the routing) move on.
 */
export async function closeUnstartedOrder(
  ctx: TxContext,
  order: OrderRow,
  to: 'DECLINED' | 'EXPIRED' | 'WITHDRAWN' | 'RELEASED',
  reason: CloseReason | null,
  note: string | null = null,
): Promise<void> {
  const allowed = to === 'RELEASED' ? order.status === 'ACCEPTED' : order.status === 'OFFERED';
  if (!allowed) throw new DomainError('TRADER_ORDER_NOT_LIVE', `order ${order.ref} is ${order.status}`);
  if (to === 'RELEASED') await releaseHeld(ctx, order);
  const text = note ?? (reason ? CLOSE_REASON_TEXT[reason] : null);
  await ctx.tx
    .updateTable('trader_order')
    .set({ status: to, closed_at: sql<Date>`inrp2p_now()`, closed_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`, close_reason: text, version: order.version + 1 })
    .where('id', '=', order.id)
    .execute();
  await appendAudit(ctx, {
    action: `trader_order.${to.toLowerCase()}`, entityType: 'trader_order', entityId: order.id,
    before: { status: order.status }, after: { status: to, reason, note: text },
  });
  await enqueueOutbox(ctx, {
    type: `trader.order_${to.toLowerCase()}`,
    aggregateType: 'trader_order',
    aggregateId: order.id,
    payload: { orderId: order.id, requestId: order.trade_request_id, traderId: order.trader_id, reason },
  });
}

/**
 * Withdraws a trader's pending offers (all of them, or one block's) when it can no longer take them: it went
 * offline, was paused, had assignments stopped, or changed the rate the offer was made at. Each withdrawn request
 * is routed on. The caller holds the trader lock; order locks come next, before any block lock.
 */
export async function withdrawOffers(ctx: TxContext, scope: { traderId: string; blockId?: string }, reason: CloseReason): Promise<number> {
  let q = ctx.tx.selectFrom('trader_order').select('id').where('trader_id', '=', scope.traderId).where('status', '=', 'OFFERED');
  if (scope.blockId) q = q.where('block_id', '=', scope.blockId);
  const offers = await q.orderBy('id').execute();
  for (const { id } of offers) {
    const order = await lockOrder(ctx, id);
    if (order.status !== 'OFFERED') continue;
    await closeUnstartedOrder(ctx, order, 'WITHDRAWN', reason);
  }
  return offers.length;
}
