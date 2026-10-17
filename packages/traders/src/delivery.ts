import { DomainError, Money, requireOneOf, requireText, requireUtrShape } from '@inrp2p/kernel';
import type { FiatRail, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor } from '@inrp2p/identity';
import { confirmP2pReceiptInTx, fileRoutePayoutInTx, obligationRemaining, recordRouteSettlementInTx } from '@inrp2p/settlement';
import { allocateObligationDeliveryAddress } from '@inrp2p/treasury';
import { lockTraderOfClient, traderClientCommand, lockOrder, type TraderDeps, traderProgram } from '@inrp2p/trader-core';

/** Trade states in which the client's own funds are confirmed — the only time a trader is asked to move money. */
export const CLIENT_FUNDED_STATES: ReadonlySet<string> = new Set(['FIRST_LEG_CONFIRMED', 'SETTLING', 'PARTIALLY_SETTLED', 'COMPLETED']);

async function startedOrderOfClient(ctx: TxContext, clientId: string, ref: string, opts: { readonly escrowFirst?: boolean } = {}) {
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
  const p2p = (await ctx.tx.selectFrom('liquidity_route').select('execution_mode').where('id', '=', order.route_id).executeTakeFirstOrThrow()).execution_mode === 'P2P';
  // A trader moves its money only once the other side's funds are confirmed: until then the trade can still be
  // cancelled with nothing to return, and nothing of the trader's is at risk. P2P (ADR 0019) turns this round for a
  // client buying USDT: the trader's USDT goes into the exchange's escrow first, so the client pays into safety.
  const due = (opts.escrowFirst && p2p) ? trade.lifecycle_state !== 'CANCELLED' && trade.lifecycle_state !== 'COMPLETED' : CLIENT_FUNDED_STATES.has(trade.lifecycle_state);
  if (!due) throw new DomainError('TRADER_ACTION_NOT_DUE', 'wait until the other side is funded — you will be told when it is your turn');
  return { ...order, route_obligation_id: order.route_obligation_id, trade_id: order.trade_id, p2p };
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
    if (order.p2p) {
      // ADR 0019: the trader pays the client directly, from its own registered account; the client confirms it.
      const profile = await ctx.tx.selectFrom('trader_profile').select('bank_account_id').where('id', '=', order.trader_id).executeTakeFirstOrThrow();
      const remaining = await obligationRemaining(ctx.tx, order.route_obligation_id);
      const owed = remaining.routeDelivers as Money<'INR'>;
      if (owed.isZero()) throw new DomainError('INVALID_TRANSITION', 'your payment to the client is already confirmed');
      const pending = await ctx.tx.selectFrom('settlement_leg').select('ref').where('trade_id', '=', order.trade_id).where('side', '=', 'EXCHANGE_TO_CLIENT').where('status', 'in', ['PENDING', 'PROCESSING']).executeTakeFirst();
      if (pending) throw new DomainError('INVALID_TRANSITION', 'your last payment is still waiting for the client to confirm it');
      const rail = requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const);
      const amount = p.amount ? Money.parse(p.amount, 'INR') : owed;
      const filed = await fileRoutePayoutInTx(ctx, {}, { tradeId: order.trade_id, rail, utr: p.utr, amount, payerBankAccountId: profile.bank_account_id });
      await appendAudit(ctx, { action: 'trader_order.payment_submitted', entityType: 'trader_order', entityId: order.id, after: { leg_ref: filed.legRef, amount, p2p: true } });
      await enqueueOutbox(ctx, { type: 'trader.payment_submitted', aggregateType: 'trader_order', aggregateId: order.id, payload: { orderId: order.id, legRef: filed.legRef } });
      return { settlementRef: filed.legRef };
    }
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
    // ADR 0018: the trader pays from its own registered bank account — the one on its profile — and the desk counts
    // the rupees only once the credit is seen to have come from it.
    const profile = await ctx.tx.selectFrom('trader_profile').select('bank_account_id').where('id', '=', order.trader_id).executeTakeFirstOrThrow();
    const rail = requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const);
    const recorded = await recordRouteSettlementInTx(ctx, deps, {
      routeObligationId: order.route_obligation_id,
      flow: 'FROM_ROUTE_TO_EXCHANGE',
      amount: amount.toDecimalString(),
      rail,
      utr: requireUtrShape(rail, p.utr),
      inrAccountId: program.collectionAccountId,
      payerBankAccountId: profile.bank_account_id,
      filedBy: 'TRADER',
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
    const order = await startedOrderOfClient(ctx, member.clientId, p.ref, { escrowFirst: true });
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

/**
 * `trader_order.confirm_received` (ADR 0019) — a user who can commit, on a P2P Sell USDT order: the client's rupees
 * reached the trader's own account, and its bank shows who sent them. On a match the payment counts and the escrow
 * releases the client's USDT; anything else waits for the desk, and a stranger's rupees open a case.
 */
export function confirmOrderPaymentReceived(actor: ClientActor, deps: Pick<TraderDeps, 'chain'>) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; senderName: string; senderAccount?: string | null }, member) => {
    const row = await ctx.tx
      .selectFrom('trader_order as o')
      .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
      .select(['o.id', 'o.side', 'o.trade_id', 'o.status'])
      .where('o.ref', '=', requireText(p.ref, 'ref', 32))
      .where('t.client_id', '=', member.clientId)
      .executeTakeFirst();
    if (!row || !row.trade_id) throw new DomainError('NOT_FOUND', 'order not found');
    if (row.side !== 'SELL_USDT') throw new DomainError('INVALID_ARGUMENT', 'on a Buy USDT order the client confirms your payment');
    const leg = await ctx.tx
      .selectFrom('settlement_leg')
      .select('id')
      .where('trade_id', '=', row.trade_id)
      .where('side', '=', 'CLIENT_TO_EXCHANGE')
      .where('asset', '=', 'INR')
      .where('status', '=', 'PROCESSING')
      .orderBy('created_at')
      .executeTakeFirst();
    if (!leg) throw new DomainError('INVALID_TRANSITION', 'the client has not said it paid yet');
    const out = await confirmP2pReceiptInTx(ctx, { chain: deps.chain }, { tradeId: row.trade_id, legId: leg.id, payee: 'TRADER', senderName: p.senderName, senderAccount: p.senderAccount ?? null });
    await appendAudit(ctx, { action: 'trader_order.payment_received', entityType: 'trader_order', entityId: row.id, after: { verdict: out.verdict, confirmed: out.confirmed } });
    return out;
  });
}

