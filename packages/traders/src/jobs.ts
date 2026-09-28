import { randomUUID } from 'node:crypto';
import type { Db, TxContext } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import type { OutboxHandler } from '@inrp2p/outbox';
import { dueOrders, endHoldInTx, expireOfferInTx, orderOfTrade, reconcileOrderInTx } from './orders.ts';
import { autoAssignInTx, rerouteRequestInTx } from './routing.ts';

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

/** One system step through the command pipeline: its own transaction, audit and idempotency key (FI-50). */
async function step<R>(db: Db, name: string, payload: Record<string, unknown>, fn: (ctx: TxContext) => Promise<R>, key?: string): Promise<R> {
  const out = await executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: SYSTEM, payload, idempotencyKey: key ?? randomUUID(), financial: true });
  return out.result;
}

export interface SweepReport {
  readonly offersExpired: number;
  readonly holdsEnded: number;
  readonly holdsWaitingOnQuote: number;
  readonly delivered: number;
  readonly completed: number;
  readonly cancelled: number;
}

/**
 * `trader_orders_sweep` (cron, every minute): offers that lapsed expire and are routed on, holds that ended give
 * their capacity back, and started orders catch up with their obligation (the trader's side confirmed, the order
 * completed or cancelled). Each order is its own step, so one failure never holds up the rest, and every step is
 * state-guarded — running the sweep twice changes nothing the first run did not.
 */
export async function runTraderSweep(db: Db): Promise<SweepReport> {
  const due = await dueOrders(db);
  const report = { offersExpired: 0, holdsEnded: 0, holdsWaitingOnQuote: 0, delivered: 0, completed: 0, cancelled: 0 };
  for (const id of due.expiredOffers) {
    if (await step(db, 'trader_order.expire_offer', { orderId: id }, (ctx) => expireOfferInTx(ctx, id))) report.offersExpired += 1;
  }
  for (const id of due.endedHolds) {
    const out = await step(db, 'trader_order.end_hold', { orderId: id }, (ctx) => endHoldInTx(ctx, id));
    if (out === 'RELEASED') report.holdsEnded += 1;
    else if (out === 'QUOTE_LIVE') report.holdsWaitingOnQuote += 1;
  }
  for (const id of due.toReconcile) {
    const out = await step(db, 'trader_order.reconcile', { orderId: id }, (ctx) => reconcileOrderInTx(ctx, id));
    if (out === 'COMPLETED') report.completed += 1;
    else if (out === 'CANCELLED') report.cancelled += 1;
    else if (out === 'DELIVERED') report.delivered += 1;
  }
  return report;
}

/** Runs the reconciliation of one order straight away — after the desk confirms one of its settlements. */
export function reconcileOrderNow(db: Db, orderId: string) {
  return step(db, 'trader_order.reconcile', { orderId }, (ctx) => reconcileOrderInTx(ctx, orderId));
}

const REROUTE_ON = new Set(['trader.order_declined', 'trader.order_expired', 'trader.order_withdrawn']);

/**
 * The trader programme's reactions to events:
 *
 * - an offer declined, expired or withdrawn → the request goes to the next eligible trader (one step, keyed by the
 *   event, so a redelivered event never offers twice);
 * - a new request, when the programme routes automatically → offered to the best eligible trader;
 * - a trade cancelled → its trader order, if any, is cancelled and its capacity given back.
 *
 * Every other `trader.*` event is read by the notification handler (and the desk reads the rows themselves).
 */
export function traderRoutingHandler(db: Db): OutboxHandler {
  return {
    name: 'trader_routing',
    handles: (type) => REROUTE_ON.has(type) || type === 'desk.new_request' || type === 'client.trade_cancelled',
    run: async (event) => {
      const p = (event.payload ?? {}) as { requestId?: unknown; tradeId?: unknown };
      if (REROUTE_ON.has(event.type) && typeof p.requestId === 'string') {
        const requestId = p.requestId;
        await step(db, 'trader_order.reroute', { requestId, event: event.id }, (ctx) => rerouteRequestInTx(ctx, requestId), `reroute:${event.id}`);
      } else if (event.type === 'desk.new_request' && typeof p.requestId === 'string') {
        const requestId = p.requestId;
        await step(db, 'trader_order.auto_assign', { requestId, event: event.id }, (ctx) => autoAssignInTx(ctx, requestId), `auto_assign:${event.id}`);
      } else if (event.type === 'client.trade_cancelled' && typeof p.tradeId === 'string') {
        const orderId = await orderOfTrade(db, p.tradeId);
        if (orderId) await step(db, 'trader_order.reconcile', { orderId, event: event.id }, (ctx) => reconcileOrderInTx(ctx, orderId), `reconcile:${event.id}`);
      }
    },
  };
}
