import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { assertPayoutsOpen, lockTrade } from '@inrp2p/trades';
import { lockSend, planChainSend, signablePathOf, tradeHold } from '@inrp2p/network';
import { enqueueOutbox } from '@inrp2p/outbox';
import { assertPhysicallyAvailable } from './availability.ts';
import { confirmPayoutLegInTx, type ConfirmPayoutResult } from './confirm.ts';
import { allocateFunding, assertCounterpartyDelivered, fundingSources, settleFunding, tronLocation } from './funding.ts';
import { lockObligation, obligationOfTrade, obligationRemaining } from './obligations.ts';
import { payoutNeedsSecondPerson } from './approvals.ts';
import { assertNoPayoutUnderway, failPayoutLegInTx, legSourceAddress, lockLeg } from './legs.ts';
import { locateTransferLog, lockMovement, postMovement, recordCryptoTransfer, verifyCryptoTransfer } from './movements.ts';
import { advanceTrade } from './progress.ts';
import { confirmRouteSettlementInTx, recordRouteSettlementInTx } from './routesettlements.ts';
import type { SettlementDeps } from './policy.ts';

/**
 * The settlement side of the exchange's own signer (ADR 0017 §4). The signer moves USDT; this module decides what a
 * signed transfer is for, before (a refund is sent only once someone other than its creator approves it) and after
 * (a transfer the chain made final settles its payout, its refund or its payment to the counterparty, through the same
 * code an operator's confirmation runs — one movement, one journal, FI-27).
 */

/**
 * `refund_leg.approve_send` — `refund:approve` (⧗✱). The second person a refund needs (SECURITY §4), for a USDT refund
 * from an address the signer holds: approving it sends it — the leg is marked sent and the signer's send is planned,
 * already approved. The approver also says who bears its network fee: the trader whose failure it answers, or the
 * platform. The client never does: a refund is not the client's cost to carry (ADR 0017 §5).
 */
