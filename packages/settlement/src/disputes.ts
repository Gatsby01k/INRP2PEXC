import { sql } from 'kysely';
import { DomainError, Money, optionalText, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type ClientActor, type DomainCommand, type OperatorActor, authorizeOperator, operatorCommand } from '@inrp2p/identity';
import { planChainSend, signablePathOf, tradeHold } from '@inrp2p/network';
import { type TradeRow, assertPayoutsOpen, lockTrade, reloadTrade } from '@inrp2p/trades';
import { payoutNeedsSecondPerson } from './approvals.ts';
import { cancelTradeInTx, createUnwindRefundLegInTx } from './cancel.ts';
import { openExceptionInTx } from './exceptions.ts';
import { fundingSources } from './funding.ts';
import { assertNoPayoutUnderway, failPayoutLegInTx, lockLeg } from './legs.ts';
import { maskedBankDestination } from './movements.ts';
import {
  P2P_DISPUTE_REASONS, type P2pDisputeReason, closeCases, closeDisputeInTx, confirmP2pReceiptInTx, isP2pTrade, openDisputeOfLeg, startP2pUnwindInTx, tellBothSides, unwindOf,
} from './p2p.ts';
import type { SettlementDeps } from './policy.ts';

/**
 * Disputes of a P2P payment and the unwinding of a deal nobody paid (block 9, TD-35; ADR 0019 §2.6–2.7, ADR 0020 §2.15).
 *
 * The payee of a P2P payment — always the seller of the USDT: the trader on a client's BUY, the client on its SELL — can
 * say at once that the rupees did not arrive, instead of waiting out its window. That stops the deal (a blocking case
 * holds the trade) and hands it to INRP2P, which decides from the payee's bank, never from a screenshot: paid — the escrow
 * releases as if the payee had confirmed — or not paid — a BUY is cancelled and the trader's USDT goes back to it; a SELL
 * unwinds and the client's USDT goes back to it. The buyer adds its side for INRP2P; neither side reads the other's words.
 */

type Side = 'CLIENT' | 'TRADER';

/** Who receives the rupees of a P2P trade: the seller of the USDT. */
export const payeeOfDirection = (direction: 'BUY_USDT' | 'SELL_USDT'): Side => (direction === 'BUY_USDT' ? 'TRADER' : 'CLIENT');

/** The rupee payment of a P2P trade that waits for its payee — the one a dispute or a decision is about. */
async function waitingPayment(ex: Executor, tradeId: string, payee: Side) {
  const leg = await ex
    .selectFrom('settlement_leg')
    .select(['id', 'ref'])
    .where('trade_id', '=', tradeId)
    .where('asset', '=', 'INR')
    .where('status', '=', 'PROCESSING')
    .where((eb) => (payee === 'CLIENT' ? eb.and([eb('side', '=', 'EXCHANGE_TO_CLIENT'), eb('payer', '=', 'ROUTE')]) : eb('side', '=', 'CLIENT_TO_EXCHANGE')))
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return leg ?? null;
}

/**
 * `escrow_dispute.open` — the payee says the payment it was told of did not arrive: what its bank shows, and a note for
 * INRP2P. One dispute per payment, ever; the receipt case that waited for the payee is superseded by it.
 */
