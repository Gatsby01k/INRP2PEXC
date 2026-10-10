import { randomUUID } from 'node:crypto';
import { isDomainError } from '@inrp2p/kernel';
import { type Db, type TxContext, pgErrorCode } from '@inrp2p/db';
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

/** One order the sweep could not move this run; its step rolled back alone and is tried again on the next run. */
export interface SweepFailure {
  readonly step: string;
  readonly orderId: string;
  readonly code: string;
  readonly message: string;
}

export interface SweepReport {
  readonly offersExpired: number;
  readonly holdsEnded: number;
  readonly holdsWaitingOnQuote: number;
  readonly delivered: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly failures: readonly SweepFailure[];
}

/**
 * `trader_orders_sweep` (cron, every minute): offers that lapsed expire and are routed on, holds that ended give
 * their capacity back, and started orders catch up with their obligation (the trader's side confirmed, the order
 * completed or cancelled). Each order is its own step in its own transaction: a step that fails rolls back alone, is
 * reported with its code, and the sweep goes on to the next order — one bad order never holds capacity, offers or
 * completions of the others hostage. Every step is state-guarded, so the failed one is simply tried again next run;
 * an order the sweep keeps failing on surfaces as `trader_orders_overdue` (RUNBOOKS `trader-sweep-behind`).
 */
export async function runTraderSweep(db: Db): Promise<SweepReport> {
  const due = await dueOrders(db);
  const failures: SweepFailure[] = [];
  const report = { offersExpired: 0, holdsEnded: 0, holdsWaitingOnQuote: 0, delivered: 0, completed: 0, cancelled: 0, failures };
  const guarded = async <R>(name: string, orderId: string, fn: (ctx: TxContext) => Promise<R>): Promise<R | null> => {
    try {
      return await step(db, name, { orderId }, fn);
    } catch (e) {
      failures.push({ step: name, orderId, code: isDomainError(e) ? e.code : (pgErrorCode(e) ?? 'UNEXPECTED'), message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };
  for (const id of due.expiredOffers) {
    if (await guarded('trader_order.expire_offer', id, (ctx) => expireOfferInTx(ctx, id))) report.offersExpired += 1;
  }
  for (const id of due.endedHolds) {
    const out = await guarded('trader_order.end_hold', id, (ctx) => endHoldInTx(ctx, id));
    if (out === 'RELEASED') report.holdsEnded += 1;
    else if (out === 'QUOTE_LIVE') report.holdsWaitingOnQuote += 1;
  }
  for (const id of due.toReconcile) {
    const out = await guarded('trader_order.reconcile', id, (ctx) => reconcileOrderInTx(ctx, id));
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
