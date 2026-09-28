import { DomainError, Money, requireOneOf, requireText } from '@inrp2p/kernel';
import type { FiatRail, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor } from '@inrp2p/identity';
import { obligationRemaining, recordRouteSettlementInTx } from '@inrp2p/settlement';
import { allocateObligationDeliveryAddress } from '@inrp2p/treasury';
import { lockTraderOfClient, traderClientCommand, lockOrder, type TraderDeps, traderProgram } from '@inrp2p/trader-core';

/** Trade states in which the client's own funds are confirmed — the only time a trader is asked to move money. */
export const COUNTERPARTY_FUNDED: ReadonlySet<string> = new Set(['FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED', 'COMPLETED']);

async function startedOrderOfClient(ctx: TxContext, clientId: string, ref: string) {
  const row = await ctx.tx
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .select(['o.id'])
    .where('o.ref', '=', requireText(ref, 'ref', 32))
    .where('t.client_id', '=', clientId)
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'order not found');
  await lockTraderOfClient(ctx, clientId);
  const order = await lockOrder(ctx, row.id);
  if (order.status !== 'IN_PROGRESS' || !order.trade_id || !order.route_obligation_id) throw new DomainError('TRADER_ORDER_NOT_LIVE', `this order is ${order.status.toLowerCase()}`);
  const trade = await ctx.tx.selectFrom('trade').select(['lifecycle_state']).where('id', '=', order.trade_id).executeTakeFirstOrThrow();
  // A trader moves its money only once the other side's funds are confirmed: until then the trade can still be
  // cancelled with nothing to return, and nothing of the trader's is at risk.
  if (!COUNTERPARTY_FUNDED.has(trade.lifecycle_state)) throw new DomainError('TRADER_ACTION_NOT_DUE', 'wait until the other side is funded — you will be told when it is your turn');
  return { ...order, route_obligation_id: order.route_obligation_id };
}

/**
 * `trader_order.submit_payment` — a user who can commit, on a Buy USDT order once the other side is funded. The
 * trader says it sent INR to INRP2P's collection account and gives the bank reference (UTR). This records the claim
 * as a route settlement through the same code the desk uses (FI-22: the UTR can never be recorded twice); nothing
 * posts until the desk confirms the credit in the bank (`route_settlement:confirm`, ⧗). One claim at a time.
 */
export function submitOrderPayment(actor: ClientActor, deps: Pick<TraderDeps, 'chain'>) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; rail: FiatRail; utr: string; amount?: string }, member) => {
    const order = await startedOrderOfClient(ctx, member.clientId, p.ref);
    if (order.side !== 'BUY_USDT') throw new DomainError('INVALID_ARGUMENT', 'on a Sell USDT order you send USDT to the order address instead');
    const program = await traderProgram(ctx.tx);
    if (!program.collectionAccountId) throw new DomainError('TRADER_PROGRAM_NOT_CONFIGURED', 'INRP2P has not published its collection account yet; contact the desk');
    const pending = await ctx.tx
      .selectFrom('route_settlement')
      .select('ref')
      .where('route_obligation_id', '=', order.route_obligation_id)
      .where('obligation_side', '=', 'ROUTE_DELIVERS')
      .where('status', '=', 'RECORDED')
      .executeTakeFirst();
    if (pending) throw new DomainError('INVALID_TRANSITION', 'your last payment reference is still being checked');
    const remaining = await obligationRemaining(ctx.tx, order.route_obligation_id);
    const owed = remaining.routeDelivers as Money<'INR'>;
    if (owed.isZero()) throw new DomainError('INVALID_TRANSITION', 'your payment for this order is already confirmed');
    const amount = p.amount ? Money.parse(p.amount, 'INR') : owed;
    const recorded = await recordRouteSettlementInTx(ctx, deps, {
      routeObligationId: order.route_obligation_id,
      flow: 'FROM_ROUTE_TO_EXCHANGE',
      amount: amount.toDecimalString(),
      rail: requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const),
      utr: p.utr,
      inrAccountId: program.collectionAccountId,
    });
    await appendAudit(ctx, { action: 'trader_order.payment_submitted', entityType: 'trader_order', entityId: order.id, after: { route_settlement_id: recorded.routeSettlementId, amount } });
    await enqueueOutbox(ctx, { type: 'trader.payment_submitted', aggregateType: 'trader_order', aggregateId: order.id, payload: { orderId: order.id, routeSettlementId: recorded.routeSettlementId } });
    return { settlementRef: recorded.ref };
  });
}

/**
 * `trader_order.delivery_address` — a user who can commit, on a Sell USDT order once the other side is funded. The
 * order's own deposit address, issued once by the custody provider: USDT that reaches it from the trader's
 * registered wallet settles the order's USDT side when the chain makes it final — no reference to type, and nothing
 * matched by amount or sender (D-02).
 */
export function orderDeliveryAddress(actor: ClientActor, deps: Pick<TraderDeps, 'custody'>) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string }, member) => {
    const order = await startedOrderOfClient(ctx, member.clientId, p.ref);
    if (order.side !== 'SELL_USDT') throw new DomainError('INVALID_ARGUMENT', 'on a Buy USDT order you pay INR instead');
    const remaining = await obligationRemaining(ctx.tx, order.route_obligation_id);
    const owed = remaining.routeDelivers as Money<'USDT'>;
    if (owed.isZero()) throw new DomainError('INVALID_TRANSITION', 'your USDT for this order is already confirmed');
    const allocation = await allocateObligationDeliveryAddress(ctx, deps.custody, {
      network: 'TRON', routeObligationId: order.route_obligation_id, reference: order.ref, expectedAmount: Money.ofMinor(order.base_minor, 'USDT'),
    });
    await appendAudit(ctx, { action: 'trader_order.delivery_address_issued', entityType: 'trader_order', entityId: order.id, after: { deposit_address_id: allocation.depositAddressId } });
    return { address: allocation.address, amount: owed.toDecimalString() };
  });
}