export async function openP2pDisputeInTx(
  ctx: TxContext,
  input: { readonly tradeId: string; readonly payee: Side; readonly userId: string; readonly reason: P2pDisputeReason; readonly note?: string | null },
): Promise<{ readonly ref: string }> {
  const trade = await lockTrade(ctx.tx, input.tradeId);
  if (!(await isP2pTrade(ctx.tx, trade.id))) throw new DomainError('INVALID_ARGUMENT', 'only a P2P payment is disputed by the one who should have received it');
  if (payeeOfDirection(trade.direction) !== input.payee) throw new DomainError('NOT_THE_PAYEE', 'only the one who receives the rupees says they did not arrive');
  const reason = requireOneOf(input.reason, 'reason', P2P_DISPUTE_REASONS);
  const note = optionalText(input.note, 'note', 1000);
  if (reason === 'OTHER' && !note) throw new DomainError('INVALID_ARGUMENT', 'say what your bank shows', { field: 'note' });
  const peek = await waitingPayment(ctx.tx, trade.id, input.payee);
  if (!peek) throw new DomainError('INVALID_TRANSITION', 'no payment of this deal waits for your confirmation');
  const leg = await lockLeg(ctx, peek.id);
  const before = await ctx.tx.selectFrom('p2p_dispute').select('ref').where('settlement_leg_id', '=', leg.id).executeTakeFirst();
  if (before) throw new DomainError('DISPUTE_EXISTS', `this payment is already with INRP2P (${before.ref})`);
  const filed = await ctx.tx
    .selectFrom('transfer_allocation as a')
    .innerJoin('fiat_transfer as f', 'f.id', 'a.fiat_transfer_id')
    .select(['f.rail', 'f.utr'])
    .where('a.settlement_leg_id', '=', leg.id)
    .where('a.voided_at', 'is', null)
    .executeTakeFirst();

  const opened = await openExceptionInTx(ctx, {
    type: 'P2P_DISPUTE', subjectType: 'SETTLEMENT_LEG', subjectId: leg.id, tradeId: trade.id,
    details: { payee: input.payee, reason, leg_ref: leg.ref, amount: Money.ofMinor(leg.amount_minor, 'INR').toDecimalString(), rail: filed?.rail ?? null, utr: filed?.utr ?? null },
  });
  await closeCases(ctx, 'P2P_RECEIPT_OVERDUE', 'SETTLEMENT_LEG', leg.id, `the ${input.payee === 'CLIENT' ? 'client' : 'trader'} says it did not arrive: INRP2P decides it`, 'escalate');
  const row = await ctx.tx
    .insertInto('p2p_dispute')
    .values({ trade_id: trade.id, settlement_leg_id: leg.id, exception_case_id: opened.exceptionId, payee: input.payee, reason, payee_note: note, opened_by: requireUuid(input.userId, 'userId') })
    .returning(['id', 'ref'])
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'p2p.dispute_opened', entityType: 'p2p_dispute', entityId: row.id, after: { ref: row.ref, trade_id: trade.id, leg_ref: leg.ref, payee: input.payee, reason, case: opened.ref } });
  await tellBothSides(ctx, 'dispute_opened', { tradeId: trade.id, clientId: trade.client_id, disputeId: row.id, payee: input.payee });
  return { ref: row.ref };
}

/** `escrow_dispute.answer` — the payer adds its side for INRP2P (its bank's reference, the time, the account it paid from). */
export async function answerP2pDisputeInTx(ctx: TxContext, input: { readonly tradeId: string; readonly payer: Side; readonly userId: string; readonly note: string }): Promise<{ readonly ref: string }> {
  const trade = await lockTrade(ctx.tx, input.tradeId);
  const payee: Side = input.payer === 'CLIENT' ? 'TRADER' : 'CLIENT';
  if (payeeOfDirection(trade.direction) !== payee) throw new DomainError('NOT_THE_PAYER', 'only the one who paid adds its side');
  const note = requireText(input.note, 'note', 1000);
  const d = await ctx.tx.selectFrom('p2p_dispute').select(['id', 'ref']).where('trade_id', '=', trade.id).where('status', '=', 'OPEN').forUpdate().executeTakeFirst();
  if (!d) throw new DomainError('INVALID_TRANSITION', 'nothing on this deal waits for your side');
  await ctx.tx.updateTable('p2p_dispute').set({ payer_note: note, payer_noted_by: requireUuid(input.userId, 'userId'), payer_noted_at: sql<Date>`inrp2p_now()` }).where('id', '=', d.id).execute();
  await appendAudit(ctx, { action: 'p2p.dispute_answered', entityType: 'p2p_dispute', entityId: d.id, after: { payer: input.payer } });
  return { ref: d.ref };
}

