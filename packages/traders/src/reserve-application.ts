import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, actorLabel, assertSecondApprover, operatorCommand } from '@inrp2p/identity';
import { lockObligation, routeDeliveryOpen } from '@inrp2p/settlement';
import { lockOrder, lockTrader, type OrderRow } from '@inrp2p/trader-core';
import { CLIENT_FUNDED_STATES } from './delivery.ts';
import { reserveFigures } from '@inrp2p/trader-core';

/**
 * Holding a trader's Security Reserve against rupees one of its orders owes (production task D3, TD-21).
 *
 * The mechanism only, with every decision of policy left where it belongs: the desk decides, per case and on the record,
 * that a trader's rupees for an order are not coming — one person asks with the reason, another approves, each with
 * step-up. The reserve is USDT and the debt is rupees: nothing is converted and nothing moves, the amount is only kept
 * back, not withdrawable, until the hold is released or the order ends. The trader is told. Any use of a reserve beyond
 * that is an owner decision (TECH_DEBT TD-21). The database holds the same rules (IX094).
 */

interface ApplicationRow {
  id: string; ref: string; trader_id: string; trader_order_id: string; route_obligation_id: string;
  amount_minor: bigint; status: string; requested_by: string;
}

async function lockApplicationChain(ctx: TxContext, applicationId: string): Promise<{ app: ApplicationRow; order: OrderRow }> {
  const id = requireUuid(applicationId, 'applicationId');
  const peek = await ctx.tx.selectFrom('trader_reserve_application').select(['trader_id', 'trader_order_id', 'route_obligation_id']).where('id', '=', id).executeTakeFirst();
  if (!peek) throw new DomainError('NOT_FOUND', 'reserve application not found');
  // Lock order: the trader, its order, the obligation, then the application row (ARCHITECTURE §4).
  await lockTrader(ctx, peek.trader_id);
  const order = await lockOrder(ctx, peek.trader_order_id);
  await lockObligation(ctx, peek.route_obligation_id);
  const app = await ctx.tx
    .selectFrom('trader_reserve_application')
    .select(['id', 'ref', 'trader_id', 'trader_order_id', 'route_obligation_id', 'amount_minor', 'status', 'requested_by'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { app, order };
}

/**
 * The checks a hold must pass when it is asked for and again when it is approved: the order owes rupees it has not paid,
 * and the reserve has that much free. Nothing is converted: the amount is USDT kept back while the INR debt stays open.
 */
async function assertApplicable(ctx: TxContext, order: OrderRow, amountMinor: bigint): Promise<void> {
  if (order.status !== 'IN_PROGRESS' || !order.trade_id || !order.route_obligation_id) {
    throw new DomainError('TRADER_ORDER_NOT_LIVE', `order ${order.ref} is ${order.status.toLowerCase()}`);
  }
  const trade = await ctx.tx.selectFrom('trade').select('lifecycle_state').where('id', '=', order.trade_id).executeTakeFirstOrThrow();
  if (!CLIENT_FUNDED_STATES.has(trade.lifecycle_state)) {
    throw new DomainError('TRADER_ACTION_NOT_DUE', `the trader's side of ${order.ref} is not due until the other side is funded`);
  }
  const open = await routeDeliveryOpen(ctx.tx, order.route_obligation_id);
  if (open <= 0n) throw new DomainError('INVALID_TRANSITION', `order ${order.ref} owes nothing that is not already delivered or on its way`);
  if (amountMinor <= 0n) throw new DomainError('INVALID_AMOUNT', 'name how much USDT of the reserve to keep back');
  // Free: the balance less withdrawals on their way out and applications or holds already approved or in flight.
  const figures = await reserveFigures(ctx.tx, order.trader_id);
  const free = figures.balance.minor - figures.pendingRelease.minor - figures.applying.minor;
  if (amountMinor > free) {
    const shown = Money.ofMinor(free > 0n ? free : 0n, 'USDT').toDecimalString();
    throw new DomainError('TRADER_RESERVE_SHORT', `the reserve holds ${shown} USDT free`, { free: shown });
  }
}

/**
 * `trader_reserve.request_application` — `trader_reserve:apply` (⧗), with the reason. On an order that owes INR it asks to
 * **hold** part of the reserve (an amount of USDT, named here): the INR debt stays open, nothing is converted or posted,
 * and that part of the reserve cannot be withdrawn until the hold is released or the owner's terms exist (TD-21). Nothing
 * is held until someone else approves it.
 */
export function requestReserveApplication(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_reserve:apply', async (ctx, p: { orderId: string; amount?: string | null; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why the trader’s side is not coming (at least 10 characters)');
    const orderId = requireUuid(p.orderId, 'orderId');
    const peek = await ctx.tx.selectFrom('trader_order').select('trader_id').where('id', '=', orderId).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', 'order not found');
    await lockTrader(ctx, peek.trader_id);
    const order = await lockOrder(ctx, orderId);
    if (!order.route_obligation_id || order.status !== 'IN_PROGRESS') throw new DomainError('TRADER_ORDER_NOT_LIVE', `order ${order.ref} is ${order.status.toLowerCase()}`);
    await lockObligation(ctx, order.route_obligation_id);
    const live = await ctx.tx.selectFrom('trader_reserve_application').select('ref').where('trader_order_id', '=', order.id).where('status', 'in', ['REQUESTED', 'APPROVED']).executeTakeFirst();
    if (live) throw new DomainError('INVALID_TRANSITION', `reserve hold ${live.ref} is already open for this order`);
    // A trader funding an escrow owes nothing until it has: only rupees it owes a client can be left unpaid (ADR 0019).
    if (order.side !== 'BUY_USDT') throw new DomainError('INVALID_ARGUMENT', `order ${order.ref} puts USDT in escrow first: the client pays only once it is there`);
    if (!p.amount) throw new DomainError('INVALID_AMOUNT', `order ${order.ref} owes INR: name how much USDT of the reserve to hold while the owner's terms for converting it do not exist`);
    const amount = Money.parse(p.amount, 'USDT');
    await assertApplicable(ctx, order, amount.minor);
    const row = await ctx.tx
      .insertInto('trader_reserve_application')
      .values({ trader_id: order.trader_id, trader_order_id: order.id, route_obligation_id: order.route_obligation_id, amount_minor: amount.minor, reason, requested_by: actor.userId })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'trader_reserve.application_requested', entityType: 'trader_profile', entityId: order.trader_id,
      after: { ref: row.ref, order: order.ref, amount, reason },
    });
    return { applicationId: row.id, ref: row.ref, amount: amount.toDecimalString() };
  });
}

