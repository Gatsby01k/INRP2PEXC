import { sql } from 'kysely';
import { DomainError, Money, Rate, requireText, requireUuid } from '@inrp2p/kernel';
import { type Executor, type TxContext, assertLockOrder } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type ClientActor, type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { postJournal, traderRewardAccrualJournal } from '@inrp2p/ledger';
import { publishTraderRate } from '@inrp2p/pricing';
import { obligationRemaining } from '@inrp2p/settlement';
import { releaseSubjectAssignment } from '@inrp2p/treasury';
import { lockTrader, lockTraderOfClient, traderClientCommand, type CloseReason, type OrderRow, closeUnstartedOrder, lockBlock, lockOrder, traderProgram } from '@inrp2p/trader-core';
import { freeCapacity, standingIssues } from './eligibility.ts';
import { directionForSide } from './routing.ts';
import { readBlocks, readStanding } from './standing.ts';

async function lockRequestRow(ctx: TxContext, requestId: string): Promise<{ status: string }> {
  assertLockOrder(ctx.tx, 'trade_request');
  const r = await sql<{ status: string }>`select status from trade_request where id = ${requestId} for update`.execute(ctx.tx);
  const row = r.rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'request not found');
  return row;
}

/** An order of this trader's client, by the reference the trader sees. Another trader's order is "not found". */
async function orderOfClient(ctx: TxContext, clientId: string, ref: string): Promise<{ id: string; trade_request_id: string }> {
  const row = await ctx.tx
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .select(['o.id', 'o.trade_request_id'])
    .where('o.ref', '=', requireText(ref, 'ref', 32))
    .where('t.client_id', '=', clientId)
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'order not found');
  return row;
}

async function businessNow(ctx: TxContext): Promise<Date> {
  const r = await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ctx.tx);
  return r.rows[0]!.now;
}

/**
 * `trader_order.accept` — a user who can commit for the trader, before the offer expires. The order's capacity is
 * held on its block at once, so it cannot be promised twice, and the trader's rate is published on its route as
 * the snapshot the quote will price on (source TRADER). The desk then has the hold window to send the client a
 * quote; if no trade opens in that time the capacity is given back.
 */
export function acceptOrder(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string }, member) => {
    const peek = await orderOfClient(ctx, member.clientId, p.ref);
    const request = await lockRequestRow(ctx, peek.trade_request_id);
    const trader = await lockTraderOfClient(ctx, member.clientId);
    const order = await lockOrder(ctx, peek.id);
    if (order.status !== 'OFFERED') throw new DomainError('TRADER_ORDER_NOT_LIVE', `this order is ${order.status.toLowerCase()}`);
    const now = await businessNow(ctx);
    if (now >= order.offer_expires_at) throw new DomainError('TRADER_ORDER_EXPIRED', 'this offer has expired');
    if (request.status !== 'OPEN' && request.status !== 'QUOTED') throw new DomainError('TRADER_ORDER_NOT_LIVE', 'the other side no longer needs this order');
    const { standing } = await readStanding(ctx.tx, trader.id);
    const issues = standingIssues(standing);
    if (issues.length > 0) throw new DomainError('TRADER_NOT_ELIGIBLE', 'you cannot accept orders right now', { issues });

    const facts = (await readBlocks(ctx.tx, trader.id)).find((b) => b.id === order.block_id)!;
    const block = await lockBlock(ctx, order.block_id);
    if (block.status !== 'ACTIVE') throw new DomainError('TRADER_NOT_ELIGIBLE', 'this side is paused', { issues: ['BLOCK_PAUSED'] });
    if (block.rate_micro !== order.rate_micro) throw new DomainError('TRADER_ORDER_NOT_LIVE', 'your rate changed since this offer was made');
    // What this block can still hold, not counting this very offer.
    const free = freeCapacity({ ...facts, capacityMinor: block.capacity_minor, reservedMinor: block.reserved_minor, offeredMinor: facts.offeredMinor - order.capacity_minor });
    if (order.capacity_minor > free) throw new DomainError('CAPACITY_INSUFFICIENT', 'this order no longer fits your available capacity');

    const program = await traderProgram(ctx.tx);
    await ctx.tx
      .updateTable('trader_block')
      .set({ reserved_minor: block.reserved_minor + order.capacity_minor, updated_at: sql<Date>`inrp2p_now()`, version: block.version + 1 })
      .where('id', '=', block.id)
      .execute();
    const snapshot = await publishTraderRate(ctx, { routeId: order.route_id, direction: directionForSide(order.side), rate: Rate.ofMicro(order.rate_micro, 'ROUTE') });
    const updated = await ctx.tx
      .updateTable('trader_order')
      .set({
        status: 'ACCEPTED',
        accepted_at: sql<Date>`inrp2p_now()`,
        accepted_by: member.userId,
        hold_until: sql<Date>`inrp2p_now() + make_interval(secs => ${program.holdTtlSeconds})`,
        route_rate_snapshot_id: snapshot.snapshotId,
        version: order.version + 1,
      })
      .where('id', '=', order.id)
      .returning(['hold_until'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'trader_order.accepted', entityType: 'trader_order', entityId: order.id,
      before: { status: 'OFFERED' }, after: { status: 'ACCEPTED', held: order.capacity_minor.toString(), snapshot_id: snapshot.snapshotId, hold_until: updated.hold_until },
    });
    await enqueueOutbox(ctx, { type: 'trader.order_accepted', aggregateType: 'trader_order', aggregateId: order.id, payload: { orderId: order.id, traderId: trader.id, requestId: order.trade_request_id } });
    return { status: 'ACCEPTED' as const, holdUntil: updated.hold_until!.toISOString() };
  });
}