/** A command of a member of the trade's own client, named by the trade's reference. */
function clientTradeCommand<P extends { tradeRef: string }, R>(actor: ClientActor, handle: (ctx: TxContext, p: P, tradeId: string) => Promise<R>): DomainCommand<P, R> {
  let tradeId: string | undefined;
  return {
    authorize: async (ctx, p) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const trade = await ctx.tx.selectFrom('trade').select(['id', 'client_id']).where('ref', '=', requireText(p.tradeRef, 'tradeRef', 32)).executeTakeFirst();
      if (!trade) throw new DomainError('NOT_FOUND', 'trade not found');
      const member = await ctx.tx
        .selectFrom('client_user as cu')
        .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
        .select(['cu.status', 'u.kind', 'u.status as user_status'])
        .where('cu.user_id', '=', actor.userId)
        .where('cu.client_id', '=', trade.client_id)
        .executeTakeFirst();
      if (!member || member.kind !== 'CLIENT' || member.status !== 'ACTIVE' || member.user_status !== 'ACTIVE') throw new DomainError('NOT_FOUND', 'trade not found');
      tradeId = trade.id;
    },
    handle: async (ctx, p) => {
      if (!tradeId) throw new Error('command executed without authorization');
      return handle(ctx, p, tradeId);
    },
  };
}

/** `escrow_dispute.open` for a client selling USDT: the trader's rupees did not reach its account. */
export function openClientDispute(actor: ClientActor) {
  return clientTradeCommand(actor, (ctx, p: { tradeRef: string; reason: P2pDisputeReason; note?: string | null }, tradeId) =>
    openP2pDisputeInTx(ctx, { tradeId, payee: 'CLIENT', userId: actor.userId, reason: p.reason, note: p.note ?? null }));
}

/** `escrow_dispute.answer` for a client buying USDT whose payment the trader says did not arrive. */
export function answerClientDispute(actor: ClientActor) {
  return clientTradeCommand(actor, (ctx, p: { tradeRef: string; note: string }, tradeId) => answerP2pDisputeInTx(ctx, { tradeId, payer: 'CLIENT', userId: actor.userId, note: p.note }));
}

export interface P2pDecision {
  readonly decision: 'PAID' | 'NOT_PAID';
  readonly legRef: string;
}

/**
 * `escrow_payment.decide` — `exception:resolve`, with the permission the outcome needs: confirming the client's rupees
 * (`settlement:confirm_incoming`) or the trader's (`settlement:confirm_payout`) for paid, `trade:cancel` for not paid.
 * Only a payment its payee disputed or never answered: until then the payee decides.
 *
 * - Paid: the sender as the payee's bank shows it is checked like the payee's own confirmation; on a partial match the
 *   decision's evidence accepts it, a stranger is refused. The payment counts and the escrow releases.
 * - Not paid: the payment fails. A BUY is cancelled and the trader's USDT goes back from the escrow; a SELL unwinds and
 *   the client's USDT goes back (`planP2pRefundInTx`).
 */
