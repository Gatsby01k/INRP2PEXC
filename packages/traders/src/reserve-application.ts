import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, actorLabel, assertSecondApprover, operatorCommand } from '@inrp2p/identity';
import { allocateObligationDeliveryAddress } from '@inrp2p/treasury';
import {
  type ReserveApplicationRow, lockObligation, obligationDeliveryAddress, recordAppliedReserveDelivery, reserveSourceWallet, routeDeliveryOpen,
} from '@inrp2p/settlement';
import { assertPayoutsOpen } from '@inrp2p/trades';
import { lockOrder, lockTrader, type OrderRow, type TraderDeps } from '@inrp2p/trader-core';
import { CLIENT_FUNDED_STATES } from './delivery.ts';
import { reserveFigures } from './reserve.ts';

/**
 * Applying a trader's Security Reserve to USDT one of its own orders did not deliver (production task D3, TD-21;
 * migration 0029).
 *
 * The mechanism only, with every decision of policy left where it belongs: the desk decides, per case and on the
 * record, that a trader's USDT for an order is not coming — one person asks with the reason, another approves, each
 * with step-up. Approval holds that much of the reserve and issues the order's delivery address if the trader never
 * asked for it; custody then moves the USDT there with the existing external mechanism (this product never sends),
 * and the chain's finality makes it the order's delivery: one movement, one journal (Dr LIAB:TRADER_RESERVE /
 * Cr ASSET:ROUTE_RECEIVABLE). The trader is told.
 *
 * What is not decided here, and is refused rather than guessed: an INR shortfall (the reserve is USDT; applying it
 * would need a conversion rate) and any use of a reserve beyond the trader's own undelivered USDT (a forfeiture).
 * Both are owner decisions (TECH_DEBT TD-21). The database holds the same rules (IX094, IX095).
 */