/** `trader_order.decline` — a user who can commit, while the offer is open. The request goes to the next trader. */
export function declineOrder(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; reason?: string | null }, member) => {
    const peek = await orderOfClient(ctx, member.clientId, p.ref);
    await lockTraderOfClient(ctx, member.clientId);
    const order = await lockOrder(ctx, peek.id);
    if (order.status !== 'OFFERED') throw new DomainError('TRADER_ORDER_NOT_LIVE', `this order is ${order.status.toLowerCase()}`);
    const note = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim().slice(0, 200) : 'Declined by you.';
    await closeUnstartedOrder(ctx, order, 'DECLINED', null, note);
    return { status: 'DECLINED' as const };
  });
}

async function liveQuoteOnOrder(ctx: TxContext, order: OrderRow): Promise<string | null> {
  const q = await ctx.tx
    .selectFrom('quote')
    .select('ref')
    .where('trade_request_id', '=', order.trade_request_id)
    .where('route_id', '=', order.route_id)
    .where('status', '=', 'SENT')
    .where('expires_at', '>', sql<Date>`inrp2p_now()`)
    .executeTakeFirst();
  return q?.ref ?? null;
}

/**
 * `trader_order.release` — `traders:assign`, with a reason. The desk withdraws an offer or gives back an accepted
 * order it will not use. Not while a quote on it is still live: cancel the quote first, so no trade can open on
 * capacity that was just given back.
 */
export function releaseOrder(actor: OperatorActor) {
  return operatorCommand(actor, 'traders:assign', async (ctx, p: { orderId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 300);
    const peek = await ctx.tx.selectFrom('trader_order').select(['trade_request_id', 'trader_id']).where('id', '=', requireUuid(p.orderId, 'orderId')).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', 'order not found');
    await lockRequestRow(ctx, peek.trade_request_id);
    await lockTrader(ctx, peek.trader_id);
    const order = await lockOrder(ctx, p.orderId);
    if (order.status === 'ACCEPTED') {
      const live = await liveQuoteOnOrder(ctx, order);
      if (live) throw new DomainError('TRADER_ORDER_NOT_LIVE', `quote ${live} is still live on this order; cancel it first`);
      await closeUnstartedOrder(ctx, order, 'RELEASED', 'DESK_RELEASED', `INRP2P released it: ${reason}`);
    } else if (order.status === 'OFFERED') {
      await closeUnstartedOrder(ctx, order, 'WITHDRAWN', 'DESK_RELEASED', `INRP2P withdrew the offer: ${reason}`);
    } else {
      throw new DomainError('TRADER_ORDER_NOT_LIVE', `order ${order.ref} is ${order.status}`);
    }
    return { status: order.status === 'ACCEPTED' ? ('RELEASED' as const) : ('WITHDRAWN' as const) };
  });
}