export function decideP2pPayment(actor: OperatorActor, deps: SettlementDeps) {
  return operatorCommand(actor, 'exception:resolve', async (ctx, p: { tradeId: string; decision: 'PAID' | 'NOT_PAID'; notes: string; senderName?: string | null; senderAccount?: string | null }): Promise<P2pDecision> => {
    const decision = requireOneOf(p.decision, 'decision', ['PAID', 'NOT_PAID'] as const);
    const notes = requireText(p.notes, 'notes', 2000);
    const trade = await lockTrade(ctx.tx, p.tradeId);
    if (!(await isP2pTrade(ctx.tx, trade.id))) throw new DomainError('INVALID_ARGUMENT', 'only a P2P payment is decided here');
    const buy = trade.direction === 'BUY_USDT';
    await authorizeOperator(ctx.tx, actor, decision === 'PAID' ? (buy ? 'settlement:confirm_incoming' : 'settlement:confirm_payout') : 'trade:cancel');
    const payee = payeeOfDirection(trade.direction);
    const leg = await waitingPayment(ctx.tx, trade.id, payee);
    if (!leg) throw new DomainError('INVALID_TRANSITION', 'no payment of this deal waits for a decision');
    const dispute = await openDisputeOfLeg(ctx.tx, leg.id);
    const overdue = await ctx.tx.selectFrom('exception_case').select('id').where('type', '=', 'P2P_RECEIPT_OVERDUE').where('subject_id', '=', leg.id).where('status', 'in', ['OPEN', 'IN_PROGRESS']).executeTakeFirst();
    if (!dispute && !overdue) throw new DomainError('NOT_DUE', 'the payee still has its time to confirm: INRP2P decides a payment once it is disputed or overdue');

    if (decision === 'PAID') {
      const out = await confirmP2pReceiptInTx(ctx, deps, {
        tradeId: trade.id, legId: leg.id, payee, senderName: requireText(p.senderName, 'senderName', 140), senderAccount: p.senderAccount ?? null, via: 'DESK', evidence: notes,
      });
      if (!out.confirmed) throw new DomainError('SENDER_NOT_SHOWN', 'the payee’s bank must show who sent the payment before it is decided paid');
    } else {
      if (dispute) await closeDisputeInTx(ctx, dispute, { status: 'NOT_PAID', via: 'INRP2P', notes });
      await closeCases(ctx, 'P2P_RECEIPT_OVERDUE', 'SETTLEMENT_LEG', leg.id, `INRP2P found the payment did not arrive: ${notes}`, 'p2p_decide');
      const reason = `not received: ${notes}`.slice(0, 500);
      if (buy) {
        // The client's payment fails with the cancel, inside it: the obligation is locked before any leg.
        await cancelTradeInTx(ctx, { trade: await reloadTrade(ctx.tx, trade.id), reason: 'the client’s payment did not arrive: the trader’s USDT goes back to it', notReceived: true });
      } else {
        await failPayoutLegInTx(ctx, leg.id, reason, { replacement: false });
        await startP2pUnwindInTx(ctx, { tradeId: trade.id, reason: 'NOT_PAID', disputeId: dispute?.id ?? null });
      }
    }
    await appendAudit(ctx, { action: 'p2p.payment_decided', entityType: 'trade', entityId: trade.id, after: { decision, leg_ref: leg.ref, dispute: dispute?.ref ?? null, notes } });
    return { decision, legRef: leg.ref };
  });
}

/** Why an unwind waits for a person, said once on the unwind and once as the desk's case. */
async function waitForPerson(ctx: TxContext, trade: TradeRow, current: string | null, reason: string): Promise<{ readonly waiting: string }> {
  if (current !== reason) {
    await ctx.tx.updateTable('p2p_unwind').set({ waiting_reason: reason, updated_at: sql<Date>`inrp2p_now()` }).where('trade_id', '=', trade.id).execute();
  }
  await openExceptionInTx(ctx, { type: 'P2P_PAYMENT_OVERDUE', subjectType: 'TRADE', subjectId: trade.id, tradeId: trade.id, details: { unwind: true, reason } });
  return { waiting: reason };
}

/**
 * Plans the return of a client's USDT from the escrow of a deal its trader never paid (TD-35), through autopay: every
 * USDT of the client's from the deal address, to the registered wallet it came from — the only place it can go — paid by
 * the trader's own network deposit; over the approval threshold the send waits for a second person. When the signer
 * cannot do it (an address it does not hold, a sender the client never registered), the desk is handed a case and does
 * it by hand (*Refund and cancel*). The caller has just observed the deal address (B2).
 */