type ApplicationRow = ReserveApplicationRow & { requested_by: string; kind: 'APPLY' | 'HOLD' };

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
    .select(['id', 'ref', 'trader_id', 'trader_order_id', 'route_obligation_id', 'amount_minor', 'status', 'requested_by', 'kind'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { app, order };
}

type Kind = 'APPLY' | 'HOLD';

/**
 * The checks an application must pass when it is asked for and again when it is approved. APPLY: the order owes
 * USDT, and no more than it still owes is applied. HOLD: the order owes INR — nothing is converted, the amount is
 * USDT kept back from the reserve while the INR debt stays open.
 */
async function assertApplicable(ctx: TxContext, order: OrderRow, kind: Kind, amountMinor: bigint): Promise<void> {
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
  if (kind === 'APPLY' && amountMinor > open) {
    throw new DomainError('INVALID_AMOUNT', `order ${order.ref} still owes ${Money.ofMinor(open, 'USDT').toDecimalString()} USDT`, { owed: Money.ofMinor(open, 'USDT').toDecimalString() });
  }
  // Free: the balance less withdrawals on their way out and applications or holds already approved or in flight.
  const figures = await reserveFigures(ctx.tx, order.trader_id);
  const free = figures.balance.minor - figures.pendingRelease.minor - figures.applying.minor;
  if (amountMinor > free) {
    const shown = Money.ofMinor(free > 0n ? free : 0n, 'USDT').toDecimalString();
    throw new DomainError('TRADER_RESERVE_SHORT', `the reserve holds ${shown} USDT free`, { free: shown });
  }
}

/**
 * `trader_reserve.request_application` — `trader_reserve:apply` (⧗), with the reason. On an order that owes USDT it
 * asks to apply the reserve to what the order still owes (or less). On an order that owes INR it can only ask to
 * **hold** part of the reserve (an amount of USDT, named here): the INR debt stays open, nothing is converted or
 * posted, and that part of the reserve cannot be withdrawn until the hold is released or the owner's terms exist
 * (TD-21). Nothing is held or moved until someone else approves it.
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
    const live = await ctx.tx.selectFrom('trader_reserve_application').select('ref').where('trader_order_id', '=', order.id).where('status', 'in', ['REQUESTED', 'APPROVED', 'SENT']).executeTakeFirst();
    if (live) throw new DomainError('INVALID_TRANSITION', `reserve application ${live.ref} is already open for this order`);
    const kind: Kind = order.side === 'SELL_USDT' ? 'APPLY' : 'HOLD';
    // APPLY defaults to what the order still owes; a HOLD's amount is always named (the debt is INR, the reserve USDT).
    let amount: Money<'USDT'>;
    if (p.amount) amount = Money.parse(p.amount, 'USDT');
    else if (kind === 'APPLY') amount = Money.ofMinor(await routeDeliveryOpen(ctx.tx, order.route_obligation_id), 'USDT');
    else throw new DomainError('INVALID_AMOUNT', `order ${order.ref} owes INR: name how much USDT of the reserve to hold while the owner's terms for converting it do not exist`);
    await assertApplicable(ctx, order, kind, amount.minor);
    const row = await ctx.tx
      .insertInto('trader_reserve_application')
      .values({ trader_id: order.trader_id, trader_order_id: order.id, route_obligation_id: order.route_obligation_id, kind, amount_minor: amount.minor, reason, requested_by: actor.userId })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'trader_reserve.application_requested', entityType: 'trader_profile', entityId: order.trader_id,
      after: { ref: row.ref, kind, order: order.ref, amount, reason },
    });
    return { applicationId: row.id, ref: row.ref, kind, amount: amount.toDecimalString() };
  });
}

/**
 * `trader_reserve.approve_application` — `trader_reserve:approve` (⧗✱), by someone other than the requester. Holds
 * the amount out of the reserve and tells the trader. For an application it also issues the order's delivery address
 * if the trader never asked for it: custody moves the USDT next; the desk records it (or the scanner sees it) and the
 * chain confirms it. For a hold nothing more happens — it waits for the INR, an unwind, or the owner's terms.
 */
export function approveReserveApplication(actor: OperatorActor, deps: Pick<TraderDeps, 'custody'>) {
  return operatorCommand(actor, 'trader_reserve:approve', async (ctx, p: { applicationId: string; note?: string | null }, decision) => {
    const { app, order } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `reserve application ${app.ref} is ${app.status.toLowerCase()}`);
    assertSecondApprover(decision, app.requested_by, actor.userId);
    // E4: approving an application sends the trader's reserve out — held after a restore until reconciled (IX100).
    if (app.kind === 'APPLY') await assertPayoutsOpen(ctx.tx);
    await assertApplicable(ctx, order, app.kind, app.amount_minor);
    const delivery = app.kind === 'APPLY'
      ? await allocateObligationDeliveryAddress(ctx, deps.custody, {
          network: 'TRON', routeObligationId: app.route_obligation_id, reference: order.ref, expectedAmount: Money.ofMinor(order.base_minor, 'USDT'),
        })
      : null;
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
      after: { status: 'APPROVED', kind: app.kind, ref: app.ref, order: order.ref, amount, requested_by: app.requested_by, approved_by: actor.userId, delivery_address: delivery?.address ?? null },
    });
    await enqueueOutbox(ctx, {
      type: 'trader.reserve_issue', aggregateType: 'trader_profile', aggregateId: app.trader_id,
      payload: { traderId: app.trader_id, reason: app.kind === 'APPLY' ? 'RESERVE_APPLIED' : 'RESERVE_HELD', amount: amount.toDecimalString(), orderRef: order.ref },
    });
    return { ref: app.ref, status: 'APPROVED' as const, kind: app.kind, deliveryAddress: delivery?.address ?? null, amount: amount.toDecimalString() };
  });
}

/** `trader_reserve.reject_application` — `trader_reserve:approve` (⧗), by someone other than the requester. */
export function rejectReserveApplication(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_reserve:approve', async (ctx, p: { applicationId: string; note: string }) => {
    const { app } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `reserve application ${app.ref} is ${app.status.toLowerCase()}`);
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
    if (app.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `reserve application ${app.ref} is ${app.status.toLowerCase()}`);
    if (app.requested_by !== actor.userId) throw new DomainError('FORBIDDEN', 'only the requester withdraws an application; someone else declines it');
    await closeApplication(ctx, app, 'CANCELLED', reason);
    return { ref: app.ref, status: 'CANCELLED' as const };
  });
}

