import { DomainError, Money, requireOneOf, requireText } from '@inrp2p/kernel';
import type { FiatRail, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor } from '@inrp2p/identity';
import {
  type DealAttachment, type DealAttachmentRef, type P2pDisputeReason, answerP2pDisputeInTx, callSupportInTx, choosePayMethodInTx, confirmP2pReceiptInTx, fileRoutePayoutInTx, obligationRemaining,
  openP2pDisputeInTx, postDealMessageInTx, recordPayeeNameCheckInTx, reportPayeeUpiNameInTx,
} from '@inrp2p/settlement';
import { lockTrade } from '@inrp2p/trades';
import { allocateObligationDeliveryAddress } from '@inrp2p/treasury';
import { lockTraderOfClient, traderClientCommand, lockOrder, type TraderDeps } from '@inrp2p/trader-core';

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
  // A trader moves its money only once the other side's funds are confirmed: until then the trade can still be
  // cancelled with nothing to return, and nothing of the trader's is at risk. A client buying USDT is the other way
  // round: the trader's USDT goes into the exchange's escrow first, so the client pays into safety (ADR 0019).
  const due = opts.escrowFirst ? trade.lifecycle_state !== 'CANCELLED' && trade.lifecycle_state !== 'COMPLETED' : CLIENT_FUNDED_STATES.has(trade.lifecycle_state);
  if (!due) throw new DomainError('TRADER_ACTION_NOT_DUE', 'wait until the other side is funded — you will be told when it is your turn');
  return { ...order, route_obligation_id: order.route_obligation_id, trade_id: order.trade_id };
}

/**
 * `trader_order.submit_payment` — a user who can commit, on a Buy USDT order once the other side is funded. The
 * trader paid the client directly, from its own registered account (ADR 0019), and gives the bank reference (UTR); the
 * client's confirmation of it is what releases the escrow. One payment of the whole amount, one at a time. Paid by UPI
 * to the client's UPI ID, the trader says its app showed the client's name (ADR 0030).
 */
export function submitOrderPayment(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; rail: FiatRail; utr: string; amount?: string; fromUpiId?: string | null; payeeNameConfirmed?: boolean | null }, member) => {
    const order = await startedOrderOfClient(ctx, member.clientId, p.ref);
    if (order.side !== 'BUY_USDT') throw new DomainError('INVALID_ARGUMENT', 'on a Sell USDT order you send USDT to the order address instead');
    const profile = await ctx.tx.selectFrom('trader_profile').select('bank_account_id').where('id', '=', order.trader_id).executeTakeFirstOrThrow();
    const remaining = await obligationRemaining(ctx.tx, order.route_obligation_id);
    const owed = remaining.routeDelivers as Money<'INR'>;
    if (owed.isZero()) throw new DomainError('INVALID_TRANSITION', 'your payment to the client is already confirmed');
    const pending = await ctx.tx.selectFrom('settlement_leg').select('ref').where('trade_id', '=', order.trade_id).where('side', '=', 'EXCHANGE_TO_CLIENT').where('status', 'in', ['PENDING', 'PROCESSING']).executeTakeFirst();
    if (pending) throw new DomainError('INVALID_TRANSITION', 'your last payment is still waiting for the client to confirm it');
    const rail = requireOneOf(p.rail, 'rail', ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const);
    const amount = p.amount ? Money.parse(p.amount, 'INR') : owed;
    // ADR 0019: one payment of the whole amount — the client's confirmation of it is what releases the escrow.
    if (amount.minor !== owed.minor) throw new DomainError('INVALID_AMOUNT', `pay the client the whole ${owed.toDecimalString()} INR in one payment`);
    await lockTrade(ctx.tx, order.trade_id);
    await recordPayeeNameCheckInTx(ctx, { tradeId: order.trade_id, rail, confirmed: p.payeeNameConfirmed });
    // ADR 0029: paid from one of the trader's own verified UPI IDs, it is declared from that address (IX145), not the account.
    const payer = p.fromUpiId ? { payerUpiId: p.fromUpiId } : { payerBankAccountId: profile.bank_account_id };
    const filed = await fileRoutePayoutInTx(ctx, {}, { tradeId: order.trade_id, rail, utr: p.utr, amount, ...payer });
    await appendAudit(ctx, { action: 'trader_order.payment_submitted', entityType: 'trader_order', entityId: order.id, after: { leg_ref: filed.legRef, amount, payee_name_confirmed: p.payeeNameConfirmed === true } });
    await enqueueOutbox(ctx, { type: 'trader.payment_submitted', aggregateType: 'trader_order', aggregateId: order.id, payload: { orderId: order.id, legRef: filed.legRef } });
    return { settlementRef: filed.legRef };
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

/** An order of the trader's own client, by its reference, with the trade it stands behind. */
async function p2pOrderOfClient(ctx: TxContext, clientId: string, ref: string) {
  const row = await ctx.tx
    .selectFrom('trader_order as o')
    .innerJoin('trader_profile as t', 't.id', 'o.trader_id')
    .select(['o.id', 'o.side', 'o.trade_id'])
    .where('o.ref', '=', requireText(ref, 'ref', 32))
    .where('t.client_id', '=', clientId)
    .executeTakeFirst();
  if (!row || !row.trade_id) throw new DomainError('NOT_FOUND', 'order not found');
  return { ...row, trade_id: row.trade_id };
}

/**
 * `trader_order.dispute` (block 9) — a user who can commit, on a P2P Sell USDT order: the client's rupees it was told of
 * did not reach the trader's account. The deal stops, and INRP2P decides from the trader's bank.
 */
export function disputeOrderPayment(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; reason: P2pDisputeReason; note?: string | null }, member) => {
    const order = await p2pOrderOfClient(ctx, member.clientId, p.ref);
    if (order.side !== 'SELL_USDT') throw new DomainError('NOT_THE_PAYEE', 'on a Buy USDT order the client receives your rupees');
    const out = await openP2pDisputeInTx(ctx, { tradeId: order.trade_id, payee: 'TRADER', userId: actor.userId, reason: p.reason, note: p.note ?? null });
    await appendAudit(ctx, { action: 'trader_order.payment_disputed', entityType: 'trader_order', entityId: order.id, after: { dispute: out.ref } });
    return out;
  });
}