export async function planP2pRefundInTx(ctx: TxContext, deps: Pick<SettlementDeps, 'policy'>, tradeId: string): Promise<{ readonly sendRef: string } | { readonly waiting: string } | null> {
  const trade = await lockTrade(ctx.tx, tradeId);
  if (trade.lifecycle_state === 'COMPLETED' || trade.lifecycle_state === 'CANCELLED') return null;
  const unwind = await unwindOf(ctx.tx, trade.id);
  if (!unwind) return null;
  const live = await ctx.tx.selectFrom('settlement_leg').select('id').where('trade_id', '=', trade.id).where('side', '=', 'REFUND_TO_CLIENT').where('status', 'in', ['PENDING', 'PROCESSING']).executeTakeFirst();
  if (live) return null;
  await assertPayoutsOpen(ctx.tx);
  await assertNoPayoutUnderway(ctx.tx, trade.id);

  const source = (await fundingSources(ctx.tx, trade.id, { kind: 'CLIENT_FUNDS', asset: 'USDT' })).find((f) => f.availableMinor > 0n);
  if (!source) return waitForPerson(ctx, trade, unwind.waiting_reason, 'nothing of the client’s USDT is free at the deal address');
  const from = source.location.slice('TRON:'.length);
  const deposit = await ctx.tx.selectFrom('deposit_address').select('id').where('network', '=', 'TRON').where('address', '=', from).executeTakeFirst();
  if (!deposit || !(await signablePathOf(ctx.tx, from))) return waitForPerson(ctx, trade, unwind.waiting_reason, 'the deal address is not one the signer holds: refund the client by hand');
  const senders = await sql<{ id: string; address: string }>`
    select distinct w.id, w.address
      from settlement_leg l
      join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null
      join crypto_transfer c on c.id = a.crypto_transfer_id
      join crypto_wallet w on w.client_id = ${trade.client_id} and w.address = c.from_address and w.status = 'ACTIVE' and w.purpose in ('SOURCE', 'BOTH')
     where l.trade_id = ${trade.id} and l.side = 'CLIENT_TO_EXCHANGE' and l.status = 'COMPLETED'`.execute(ctx.tx);
  const wallet = senders.rows.length === 1 ? senders.rows[0]! : null;
  if (!wallet) {
    return waitForPerson(ctx, trade, unwind.waiting_reason, senders.rows.length === 0
      ? 'the USDT came from a wallet the client has not registered: refund it by hand to a wallet the client registers'
      : 'the USDT came from more than one wallet: refund it by hand');
  }
  const hold = await tradeHold(ctx.tx, trade.id);
  if (!hold || hold.status !== 'ACTIVE' || !hold.trader_id) throw new DomainError('NETWORK_BUDGET_INSUFFICIENT', 'this trade holds no network budget for the refund');

  const leg = await createUnwindRefundLegInTx(ctx, deps, trade, {
    sourceDepositAddressId: deposit.id, destinationWalletId: wallet.id,
    notes: unwind.reason === 'PAY_WINDOW_MISSED' ? 'P2P unwind: the trader did not pay in time' : 'P2P unwind: INRP2P found the trader’s payment did not arrive',
  });
  const requestedBy = `SYSTEM:${ctx.commandName}`;
  await ctx.tx.updateTable('settlement_leg').set({ status: 'PROCESSING', sent_at: sql<Date>`inrp2p_now()`, sent_by: requestedBy }).where('id', '=', leg.id).execute();
  const send = await planChainSend(ctx, {
    purpose: 'REFUND', asset: 'USDT', tradeId: trade.id, legId: leg.id, fromAddress: from, toAddress: wallet.address, amountMinor: leg.amount.minor,
    funder: hold.trader_id, bearer: 'TRADER', needsApproval: await payoutNeedsSecondPerson(ctx.tx, { trade_id: trade.id, asset: 'USDT', amount_minor: leg.amount.minor }), requestedBy,
  });
  await ctx.tx.updateTable('p2p_unwind').set({ refund_leg_id: leg.id, waiting_reason: null, updated_at: sql<Date>`inrp2p_now()` }).where('trade_id', '=', trade.id).execute();
  await appendAudit(ctx, { action: 'p2p.refund_planned', entityType: 'trade', entityId: trade.id, after: { leg: leg.ref, send: send.ref, amount: leg.amount, to: wallet.address, reason: unwind.reason } });
  return { sendRef: send.ref };
}