/** System step: an offer nobody answered in time expires; the request goes to the next trader. */
export async function expireOfferInTx(ctx: TxContext, orderId: string): Promise<boolean> {
  const peek = await ctx.tx.selectFrom('trader_order').select(['trader_id']).where('id', '=', requireUuid(orderId, 'orderId')).executeTakeFirst();
  if (!peek) return false;
  await lockTrader(ctx, peek.trader_id);
  const order = await lockOrder(ctx, orderId);
  if (order.status !== 'OFFERED' || (await businessNow(ctx)) < order.offer_expires_at) return false;
  await closeUnstartedOrder(ctx, order, 'EXPIRED', 'OFFER_EXPIRED');
  return true;
}

/**
 * System step: an accepted order whose hold has ended without a trade gives its capacity back — unless a quote on it
 * is still live, in which case the client may yet accept and the order waits for that quote to end.
 */
export async function endHoldInTx(ctx: TxContext, orderId: string): Promise<'RELEASED' | 'QUOTE_LIVE' | 'NOT_DUE'> {
  const peek = await ctx.tx.selectFrom('trader_order').select(['trader_id', 'trade_request_id']).where('id', '=', requireUuid(orderId, 'orderId')).executeTakeFirst();
  if (!peek) return 'NOT_DUE';
  await lockRequestRow(ctx, peek.trade_request_id);
  await lockTrader(ctx, peek.trader_id);
  const order = await lockOrder(ctx, orderId);
  if (order.status !== 'ACCEPTED' || !order.hold_until || (await businessNow(ctx)) < order.hold_until) return 'NOT_DUE';
  if (await liveQuoteOnOrder(ctx, order)) return 'QUOTE_LIVE';
  await closeUnstartedOrder(ctx, order, 'RELEASED', 'HOLD_ENDED');
  return 'RELEASED';
}

export type ReconcileOutcome = 'COMPLETED' | 'CANCELLED' | 'DELIVERED' | 'UNCHANGED';

/**
 * System step (also run straight after the desk confirms a trader's settlement): brings a started order up to date
 * with its route obligation.
 *
 * - The trader's own side fully allocated → `delivered_at` is set once and the trader is told its payment arrived.
 * - The obligation SETTLED (both sides) → the order completes: its capacity is used (it leaves the block's capacity
 *   and its hold), the reward accrues in the ledger (`trader_reward:{order}:accrue`), and the delivery address, if
 *   it had one, closes.
 * - The obligation CANCELLED (the trade was cancelled before the trader's side moved) → the order is cancelled and
 *   its capacity given back untouched.
 */