/** `trader_order.answer_dispute` — on a P2P Buy USDT order whose client says the trader's rupees did not arrive: the trader's side, for INRP2P. */
export function answerOrderDispute(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; note: string }, member) => {
    const order = await p2pOrderOfClient(ctx, member.clientId, p.ref);
    if (order.side !== 'BUY_USDT') throw new DomainError('NOT_THE_PAYER', 'on a Sell USDT order the client paid you');
    return answerP2pDisputeInTx(ctx, { tradeId: order.trade_id, payer: 'TRADER', userId: actor.userId, note: p.note });
  });
}

/**
 * `trader_order.chat` (ADR 0023) — any person of the trader's account, on a P2P order: a message in the deal's chat —
 * words, a file, or the receipt of the trader's own payment to the client.
 */
export function postOrderDealMessage(actor: ClientActor, file?: DealAttachment) {
  return traderClientCommand(actor, 'VIEW', async (ctx, p: { ref: string; body?: string | null; file?: DealAttachmentRef | null; legRef?: string | null }, member) => {
    const order = await p2pOrderOfClient(ctx, member.clientId, p.ref);
    await lockTrade(ctx.tx, order.trade_id);
    let legId: string | null = null;
    if (p.legRef) {
      const leg = await ctx.tx.selectFrom('settlement_leg').select('id').where('ref', '=', requireText(p.legRef, 'legRef', 40)).where('trade_id', '=', order.trade_id).executeTakeFirst();
      if (!leg) throw new DomainError('NOT_FOUND', 'payment not found');
      legId = leg.id;
    }
    if (p.file && !file) throw new DomainError('INVALID_ARGUMENT', 'the file did not arrive — attach it again', { field: 'file' });
    return postDealMessageInTx(ctx, { tradeId: order.trade_id, author: 'TRADER', userId: actor.userId, body: p.body ?? null, file: p.file && file ? { attachment: file, ref: p.file } : null, legId });
  });
}

/** `trader_order.call_support` — any person of the trader's account: INRP2P is asked into the deal's chat. */
export function callOrderSupport(actor: ClientActor) {
  return traderClientCommand(actor, 'VIEW', async (ctx, p: { ref: string; note?: string | null }, member) => {
    const order = await p2pOrderOfClient(ctx, member.clientId, p.ref);
    return callSupportInTx(ctx, { tradeId: order.trade_id, author: 'TRADER', userId: actor.userId, note: p.note ?? null });
  });
}

/** `trader_order.choose_method` — a user who can commit, on a P2P Buy USDT order: how it pays the client, and so its time to. */
export function chooseOrderPayMethod(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; method: string }, member) => {
    const order = await p2pOrderOfClient(ctx, member.clientId, p.ref);
    if (order.side !== 'BUY_USDT') throw new DomainError('NOT_THE_PAYER', 'on a Sell USDT order the client pays you');
    return choosePayMethodInTx(ctx, { tradeId: order.trade_id, payer: 'TRADER', userId: actor.userId, method: p.method });
  });
}

/** `trader_order.report_name` — on a P2P Buy USDT order, the trader's UPI app shows another name for the client's UPI ID (ADR 0030). */
export function reportOrderPayeeName(actor: ClientActor) {
  return traderClientCommand(actor, 'COMMIT', async (ctx, p: { ref: string; shownName: string }, member) => {
    const order = await p2pOrderOfClient(ctx, member.clientId, p.ref);
    if (order.side !== 'BUY_USDT') throw new DomainError('NOT_THE_PAYER', 'on a Sell USDT order the client pays you');
    return reportPayeeUpiNameInTx(ctx, { tradeId: order.trade_id, payer: 'TRADER', shownName: p.shownName });
  });
}