/**
 * `trader_reserve.end_application` — `trader_reserve:approve` (⧗). An approved application whose USDT has not moved
 * is ended, with the reason — the trader delivered after all, or custody will not send — and a hold is released the
 * same way; the amount either held is the trader's again. Once an application's USDT moved, the chain decides: it
 * confirms, or the delivery is failed. An order that completes or is cancelled ends what is still open on it by itself.
 */
export function endReserveApplication(actor: OperatorActor) {
  return operatorCommand(actor, 'trader_reserve:approve', async (ctx, p: { applicationId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const { app } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'APPROVED') throw new DomainError('INVALID_TRANSITION', `reserve application ${app.ref} is ${app.status.toLowerCase()}`);
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

/**
 * `trader_reserve.record_application_sent` — `trader_payout:record`. Custody moved the USDT and the desk hands over
 * the transaction hash; the facts are read from the chain, not typed: USDT on the configured contract, from the
 * trader's reserve address or a treasury wallet, to the order's delivery address, exactly the approved amount.
 * The scanner records the same transfer by itself when it sees it first; either way it is recorded once.
 */
export function recordReserveApplicationSent(actor: OperatorActor, deps: Pick<TraderDeps, 'chain'>) {
  return operatorCommand(actor, 'trader_payout:record', async (ctx, p: { applicationId: string; txHash: string; logIndex?: number }) => {
    const { app } = await lockApplicationChain(ctx, p.applicationId);
    if (app.status !== 'APPROVED') throw new DomainError('INVALID_TRANSITION', `reserve application ${app.ref} is ${app.status.toLowerCase()}`);
    if (app.kind !== 'APPLY') throw new DomainError('INVALID_TRANSITION', `${app.ref} only holds the reserve against an INR debt; nothing is sent for it`);
    const delivery = await obligationDeliveryAddress(ctx.tx, app.route_obligation_id);
    if (!delivery) throw new DomainError('INVALID_TRANSITION', 'the order has no delivery address');
    const txHash = requireText(p.txHash, 'txHash', 66).toLowerCase().replace(/^0x/, '');
    const tx = await deps.chain.transactionTransfers('TRON', txHash);
    if (tx.status === 'NOT_FOUND') throw new DomainError('NOT_FOUND', 'the chain does not know this transfer');
    if (tx.status === 'TX_FAILED') throw new DomainError('INVALID_ARGUMENT', 'this transaction failed on chain; it moved no USDT');
    // The log that delivers this application — never "the first log" of a transaction that may move USDT several times.
    const usdt = tx.transfers.filter((t) => t.tokenContract === deps.chain.tokenContract && (p.logIndex === undefined || p.logIndex === null || t.logIndex === p.logIndex));
    const delivering = usdt.filter((t) => t.toAddress === delivery.address);
    if (delivering.length === 0) throw new DomainError('INVALID_ARGUMENT', "this transfer does not reach the order's delivery address");
    const exact = delivering.filter((t) => t.amountMinor === app.amount_minor);
    if (exact.length === 0) throw new DomainError('INVALID_AMOUNT', 'this transfer does not move the approved amount');
    if (exact.length > 1) throw new DomainError('INVALID_ARGUMENT', 'this transaction delivers that amount more than once; name the log', { logIndexes: exact.map((t) => t.logIndex) });
    const t = exact[0]!;
    const fromWalletId = await reserveSourceWallet(ctx.tx, app.trader_id, t.fromAddress);
    if (!fromWalletId) throw new DomainError('INVALID_ARGUMENT', "this transfer does not leave the trader's reserve address or a treasury wallet");
    const recorded = await recordAppliedReserveDelivery(ctx, {
      application: app,
      transfer: { txHash, logIndex: t.logIndex, tokenContract: t.tokenContract, fromAddress: t.fromAddress, toAddress: t.toAddress, amount: Money.ofMinor(t.amountMinor, 'USDT'), source: 'OPERATOR_SUBMITTED' },
      fromWalletId,
      toWalletId: delivery.treasuryWalletId,
    });
    return { ref: app.ref, status: 'SENT' as const, routeSettlementRef: recorded.ref };
  });
}