export async function reconcileOrderInTx(ctx: TxContext, orderId: string): Promise<ReconcileOutcome> {
  const peek = await ctx.tx.selectFrom('trader_order').select(['trader_id']).where('id', '=', requireUuid(orderId, 'orderId')).executeTakeFirst();
  if (!peek) return 'UNCHANGED';
  await lockTrader(ctx, peek.trader_id);
  const order = await lockOrder(ctx, orderId);
  if (order.status !== 'IN_PROGRESS' || !order.route_obligation_id) return 'UNCHANGED';
  const obligation = await ctx.tx.selectFrom('route_obligation').select(['status']).where('id', '=', order.route_obligation_id).executeTakeFirstOrThrow();
  let outcome: ReconcileOutcome = 'UNCHANGED';

  if (obligation.status !== 'CANCELLED' && !order.delivered_at) {
    const remaining = await obligationRemaining(ctx.tx, order.route_obligation_id);
    if (remaining.routeDelivers.isZero()) {
      await ctx.tx.updateTable('trader_order').set({ delivered_at: sql<Date>`inrp2p_now()`, version: order.version + 1 }).where('id', '=', order.id).execute();
      await appendAudit(ctx, { action: 'trader_order.delivered', entityType: 'trader_order', entityId: order.id, after: { side: order.side } });
      await enqueueOutbox(ctx, { type: 'trader.payment_confirmed', aggregateType: 'trader_order', aggregateId: order.id, payload: { orderId: order.id, traderId: order.trader_id } });
      outcome = 'DELIVERED';
    }
  }

  if (obligation.status === 'SETTLED' || obligation.status === 'CANCELLED') {
    const current = await ctx.tx.selectFrom('trader_order').select(['version']).where('id', '=', order.id).executeTakeFirstOrThrow();
    const block = await lockBlock(ctx, order.block_id);
    const completed = obligation.status === 'SETTLED';
    await ctx.tx
      .updateTable('trader_block')
      .set({
        reserved_minor: block.reserved_minor - order.capacity_minor,
        ...(completed ? { capacity_minor: block.capacity_minor - order.capacity_minor } : {}),
        updated_at: sql<Date>`inrp2p_now()`,
        version: block.version + 1,
      })
      .where('id', '=', block.id)
      .execute();
    const reason: CloseReason | null = completed ? null : 'TRADE_CANCELLED';
    await ctx.tx
      .updateTable('trader_order')
      .set({
        status: completed ? 'COMPLETED' : 'CANCELLED',
        ...(completed ? { completed_at: sql<Date>`inrp2p_now()` } : {}),
        closed_at: sql<Date>`inrp2p_now()`,
        closed_by: `SYSTEM:${ctx.commandName}`,
        close_reason: completed ? null : 'The trade was cancelled before your side was due. Nothing is held for it any more.',
        version: current.version + 1,
      })
      .where('id', '=', order.id)
      .execute();
    if (completed && order.reward_inr_minor !== null && order.reward_inr_minor > 0n) {
      await postJournal(ctx, traderRewardAccrualJournal({ orderId: order.id, traderId: order.trader_id, amount: Money.ofMinor(order.reward_inr_minor, 'INR') }));
    }
    if (order.side === 'SELL_USDT') {
      await releaseSubjectAssignment(ctx, { subject: { kind: 'ROUTE_OBLIGATION', routeObligationId: order.route_obligation_id }, reason: completed ? 'OBLIGATION_SETTLED' : 'OBLIGATION_CANCELLED' });
    }
    await appendAudit(ctx, {
      action: completed ? 'trader_order.completed' : 'trader_order.cancelled', entityType: 'trader_order', entityId: order.id,
      before: { status: 'IN_PROGRESS' },
      after: { status: completed ? 'COMPLETED' : 'CANCELLED', capacity_used: completed ? order.capacity_minor.toString() : '0', reward: order.reward_inr_minor === null ? null : Money.ofMinor(order.reward_inr_minor, 'INR'), reason },
    });
    await enqueueOutbox(ctx, {
      type: completed ? 'trader.order_completed' : 'trader.order_cancelled',
      aggregateType: 'trader_order',
      aggregateId: order.id,
      payload: { orderId: order.id, traderId: order.trader_id, reason },
    });
    outcome = completed ? 'COMPLETED' : 'CANCELLED';
  }
  return outcome;
}

/** The trader order started on a trade, if the trade is on a trader route. */
export async function orderOfTrade(ex: Executor, tradeId: string): Promise<string | null> {
  const r = await ex.selectFrom('trader_order').select('id').where('trade_id', '=', requireUuid(tradeId, 'tradeId')).executeTakeFirst();
  return r?.id ?? null;
}

/** Orders the sweep has work for, each to be handled in its own system step. */
export async function dueOrders(ex: Executor, limit = 200): Promise<{ expiredOffers: string[]; endedHolds: string[]; toReconcile: string[] }> {
  const expired = await sql<{ id: string }>`
    select id from trader_order where status = 'OFFERED' and offer_expires_at <= inrp2p_now() order by offer_expires_at limit ${limit}`.execute(ex);
  const holds = await sql<{ id: string }>`
    select id from trader_order where status = 'ACCEPTED' and hold_until <= inrp2p_now() order by hold_until limit ${limit}`.execute(ex);
  const started = await sql<{ id: string }>`
    select o.id from trader_order o join route_obligation r on r.id = o.route_obligation_id
    where o.status = 'IN_PROGRESS'
      and (r.status in ('SETTLED', 'CANCELLED')
           or (o.delivered_at is null and inrp2p_route_obligation_side(r.id, 'ROUTE_DELIVERS')
                 <= (select coalesce(sum(a.amount_minor), 0) from route_settlement_allocation a where a.route_obligation_id = r.id and a.side = 'ROUTE_DELIVERS')))
    order by o.started_at limit ${limit}`.execute(ex);
  return { expiredOffers: expired.rows.map((r) => r.id), endedHolds: holds.rows.map((r) => r.id), toReconcile: started.rows.map((r) => r.id) };
}