/**
 * `trader_reserve.approve_application` — `trader_reserve:approve` (⧗✱), by someone other than the requester. Holds the
 * amount out of the reserve and tells the trader. It waits for the INR, an unwind, or the owner's terms.
 */
export function approveReserveApplication(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_reserve:approve', async (ctx, p: { applicationId: string; note?: string | null }, decision) => {
    const { app, order } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `reserve hold ${app.ref} is ${app.status.toLowerCase()}`);
    assertSecondApprover(decision, app.requested_by, actor.userId);
    await assertApplicable(ctx, order, app.amount_minor);
    const note = p.note ? requireText(p.note, 'note', 500) : null;
    await ctx.tx
      .updateTable('trader_reserve_application')
      .set({ status: 'APPROVED', decided_by: actor.userId, decided_at: sql<Date>`inrp2p_now()`, decision_note: note })
      .where('id', '=', app.id)
      .execute();
    const amount = Money.ofMinor(app.amount_minor, 'USDT');
    await appendAudit(ctx, {
      action: 'trader_reserve.application_approved', entityType: 'trader_profile', entityId: app.trader_id,
      before: { status: 'REQUESTED' },
      after: { status: 'APPROVED', ref: app.ref, order: order.ref, amount, requested_by: app.requested_by, approved_by: actor.userId },
    });
    await enqueueOutbox(ctx, {
      type: 'trader.reserve_issue', aggregateType: 'trader_profile', aggregateId: app.trader_id,
      payload: { traderId: app.trader_id, reason: 'RESERVE_HELD', amount: amount.toDecimalString(), orderRef: order.ref },
    });
    return { ref: app.ref, status: 'APPROVED' as const, amount: amount.toDecimalString() };
  });
}

/** `trader_reserve.reject_application` — `trader_reserve:approve` (⧗), by someone other than the requester. */
export function rejectReserveApplication(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_reserve:approve', async (ctx, p: { applicationId: string; note: string }) => {
    const { app } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `reserve hold ${app.ref} is ${app.status.toLowerCase()}`);
    if (app.requested_by === actor.userId) throw new DomainError('INVALID_ARGUMENT', 'the requester withdraws an application; someone else declines it');
    const note = requireText(p.note, 'note', 500);
    await ctx.tx
      .updateTable('trader_reserve_application')
      .set({ status: 'REJECTED', decided_by: actor.userId, decided_at: sql<Date>`inrp2p_now()`, decision_note: note, closed_at: sql<Date>`inrp2p_now()`, closed_by: actorLabel(ctx), close_reason: note })
      .where('id', '=', app.id)
      .execute();
    await appendAudit(ctx, { action: 'trader_reserve.application_rejected', entityType: 'trader_profile', entityId: app.trader_id, before: { status: 'REQUESTED' }, after: { status: 'REJECTED', ref: app.ref, note } });
    return { ref: app.ref, status: 'REJECTED' as const };
  });
}

/** `trader_reserve.cancel_application` — the requester withdraws it while it waits for approval (`trader_reserve:apply`, ⧗). */
export function cancelReserveApplication(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_reserve:apply', async (ctx, p: { applicationId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const { app } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `reserve hold ${app.ref} is ${app.status.toLowerCase()}`);
    if (app.requested_by !== actor.userId) throw new DomainError('FORBIDDEN', 'only the requester withdraws an application; someone else declines it');
    await closeApplication(ctx, app, 'CANCELLED', reason);
    return { ref: app.ref, status: 'CANCELLED' as const };
  });
}

/**
 * `trader_reserve.end_application` — `trader_reserve:approve` (⧗). An approved hold is released with the reason: the
 * amount is the trader's again. An order that completes or is cancelled ends what is still open on it by itself.
 */
export function endReserveApplication(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_reserve:approve', async (ctx, p: { applicationId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const { app } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'APPROVED') throw new DomainError('INVALID_TRANSITION', `reserve hold ${app.ref} is ${app.status.toLowerCase()}`);
    await closeApplication(ctx, app, 'CANCELLED', reason);
    return { ref: app.ref, status: 'CANCELLED' as const };
  });
}

async function closeApplication(ctx: TxContext, app: ApplicationRow, status: 'CANCELLED', reason: string): Promise<void> {
  await ctx.tx
    .updateTable('trader_reserve_application')
    .set({ status, closed_at: sql<Date>`inrp2p_now()`, closed_by: actorLabel(ctx), close_reason: reason })
    .where('id', '=', app.id)
    .execute();
  await appendAudit(ctx, { action: 'trader_reserve.application_cancelled', entityType: 'trader_profile', entityId: app.trader_id, before: { status: app.status }, after: { status, ref: app.ref, reason } });
}