export function approveRefundSend(actor: OperatorActor, deps: Pick<SettlementDeps, 'policy'> = {}) {
  return operatorCommand(actor, 'refund:approve', async (ctx, p: { legId: string; bearer: 'TRADER' | 'PLATFORM'; toWalletId?: string | null; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const bearer = requireOneOf(p.bearer, 'bearer', ['TRADER', 'PLATFORM'] as const);
    const peek = await ctx.tx.selectFrom('settlement_leg').select(['trade_id', 'created_by']).where('id', '=', requireUuid(p.legId, 'legId')).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', 'settlement leg not found');
    const approver = ctx.actor.id ?? 'SYSTEM';
    if (peek.created_by === approver) throw new DomainError('SECOND_APPROVER_REQUIRED', 'a refund is approved by a different person than the one who created it');
    const trade = await lockTrade(ctx.tx, peek.trade_id);
    const leg = await lockLeg(ctx, p.legId);
    if (leg.side !== 'REFUND_TO_CLIENT' || leg.asset !== 'USDT') throw new DomainError('INVALID_ARGUMENT', 'this is not a USDT refund');
    if (leg.status !== 'PENDING') throw new DomainError('INVALID_TRANSITION', `refund ${leg.ref} is ${leg.status}`);
    if (leg.refund_kind !== 'EXCESS') await assertNoPayoutUnderway(ctx.tx, trade.id);
    await assertPayoutsOpen(ctx.tx);
    const from = await legSourceAddress(ctx, leg);
    if (!(await signablePathOf(ctx.tx, from))) throw new DomainError('CUSTODY_PATH_REFUSED', `${from} is not an address the exchange's signer holds: refund it by hand and confirm it`);
    const hold = await tradeHold(ctx.tx, trade.id);
    if (!hold || hold.status !== 'ACTIVE') throw new DomainError('NETWORK_BUDGET_INSUFFICIENT', 'this trade holds no network budget for a refund');
    if (bearer === 'TRADER' && !hold.trader_id) throw new DomainError('INVALID_ARGUMENT', 'a desk route has no trader to bear the fee');
    let to: string;
    if (leg.destination_wallet_id) {
      to = (await ctx.tx.selectFrom('crypto_wallet').select('address').where('id', '=', leg.destination_wallet_id).where('status', '=', 'ACTIVE').executeTakeFirstOrThrow()).address;
    } else {
      const w = await ctx.tx.selectFrom('crypto_wallet').select(['address', 'client_id', 'status', 'purpose']).where('id', '=', requireUuid(p.toWalletId, 'toWalletId')).executeTakeFirst();
      if (!w || w.client_id !== trade.client_id || w.status !== 'ACTIVE' || (w.purpose !== 'SOURCE' && w.purpose !== 'BOTH')) {
        throw new DomainError('DESTINATION_INVALID', 'a refund goes back to an active wallet the client registered as one it sends from');
      }
      to = w.address;
    }
    await assertPhysicallyAvailable(ctx, deps, { address: from, amount: Money.ofMinor(leg.amount_minor, 'USDT'), excludeLegId: leg.id });
    await ctx.tx.updateTable('settlement_leg').set({ status: 'PROCESSING', sent_at: sql<Date>`inrp2p_now()`, sent_by: approver }).where('id', '=', leg.id).execute();
    const send = await planChainSend(ctx, {
      purpose: 'REFUND', asset: 'USDT', tradeId: trade.id, legId: leg.id, fromAddress: from, toAddress: to, amountMinor: leg.amount_minor,
      funder: hold.trader_id, bearer, needsApproval: true, requestedBy: leg.created_by, approvedBy: approver,
    });
    await appendAudit(ctx, { action: 'refund.approved_to_send', entityType: 'settlement_leg', entityId: leg.id, before: { status: 'PENDING' }, after: { status: 'PROCESSING', send: send.ref, bearer, reason, approved_by: approver } });
    return { status: 'PROCESSING' as const, sendRef: send.ref };
  });
}

export type SignedSettlement =
  | { readonly purpose: 'CLIENT_PAYOUT'; readonly payout: ConfirmPayoutResult }
  | { readonly purpose: 'REFUND'; readonly status: 'COMPLETED' }
  | { readonly purpose: 'ROUTE_PAYMENT'; readonly routeSettlementId: string; readonly obligationStatus: string }
  | { readonly purpose: 'TOPUP' | 'DEPOSIT_WITHDRAWAL' };

/**
 * Settles what a send paid, once its attempt is CONFIRMED in this transaction (the caller marks it, then calls this,
 * then marks the send CONFIRMED). The transaction is read back from the chain by its facts and verified like any
 * other (FI-24): a provider that disagrees, or a transfer below the quorum it needs, fails this whole step and the
 * send stays as it was until the chain answers.
 */
export async function settleSignedSendInTx(ctx: TxContext, deps: SettlementDeps, sendId: string): Promise<SignedSettlement> {
  const send = await ctx.tx.selectFrom('chain_send').selectAll().where('id', '=', requireUuid(sendId, 'sendId')).executeTakeFirstOrThrow();
  const attempt = await ctx.tx.selectFrom('chain_send_attempt').select(['txid']).where('send_id', '=', send.id).where('status', '=', 'CONFIRMED').executeTakeFirst();
  if (!attempt) throw new DomainError('INVALID_TRANSITION', `send ${send.ref} has no confirmed transaction`);
  if (send.purpose === 'TOPUP' || send.purpose === 'DEPOSIT_WITHDRAWAL') return { purpose: send.purpose };

  if (send.purpose === 'ROUTE_PAYMENT') {
    const deposit = await ctx.tx.selectFrom('deposit_address').select('id').where('network', '=', 'TRON').where('address', '=', send.from_address).executeTakeFirstOrThrow();
    const recorded = await recordRouteSettlementInTx(ctx, deps, {
      routeObligationId: send.route_obligation_id!, flow: 'TO_ROUTE', amount: Money.ofMinor(send.amount_minor, 'USDT').toDecimalString(),
      txHash: attempt.txid, sourceDepositAddressId: deposit.id, toAddress: send.to_address, chainSendId: send.id,
    });
    const confirmed = await confirmRouteSettlementInTx(ctx, deps, recorded.routeSettlementId);
    return { purpose: 'ROUTE_PAYMENT', routeSettlementId: recorded.routeSettlementId, obligationStatus: confirmed.obligationStatus };
  }

  const trade = await lockTrade(ctx.tx, send.trade_id!);
  // A payout's leg is locked by its confirmation below, in the lock order (trade → obligation → leg → movement); a
  // refund's is locked here.
  const leg = send.purpose === 'REFUND'
    ? await lockLeg(ctx, send.settlement_leg_id!)
    : await ctx.tx.selectFrom('settlement_leg').select(['id', 'ref', 'status', 'amount_minor', 'treasury_wallet_id', 'refund_kind']).where('id', '=', send.settlement_leg_id!).executeTakeFirstOrThrow();
  if (leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `leg ${leg.ref} is ${leg.status}`);
  const located = await locateTransferLog(deps, { txHash: attempt.txid, from: send.from_address, to: [send.to_address], amountMinor: send.amount_minor });
  const recorded = await recordCryptoTransfer(ctx, {
    txHash: attempt.txid, logIndex: located.logIndex, tokenContract: deps.chain.tokenContract, fromAddress: send.from_address, toAddress: send.to_address,
    amount: Money.ofMinor(send.amount_minor, 'USDT'), payerType: 'EXCHANGE_TREASURY', payerId: leg.treasury_wallet_id, payeeType: 'CLIENT_WALLET', payeeId: trade.client_id,
    source: 'CUSTODY_SIGNER',
  });
  // The send names its own transaction first: the evidence of a leg the signer pays is only ever that one (IX111, IX112).
  await ctx.tx.updateTable('chain_send').set({ crypto_transfer_id: recorded.transferId, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
  await ctx.tx
    .insertInto('transfer_allocation')
    .values({ transfer_kind: 'CRYPTO', crypto_transfer_id: recorded.transferId, dimension: 'CLIENT', settlement_leg_id: leg.id, amount_minor: leg.amount_minor, allocated_by: `SYSTEM:${ctx.commandName}` })
    .execute();

  if (send.purpose === 'CLIENT_PAYOUT') {
    return { purpose: 'CLIENT_PAYOUT', payout: await confirmPayoutLegInTx(ctx, deps, leg.id) };
  }

  // A refund: the client's own USDT back, the one journal that returns the client receivable (FINANCIAL_INVARIANTS §3.4).
  await lockMovement(ctx, 'CRYPTO', recorded.transferId);
  const verified = await verifyCryptoTransfer(ctx, deps, recorded.transferId);
  if (!verified.confirmed) throw new DomainError('TRANSFER_NOT_CONFIRMED', verified.reason ?? 'the refund is not final on chain');
  const amount = Money.ofMinor(leg.amount_minor, 'USDT');
  await postMovement(ctx, {
    kind: 'CRYPTO', movementId: recorded.transferId, amount,
    from: { kind: 'EXCHANGE_TREASURY', walletId: leg.treasury_wallet_id! }, to: { kind: 'CLIENT', clientId: trade.client_id },
    tradeId: trade.id, purpose: 'REFUND',
  });
  await ctx.tx.updateTable('settlement_leg').set({ status: 'COMPLETED', confirmed_at: sql<Date>`inrp2p_now()` }).where('id', '=', leg.id).execute();
  await settleFunding(ctx, { kind: 'REFUND', legId: leg.id }, 'CONSUMED', `refund ${leg.ref} confirmed on chain`);
  await appendAudit(ctx, { action: 'leg.confirmed', entityType: 'settlement_leg', entityId: leg.id, after: { status: 'COMPLETED', side: 'REFUND_TO_CLIENT', refund_kind: leg.refund_kind ?? 'UNWIND', amount, approved_by: send.approved_by, send: send.ref } });
  if (leg.refund_kind === 'EXCESS') await advanceTrade(ctx, trade.id);
  return { purpose: 'REFUND', status: 'COMPLETED' };
}

/**
 * Plans the exchange's payment of the client's USDT to the counterparty (a trader's registered wallet, or a desk route's
 * address) from the deposit address it arrived at — no hop through another wallet (ADR 0017 §4). Delivery versus
 * payment holds (FI-77): only once the counterparty delivered its side. The client's funds there are earmarked for it
 * now, before anything is signed, so a refund cannot take the same USDT while it is on its way (FI-75).
 */
export async function planRoutePaymentInTx(ctx: TxContext, deps: Pick<SettlementDeps, 'policy'>, tradeId: string, requestedBy: string): Promise<{ sendId: string; ref: string; status: string } | null> {
  const trade = await lockTrade(ctx.tx, tradeId);
  if (trade.hold) throw new DomainError('TRADE_ON_HOLD', 'the trade has an open blocking exception');
  if (trade.direction !== 'SELL_USDT') throw new DomainError('INVALID_ARGUMENT', 'only a client selling USDT pays the counterparty in USDT');
  await assertPayoutsOpen(ctx.tx);
  const obligation = await lockObligation(ctx, (await obligationOfTrade(ctx.tx, trade.id)).id);
  if (obligation.status === 'CANCELLED' || obligation.status === 'SETTLED') return null;
  const live = await ctx.tx.selectFrom('chain_send').select('ref').where('route_obligation_id', '=', obligation.id).where('purpose', '=', 'ROUTE_PAYMENT')
    .where('status', 'not in', ['CONFIRMED', 'CANCELLED']).executeTakeFirst();
  if (live) return null;
  const refund = await ctx.tx.selectFrom('settlement_leg').select('ref').where('trade_id', '=', trade.id).where('side', '=', 'REFUND_TO_CLIENT')
    .where('status', 'in', ['PENDING', 'PROCESSING']).executeTakeFirst();
  if (refund) throw new DomainError('REFUND_IN_PROGRESS', `refund ${refund.ref} is planned for this trade`);
  await assertCounterpartyDelivered(ctx.tx, obligation.id);
  const remaining = await obligationRemaining(ctx.tx, obligation.id);
  if (remaining.exchangeDelivers.currency !== 'USDT' || remaining.exchangeDelivers.minor <= 0n) return null;
  // The client's USDT is where it arrived: its deposit address, which the signer holds.
  const sources = (await fundingSources(ctx.tx, trade.id, { kind: 'CLIENT_FUNDS', asset: 'USDT' })).filter((s) => s.availableMinor > 0n);
  const source = sources[0];
  if (!source) return null;
  const from = source.location.slice('TRON:'.length);
  if (!(await signablePathOf(ctx.tx, from))) return null;
  const amount = source.availableMinor < remaining.exchangeDelivers.minor ? source.availableMinor : remaining.exchangeDelivers.minor;
  const route = await ctx.tx.selectFrom('liquidity_route').select(['trader_id', 'registered_route_address']).where('id', '=', obligation.route_id).executeTakeFirstOrThrow();
  let to: string | null = route.registered_route_address;
  if (route.trader_id) {
    const w = await ctx.tx.selectFrom('trader_profile as t').innerJoin('crypto_wallet as w', 'w.id', 't.wallet_id').select(['w.address', 'w.status']).where('t.id', '=', route.trader_id).executeTakeFirstOrThrow();
    if (w.status !== 'ACTIVE') throw new DomainError('TRADER_DESTINATION_INVALID', "the trader's registered wallet is not active");
    to = w.address;
  }
  if (!to) throw new DomainError('DESTINATION_INVALID', 'the route has no address to be paid at');
  await assertPhysicallyAvailable(ctx, deps, { address: from, amount: Money.ofMinor(amount, 'USDT') });
  const hold = await tradeHold(ctx.tx, trade.id);
  if (!hold || hold.status !== 'ACTIVE') throw new DomainError('NETWORK_BUDGET_INSUFFICIENT', 'this trade holds no network budget');
  const send = await planChainSend(ctx, {
    purpose: 'ROUTE_PAYMENT', asset: 'USDT', tradeId: trade.id, routeObligationId: obligation.id, fromAddress: from, toAddress: to, amountMinor: amount,
    funder: hold.trader_id, bearer: 'CLIENT', needsApproval: await payoutNeedsSecondPerson(ctx.tx, { trade_id: trade.id, asset: 'USDT', amount_minor: amount }), requestedBy,
  });
  await allocateFunding(ctx, { tradeId: trade.id, use: { kind: 'ROUTE_PAYMENT', chainSendId: send.sendId }, asset: 'USDT', amount: Money.ofMinor(amount, 'USDT'), location: tronLocation(from) });
  return send;
}


/**
 * What a person can do to a send (ADR 0017 §4). Never anything that could make a second transfer: a send is cancelled
 * only while no transaction of it can still land (IX105), and its business ends with it — the payout or refund fails
 * (its earmark goes back, a replacement is a new leg, FI-25), the payment to the counterparty releases its earmark, a
 * withdrawal is cancelled. A send stuck on an unanswered chain is not cancellable: the chain decides it first.
 */
async function cancelInTx(ctx: TxContext, sendId: string, reason: string): Promise<void> {
  const peek = await ctx.tx.selectFrom('chain_send').select(['trade_id']).where('id', '=', requireUuid(sendId, 'sendId')).executeTakeFirst();
  if (!peek) throw new DomainError('NOT_FOUND', 'send not found');
  if (peek.trade_id) await lockTrade(ctx.tx, peek.trade_id);
  const send = await lockSend(ctx, sendId);
  if (send.status === 'CONFIRMED' || send.status === 'CANCELLED') throw new DomainError('INVALID_TRANSITION', `send ${send.ref} is ${send.status.toLowerCase()}`);
  if (send.status === 'SENDING') throw new DomainError('CHAIN_SEND_IN_FLIGHT', `send ${send.ref} has a transaction that may still land; it is decided by the chain first`);
  const topups = await ctx.tx.selectFrom('chain_send').select(['id', 'status', 'ref']).where('parent_send_id', '=', send.id).where('status', 'not in', ['CONFIRMED', 'CANCELLED']).execute();
  for (const t of topups) {
    if (t.status === 'SENDING') throw new DomainError('CHAIN_SEND_IN_FLIGHT', `its top-up ${t.ref} may still land; wait for the chain`);
    await cancelInTx(ctx, t.id, `its send ${send.ref} was cancelled`);
  }
  await ctx.tx.updateTable('chain_send').set({ status: 'CANCELLED', closed_at: sql<Date>`inrp2p_now()`, close_reason: reason.slice(0, 500), updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
  if (send.purpose === 'CLIENT_PAYOUT' || send.purpose === 'REFUND') {
    const leg = await ctx.tx.selectFrom('settlement_leg').select('status').where('id', '=', send.settlement_leg_id!).executeTakeFirstOrThrow();
    if (leg.status === 'PROCESSING') await failPayoutLegInTx(ctx, send.settlement_leg_id!, `send ${send.ref} cancelled before any transaction of it landed: ${reason}`);
  } else if (send.purpose === 'ROUTE_PAYMENT') {
    await settleFunding(ctx, { kind: 'ROUTE_PAYMENT', chainSendId: send.id }, 'RELEASED', `send ${send.ref} cancelled: ${reason}`);
  } else if (send.purpose === 'TOPUP' && send.parent_send_id) {
    await ctx.tx.updateTable('chain_send').set({ status: 'PLANNED', updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.parent_send_id).where('status', '=', 'AWAITING_RESOURCES').execute();
  } else if (send.purpose === 'DEPOSIT_WITHDRAWAL') {
    await ctx.tx.updateTable('network_deposit_withdrawal').set({ status: 'CANCELLED', closed_at: sql<Date>`inrp2p_now()`, close_reason: `send cancelled: ${reason}`.slice(0, 500) }).where('id', '=', send.withdrawal_id!).where('status', '=', 'APPROVED').execute();
  }
  await appendAudit(ctx, { action: 'chain_send.cancelled', entityType: 'chain_send', entityId: send.id, before: { status: send.status }, after: { status: 'CANCELLED', reason } });
}

/** `chain_send.cancel` — `chain_send:cancel` (⧗), with the reason. */
export function cancelChainSend(actor: OperatorActor) {
  return operatorCommand(actor, 'chain_send:cancel', async (ctx, p: { sendId: string; reason: string }) => {
    await cancelInTx(ctx, p.sendId, requireText(p.reason, 'reason', 500));
    return { status: 'CANCELLED' as const };
  });
}

/** `chain_send.unblock` — `chain_send:cancel` (⧗): a blocked send is decided again, now (after a top-up of the budget, or once the failures are understood). */
export function unblockChainSend(actor: OperatorActor) {
  return operatorCommand(actor, 'chain_send:cancel', async (ctx, p: { sendId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const send = await lockSend(ctx, p.sendId);
    if (send.status !== 'BLOCKED') throw new DomainError('INVALID_TRANSITION', `send ${send.ref} is ${send.status.toLowerCase()}`);
    await ctx.tx.updateTable('chain_send').set({ status: 'PLANNED', blocked_reason: null, failed_attempts: 0, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    await appendAudit(ctx, { action: 'chain_send.unblocked', entityType: 'chain_send', entityId: send.id, before: { status: 'BLOCKED', reason: send.blocked_reason }, after: { status: 'PLANNED', reason } });
    await enqueueOutbox(ctx, { type: 'chain_send.planned', aggregateType: 'chain_send', aggregateId: send.id, payload: { sendId: send.id, status: 'PLANNED' } });
    return { status: 'PLANNED' as const };
  });
}