/** What the desk sees to decide a P2P payment: the payment, what each side told INRP2P, and how an unwind stands. */
export interface P2pDecisionView {
  readonly payee: Side;
  /** The payment waiting for its payee, if any. */
  readonly payment: {
    readonly legId: string;
    readonly ref: string;
    readonly amount: string;
    readonly rail: string | null;
    readonly utr: string | null;
    readonly filedAt: string;
    /** The payer's own account it was declared from, masked. */
    readonly declaredFrom: string | null;
  } | null;
  readonly dispute: {
    readonly ref: string;
    readonly reason: P2pDisputeReason;
    readonly status: 'OPEN' | 'PAID' | 'NOT_PAID';
    readonly openedAt: string;
    readonly payeeNote: string | null;
    readonly payerNote: string | null;
    readonly payerNotedAt: string | null;
    readonly decidedVia: 'INRP2P' | 'PAYEE' | null;
    readonly decidedAt: string | null;
    readonly decisionNotes: string | null;
  } | null;
  /** The payee did not answer in its window. */
  readonly overdue: boolean;
  /** A payment INRP2P may decide now: disputed or overdue, and still waiting. */
  readonly decidable: boolean;
  readonly unwind: { readonly reason: 'PAY_WINDOW_MISSED' | 'NOT_PAID'; readonly waitingReason: string | null; readonly refundRef: string | null; readonly refundStatus: string | null } | null;
}

export async function p2pDecisionView(ex: Executor, tradeId: string): Promise<P2pDecisionView | null> {
  const trade = await ex.selectFrom('trade').select(['id', 'direction']).where('id', '=', requireUuid(tradeId, 'tradeId')).executeTakeFirst();
  if (!trade || !(await isP2pTrade(ex, trade.id))) return null;
  const payee = payeeOfDirection(trade.direction);
  const d = await ex.selectFrom('p2p_dispute').selectAll().where('trade_id', '=', trade.id).orderBy('created_at', 'desc').executeTakeFirst();
  const u = await unwindOf(ex, trade.id);
  const legPeek = await waitingPayment(ex, trade.id, payee);
  const overdue = legPeek
    ? (await ex.selectFrom('exception_case').select('id').where('type', '=', 'P2P_RECEIPT_OVERDUE').where('subject_id', '=', legPeek.id).where('status', 'in', ['OPEN', 'IN_PROGRESS']).executeTakeFirst()) !== undefined
    : false;
  if (!d && !u && !overdue) return null;

  let payment: P2pDecisionView['payment'] = null;
  if (legPeek) {
    const r = await ex
      .selectFrom('settlement_leg as l')
      .leftJoin('transfer_allocation as a', (j) => j.onRef('a.settlement_leg_id', '=', 'l.id').on('a.voided_at', 'is', null))
      .leftJoin('fiat_transfer as f', 'f.id', 'a.fiat_transfer_id')
      .select(['l.id', 'l.ref', 'l.amount_minor', 'l.created_at', 'f.rail', 'f.utr', 'f.payer_bank_account_id'])
      .where('l.id', '=', legPeek.id)
      .executeTakeFirstOrThrow();
    payment = {
      legId: r.id, ref: r.ref, amount: Money.ofMinor(r.amount_minor, 'INR').toDecimalString(), rail: r.rail, utr: r.utr, filedAt: r.created_at.toISOString(),
      declaredFrom: r.payer_bank_account_id ? await maskedBankDestination(ex, r.payer_bank_account_id) : null,
    };
  }
  const refund = u?.refund_leg_id ? await ex.selectFrom('settlement_leg').select(['ref', 'status']).where('id', '=', u.refund_leg_id).executeTakeFirst() : undefined;
  return {
    payee,
    payment,
    dispute: d
      ? {
          ref: d.ref, reason: d.reason, status: d.status, openedAt: d.created_at.toISOString(), payeeNote: d.payee_note, payerNote: d.payer_note,
          payerNotedAt: d.payer_noted_at?.toISOString() ?? null, decidedVia: d.decided_via, decidedAt: d.decided_at?.toISOString() ?? null, decisionNotes: d.decision_notes,
        }
      : null,
    overdue,
    decidable: payment !== null && (d?.status === 'OPEN' || overdue),
    unwind: u ? { reason: u.reason, waitingReason: u.waiting_reason, refundRef: refund?.ref ?? null, refundStatus: refund?.status ?? null } : null,
  };
}
