import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, Money, type InrRail, accountUpiAddress, checkIfsc, optionalText, railOptions, requireOneOf, requireText, requireUtrShape, requireUuid, upiPayUri } from '@inrp2p/kernel';
import type { Db, Executor, ExceptionType, SenderVerdict, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { bankAccountSealContext } from '@inrp2p/clients';
import { executeCommand } from '@inrp2p/commands';
import { enqueueOutbox } from '@inrp2p/outbox';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';
import { lockTrade } from '@inrp2p/trades';
import { cancelTradeInTx } from './cancel.ts';
import { confirmPayoutLegInTx } from './confirm.ts';
import { openExceptionInTx, resolveExceptionInTx } from './exceptions.ts';
import { confirmClientLegInTx } from './firstleg.ts';
import { createPayoutLegInTx, sendPayoutLegInTx } from './legs.ts';
import { maskedBankDestination, recordFiatTransfer } from './movements.ts';
import type { SettlementDeps } from './policy.ts';
import { recordSenderCheckInTx } from './sender.ts';
import { type DealChatView, dealChatView } from './chat.ts';
import {
  type PayWindow, PAY_METHOD_CHANGES, dealNow, isPaying, openPayWindowInTx, p2pPayState, payWindowOf, programP2pTiming, prospectiveWindow, warnPayWindowInTx,
} from './p2p-timing.ts';

/**
 * P2P escrow (ADR 0019): the rupees of a trade move once, straight between the client's and the trader's own registered
 * accounts, while the exchange holds the USDT at the deal's own address. The one who pays says so with the bank's
 * reference; the one who received confirms it — and, from its own bank's screen, who sent it (ADR 0018). Only then does
 * the escrow release.
 */

export async function isP2pTrade(ex: Executor, tradeId: string): Promise<boolean> {
  const e = await ex.selectFrom('trade_economics').select('route_execution_mode').where('trade_id', '=', tradeId).executeTakeFirst();
  return e?.route_execution_mode === 'P2P';
}

/**
 * The trader paid the client its rupees (a client selling USDT): a route-paid payout leg, sent, with the trader's own
 * reference and the trader's registered account as its source. Nothing counts until the client confirms it.
 */
export async function fileRoutePayoutInTx(
  ctx: TxContext,
  deps: Pick<SettlementDeps, 'policy'>,
  input: { readonly tradeId: string; readonly rail: InrRail; readonly utr: string; readonly amount: Money<'INR'>; readonly payerBankAccountId: string },
): Promise<{ readonly legId: string; readonly legRef: string; readonly transferId: string }> {
  if (!(await isP2pTrade(ctx.tx, input.tradeId))) throw new DomainError('INVALID_ARGUMENT', 'only a P2P trader pays the client directly');
  // An unwound deal takes no payment any more: its USDT is going back to the client (IX129 says the same at the insert).
  if (await unwindOf(ctx.tx, input.tradeId)) throw new DomainError('P2P_PAYMENT_WINDOW_CLOSED', 'the payment window of this deal closed: the client’s USDT is going back to it — do not pay');
  const leg = await createPayoutLegInTx(ctx, deps, { tradeId: input.tradeId, amount: input.amount.toDecimalString(), payer: 'ROUTE' });
  await sendPayoutLegInTx(ctx, deps, leg.legId);
  const row = await ctx.tx.selectFrom('settlement_leg').select(['route_id', 'destination_bank_account_id', 'amount_minor']).where('id', '=', leg.legId).executeTakeFirstOrThrow();
  const trade = await ctx.tx.selectFrom('trade').select('client_id').where('id', '=', input.tradeId).executeTakeFirstOrThrow();
  const recorded = await recordFiatTransfer(ctx, {
    rail: input.rail,
    utr: requireUtrShape(input.rail, input.utr),
    amount: Money.ofMinor(row.amount_minor, 'INR'),
    payerType: 'ROUTE',
    payerId: row.route_id!,
    payeeType: 'CLIENT_BANK',
    payeeId: trade.client_id,
    destinationMasked: await maskedBankDestination(ctx.tx, row.destination_bank_account_id!),
    payerBankAccountId: input.payerBankAccountId,
    filedBy: 'TRADER',
  });
  await ctx.tx
    .insertInto('transfer_allocation')
    .values({ transfer_kind: 'FIAT', fiat_transfer_id: recorded.transferId, dimension: 'CLIENT', settlement_leg_id: leg.legId, amount_minor: row.amount_minor, allocated_by: ctx.actor.id ?? 'SYSTEM' })
    .execute();
  await enqueueOutbox(ctx, { type: 'client.p2p_payment_sent', aggregateType: 'trade', aggregateId: input.tradeId, payload: { tradeId: input.tradeId, clientId: trade.client_id, legRef: leg.ref } });
  await closeCases(ctx, 'P2P_PAYMENT_OVERDUE', 'TRADE', input.tradeId, `the trader filed its payment ${leg.ref}`);
  return { legId: leg.legId, legRef: leg.ref, transferId: recorded.transferId };
}

export interface ReceiptOutcome {
  /** The verdict on the sender the payee saw; the payment counts only on MATCH. */
  readonly verdict: SenderVerdict;
  readonly confirmed: boolean;
  readonly exceptionId: string | null;
}

/**
 * The payee confirms it received a P2P payment, saying who its bank shows sent it. The sender is judged against the
 * account the payer declared; on a match the payment counts at once (the client's leg of a BUY, the route-paid payout
 * of a SELL), and the escrow can release. A partial match waits for the desk; a stranger's rupees open a case.
 *
 * INRP2P decides a disputed or unanswered payment through the same step (`via: 'DESK'`), from the payee's bank: there a
 * partial match is accepted on the evidence the decision records. Either way a dispute of the payment ends with it — the
 * payee received it after all, or INRP2P found it paid.
 *
 * Locks: the trade first, then the payment's own row through the check (the confirmation re-enters the same order).
 */
export async function confirmP2pReceiptInTx(
  ctx: TxContext,
  deps: SettlementDeps,
  input: {
    readonly tradeId: string; readonly legId: string; readonly payee: 'CLIENT' | 'TRADER'; readonly senderName: string; readonly senderAccount?: string | null;
    readonly via?: 'PAYEE' | 'DESK'; readonly evidence?: string | null;
  },
): Promise<ReceiptOutcome> {
  const trade = await lockTrade(ctx.tx, input.tradeId);
  if (!(await isP2pTrade(ctx.tx, trade.id))) throw new DomainError('INVALID_ARGUMENT', 'only a P2P payment is confirmed by the one who received it');
  const leg = await ctx.tx.selectFrom('settlement_leg').select(['id', 'trade_id', 'side', 'payer', 'status', 'asset']).where('id', '=', requireUuid(input.legId, 'legId')).executeTakeFirst();
  if (!leg || leg.trade_id !== trade.id || leg.asset !== 'INR') throw new DomainError('NOT_FOUND', 'payment not found');
  // A client receives the trader's payout; a trader receives the client's leg.
  const expected = input.payee === 'CLIENT' ? leg.side === 'EXCHANGE_TO_CLIENT' && leg.payer === 'ROUTE' : leg.side === 'CLIENT_TO_EXCHANGE';
  if (!expected) throw new DomainError('NOT_THE_PAYEE', 'this payment is not one you receive');
  if (leg.status !== 'PROCESSING') throw new DomainError('INVALID_TRANSITION', `the payment is ${leg.status.toLowerCase()}`);
  const allocation = await ctx.tx.selectFrom('transfer_allocation').select('fiat_transfer_id').where('settlement_leg_id', '=', leg.id).where('voided_at', 'is', null).executeTakeFirst();
  if (!allocation?.fiat_transfer_id) throw new DomainError('NOT_FOUND', 'the payment has no reference yet');

  const via = input.via ?? 'PAYEE';
  const evidence = via === 'DESK' ? requireText(input.evidence, 'notes', 2000) : null;
  const name = requireText(input.senderName, 'senderName', 140);
  const check = await recordSenderCheckInTx(ctx, { transferId: allocation.fiat_transfer_id, via, seen: { name, account: optionalText(input.senderAccount, 'senderAccount', 80) }, locked: true });
  let verdict: SenderVerdict = check.verdict;
  await appendAudit(ctx, { action: 'p2p.receipt_checked', entityType: 'settlement_leg', entityId: leg.id, after: { payee: input.payee, verdict, via } });
  if (verdict === 'MISMATCH' && via === 'DESK') {
    // INRP2P never decides a stranger's rupees paid: they go back, and the payment did not arrive.
    throw new DomainError('INR_UNEXPECTED_SENDER', 'that is not the payer’s registered account: the rupees go back to whoever sent them — decide the payment not paid');
  }
  if (verdict === 'PARTIAL' && evidence) {
    const last = await ctx.tx.selectFrom('fiat_sender_check').select('expected_bank_account_id').where('fiat_transfer_id', '=', allocation.fiat_transfer_id).orderBy('checked_at', 'desc').orderBy('id', 'desc').executeTakeFirstOrThrow();
    await ctx.tx.insertInto('fiat_sender_check')
      .values({ fiat_transfer_id: allocation.fiat_transfer_id, via: 'DESK', verdict: 'ACCEPTED', expected_bank_account_id: last.expected_bank_account_id, reason: evidence.slice(0, 500), checked_by: ctx.actor.id ?? 'SYSTEM' })
      .execute();
    await appendAudit(ctx, { action: 'fiat.sender_accepted', entityType: 'fiat_transfer', entityId: allocation.fiat_transfer_id, before: { verdict }, after: { verdict: 'ACCEPTED', reason: evidence } });
    verdict = 'ACCEPTED';
  }
  if (verdict !== 'MATCH' && verdict !== 'ACCEPTED') return { verdict, confirmed: false, exceptionId: check.exceptionId };

  // The dispute's hold goes first: nothing is confirmed on a trade on hold.
  const dispute = await openDisputeOfLeg(ctx.tx, leg.id);
  if (dispute) {
    await closeDisputeInTx(ctx, dispute, via === 'DESK'
      ? { status: 'PAID', via: 'INRP2P', notes: evidence! }
      : { status: 'PAID', via: 'PAYEE', notes: `the ${input.payee === 'CLIENT' ? 'client' : 'trader'} confirmed it received the payment after all` });
  }
  await closeCases(ctx, 'P2P_RECEIPT_OVERDUE', 'SETTLEMENT_LEG', leg.id, via === 'DESK' ? `INRP2P found the payment paid: ${evidence}` : `the ${input.payee === 'CLIENT' ? 'client' : 'trader'} confirmed it received the payment`, via === 'DESK' ? 'p2p_decide' : 'confirm');
  if (input.payee === 'CLIENT') await confirmPayoutLegInTx(ctx, deps, leg.id);
  else await confirmClientLegInTx(ctx, deps, leg.id);
  return { verdict, confirmed: true, exceptionId: null };
}

/** A late answer still counts: the case that waited for it is closed by it. */
export async function closeCases(ctx: TxContext, type: ExceptionType, subjectType: 'TRADE' | 'SETTLEMENT_LEG', subjectId: string, notes: string, resolution: 'confirm' | 'p2p_decide' | 'escalate' = 'confirm'): Promise<void> {
  const open = await ctx.tx.selectFrom('exception_case').select('id').where('type', '=', type).where('subject_type', '=', subjectType).where('subject_id', '=', subjectId)
    .where('status', 'in', ['OPEN', 'IN_PROGRESS']).execute();
  for (const c of open) await resolveExceptionInTx(ctx, { exceptionId: c.id, resolution, notes });
}

// ---- disputes and unwinds (block 9, TD-35) ---------------------------------------------------------------------------

export interface OpenDispute {
  readonly id: string;
  readonly ref: string;
  readonly tradeId: string;
  readonly legId: string;
  readonly caseId: string;
  readonly payee: 'CLIENT' | 'TRADER';
}

/** The open dispute of a payment, locked: it is decided once. */
export async function openDisputeOfLeg(ex: Executor, legId: string): Promise<OpenDispute | null> {
  const r = await sql<{ id: string; ref: string; trade_id: string; settlement_leg_id: string; exception_case_id: string; payee: 'CLIENT' | 'TRADER' }>`
    select id, ref, trade_id, settlement_leg_id, exception_case_id, payee from p2p_dispute where settlement_leg_id = ${legId} and status = 'OPEN' for update`.execute(ex);
  const d = r.rows[0];
  return d ? { id: d.id, ref: d.ref, tradeId: d.trade_id, legId: d.settlement_leg_id, caseId: d.exception_case_id, payee: d.payee } : null;
}

/** Ends a dispute — paid (by INRP2P, or the payee after all) or not paid — with its case, and tells both sides. */
export async function closeDisputeInTx(ctx: TxContext, d: OpenDispute, out: { readonly status: 'PAID' | 'NOT_PAID'; readonly via: 'INRP2P' | 'PAYEE'; readonly notes: string }): Promise<void> {
  const notes = requireText(out.notes, 'notes', 2000);
  await ctx.tx.updateTable('p2p_dispute')
    .set({ status: out.status, decided_via: out.via, decided_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`, decided_at: sql<Date>`inrp2p_now()`, decision_notes: notes })
    .where('id', '=', d.id).where('status', '=', 'OPEN').execute();
  await resolveExceptionInTx(ctx, { exceptionId: d.caseId, resolution: 'p2p_decide', notes: `${out.status === 'PAID' ? 'paid' : 'not paid'}: ${notes}` });
  await appendAudit(ctx, { action: 'p2p.dispute_decided', entityType: 'p2p_dispute', entityId: d.id, before: { status: 'OPEN' }, after: { status: out.status, via: out.via, notes } });
  const trade = await ctx.tx.selectFrom('trade').select('client_id').where('id', '=', d.tradeId).executeTakeFirstOrThrow();
  await tellBothSides(ctx, 'dispute_decided', { tradeId: d.tradeId, clientId: trade.client_id, disputeId: d.id, payee: d.payee, decision: out.status, via: out.via });
}

/**
 * A dispute or an unwind concerns both sides of a deal: one event for the client (`p2p.*`) and one for the trader
 * (`trader.p2p_*`), each told in its own inbox — an inbox takes one message per event.
 */
export async function tellBothSides(ctx: TxContext, what: 'dispute_opened' | 'dispute_decided' | 'unwind_started' | 'pay_final_call' | 'receipt_late', payload: { readonly tradeId: string } & Record<string, unknown>): Promise<void> {
  await enqueueOutbox(ctx, { type: `p2p.${what}`, aggregateType: 'trade', aggregateId: payload.tradeId, payload });
  await enqueueOutbox(ctx, { type: `trader.p2p_${what}`, aggregateType: 'trade', aggregateId: payload.tradeId, payload });
}

export async function unwindOf(ex: Executor, tradeId: string) {
  return ex.selectFrom('p2p_unwind').select(['trade_id', 'reason', 'p2p_dispute_id', 'refund_leg_id', 'waiting_reason']).where('trade_id', '=', tradeId).executeTakeFirst();
}

/**
 * The client's USDT goes back from the escrow of a SELL whose trader did not pay — in time, or at all (TD-35). Recorded
 * once; the worker's autopay plans the return (`planP2pRefundInTx`) and the trade is cancelled once it lands. The caller
 * holds the trade lock.
 */
export async function startP2pUnwindInTx(ctx: TxContext, input: { readonly tradeId: string; readonly reason: 'PAY_WINDOW_MISSED' | 'NOT_PAID'; readonly disputeId?: string | null }): Promise<boolean> {
  if (await unwindOf(ctx.tx, input.tradeId)) return false;
  await ctx.tx.insertInto('p2p_unwind').values({ trade_id: input.tradeId, reason: input.reason, p2p_dispute_id: input.disputeId ?? null, decided_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}` }).execute();
  const trade = await ctx.tx.selectFrom('trade').select('client_id').where('id', '=', input.tradeId).executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'p2p.unwind_started', entityType: 'trade', entityId: input.tradeId, after: { reason: input.reason, dispute_id: input.disputeId ?? null } });
  await tellBothSides(ctx, 'unwind_started', { tradeId: input.tradeId, clientId: trade.client_id, reason: input.reason });
  return true;
}

/**
 * `payout.confirm_received` for a client: a member of the client of a P2P trade selling USDT confirms the trader's rupees
 * arrived — and from whom.
 */
export function confirmClientReceipt(actor: ClientActor, deps: SettlementDeps): DomainCommand<{ tradeRef: string; legRef: string; senderName: string; senderAccount?: string | null }, ReceiptOutcome> {
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
      const leg = await ctx.tx.selectFrom('settlement_leg').select('id').where('ref', '=', requireText(p.legRef, 'legRef', 40)).where('trade_id', '=', tradeId).executeTakeFirst();
      if (!leg) throw new DomainError('NOT_FOUND', 'payment not found');
      return confirmP2pReceiptInTx(ctx, deps, { tradeId, legId: leg.id, payee: 'CLIENT', senderName: p.senderName, senderAccount: p.senderAccount ?? null });
    },
  };
}

/** The rupees of a P2P trade's own payments, newest last: what each side sees on its screen. */
export async function p2pPayments(ex: Executor, tradeId: string) {
  const rows = await sql<{ ref: string; side: string; amount_minor: bigint; status: string; created_at: Date; rail: string | null; utr: string | null; verdict: string | null }>`
    select l.ref, l.side, l.amount_minor, l.status, l.created_at, f.rail, f.utr, case when f.id is null then null else inrp2p_fiat_sender_verdict(f.id) end as verdict
    from settlement_leg l
    left join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null and a.fiat_transfer_id is not null
    left join fiat_transfer f on f.id = a.fiat_transfer_id
    where l.trade_id = ${tradeId} and l.asset = 'INR'
    order by l.created_at`.execute(ex);
  return rows.rows.map((r) => ({
    ref: r.ref, side: r.side, amount: Money.ofMinor(r.amount_minor, 'INR').toDecimalString(), status: r.status, filedAt: r.created_at.toISOString(),
    rail: r.rail, utr: r.utr, verdict: r.verdict,
  }));
}

export const P2P_RAILS = ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const;
export const requireP2pRail = (rail: unknown): InrRail => requireOneOf(rail, 'rail', P2P_RAILS);

export interface P2pDeadlinesReport {
  readonly cancelled: number;
  /** SELLs whose trader did not pay in time: the client's USDT goes back. */
  readonly unwound: number;
  /** Buyers whose time to pay ran out: told once, with the final period to say they paid. */
  readonly warned: number;
  readonly cases: number;
  readonly failures: readonly { readonly tradeId: string; readonly message: string }[];
}

/**
 * `p2p_deadlines` (cron, every minute): the time limits of P2P deals (ADR 0019 §2.7, ADR 0023), each trade in its own
 * step, every one decided again under the trade's lock — a payment said to be sent a moment ago wins over its deadline.
 *
 * - A deal whose seller did not fund the escrow in time is cancelled exactly as the desk would: a client buying USDT whose
 *   trader's USDT never came, a client selling USDT that never sent its own — its price was firm for the deposit window,
 *   not for ever, and the trader's capacity comes back. Never while a transfer into the escrow is already seen, final or
 *   not, and never before the deposit scanner has read the whole chain a few minutes past the deadline: a transfer sent
 *   in the last minute is seen first. One that lands after all becomes a case (FUNDS_AFTER_TRADE_CLOSED) and goes back.
 * - A deal whose escrow is final waits for its buyer's rupees for its pay window — its method's time (UPI 15, IMPS 30,
 *   NEFT 60, RTGS 45 minutes by default) from the escrow being final and the payee's account being shown. When that is
 *   up and the buyer has not said it paid, it is warned and has the final period; only after that is the deal undone: a
 *   BUY is cancelled and the trader's USDT goes back to it (`planEscrowReturnInTx`), a SELL unwinds and the client's
 *   USDT goes back (`startP2pUnwindInTx`, TD-35) — the trader can no longer pay.
 * - A payee that has neither confirmed nor disputed a payment in its rail's time gives the desk a case
 *   (`P2P_RECEIPT_OVERDUE`) and both sides are told INRP2P is checking: NEFT and RTGS are given longer. A late
 *   confirmation still counts.
 *
 * A deal whose rupees were ever said to be sent is never undone here, and nor is one on hold: that one waits for its
 * payee, or a person.
 */
export async function runP2pDeadlines(db: Db, limit = 50): Promise<P2pDeadlinesReport> {
  const failures: { tradeId: string; message: string }[] = [];
  let cancelled = 0;
  let unwound = 0;
  let warned = 0;
  let cases = 0;
  const once = async <R>(tradeId: string, name: string, fn: (ctx: TxContext) => Promise<R>): Promise<R | null> => {
    const key = randomUUID();
    try {
      const out = await executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { tradeId, run: key }, idempotencyKey: key, financial: true });
      return out.result;
    } catch (e) {
      failures.push({ tradeId, message: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  // A deal whose seller never put its USDT in escrow: the trader of a BUY, the client of a SELL.
  const unfunded = await sql<{ trade_id: string }>`
    select t.id as trade_id
      from trade t
      join trade_economics e on e.trade_id = t.id
      join route_obligation o on o.trade_id = t.id
     where e.route_execution_mode = 'P2P' and t.lifecycle_state = 'AWAITING_FIRST_LEG' and not t.hold
       and case when t.direction = 'BUY_USDT'
                then not inrp2p_counterparty_delivered(o.id)
                     and not exists (select 1 from route_settlement s where s.route_obligation_id = o.id and s.obligation_side = 'ROUTE_DELIVERS' and s.status = 'RECORDED')
                else not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'CLIENT_TO_EXCHANGE') end
       and t.opened_at + make_interval(mins => ((select p2p_timing from trader_program where id = 1)->>'escrowMinutes')::integer + ${ESCROW_SEEN_GRACE_MINUTES}) < inrp2p_now()
       and exists (select 1 from chain_cursor c
                    where c.network = 'TRON' and c.last_complete and c.last_window_to is not null and c.last_scanned_block >= c.last_window_to
                      and c.last_run_at >= t.opened_at + make_interval(mins => ((select p2p_timing from trader_program where id = 1)->>'escrowMinutes')::integer + ${ESCROW_SEEN_GRACE_MINUTES}))
     order by t.opened_at limit ${limit}`.execute(db);
  for (const u of unfunded.rows) {
    const done = await once(u.trade_id, 'trade.expire_unfunded_escrow', async (ctx) => {
      const trade = await lockTrade(ctx.tx, u.trade_id);
      const s = await p2pPayState(ctx.tx, trade.id);
      if (!s || trade.lifecycle_state !== 'AWAITING_FIRST_LEG' || trade.hold || s.fundedAt || s.everFiled) return false;
      // Looked at again under the lock: a transfer into the escrow seen a moment ago keeps the deal.
      if (await escrowTransferSeen(ctx.tx, trade.id, s.buy)) return false;
      await cancelTradeInTx(ctx, {
        trade, expiredUnpaid: true,
        reason: s.buy ? 'the trader did not fund the escrow in time' : 'your USDT did not arrive within the deposit window — if you sent it after all, it is returned to you',
      });
      return true;
    });
    if (done) cancelled += 1;
  }

  // Deals waiting for their buyer's rupees whose window must open, warn, or end.
  const paying = await sql<{ trade_id: string }>`
    select t.id as trade_id
      from trade t
      join trade_economics e on e.trade_id = t.id
      join route_obligation o on o.trade_id = t.id
      left join p2p_pay_window w on w.trade_id = t.id
     where e.route_execution_mode = 'P2P' and not t.hold
       and (w.trade_id is null or (w.warned_at is null and w.due_at <= inrp2p_now()) or w.final_until <= inrp2p_now())
       and case when t.direction = 'BUY_USDT'
                then t.lifecycle_state = 'AWAITING_FIRST_LEG' and inrp2p_counterparty_delivered(o.id)
                     and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'CLIENT_TO_EXCHANGE')
                else t.lifecycle_state in ('FIRST_LEG_CONFIRMED', 'SETTLING')
                     and exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'CLIENT_TO_EXCHANGE' and l.status = 'COMPLETED')
                     and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status in ('PENDING', 'PROCESSING', 'COMPLETED'))
                     and not exists (select 1 from p2p_unwind u where u.trade_id = t.id) end
     order by t.opened_at limit ${limit}`.execute(db);
  for (const p of paying.rows) {
    const out = await once(p.trade_id, 'escrow.pay_window', async (ctx): Promise<'NONE' | 'WARNED' | 'CANCELLED' | 'UNWOUND'> => {
      const trade = await lockTrade(ctx.tx, p.trade_id);
      // Looked at again under the lock: the buyer may have just said it paid.
      const s = await p2pPayState(ctx.tx, trade.id);
      if (!s || !isPaying(s) || s.hold || s.everFiled) return 'NONE';
      const now = await dealNow(ctx.tx);
      const w = await openPayWindowInTx(ctx, s);
      if (!w || now < w.dueAt) return 'NONE';
      if (!w.warnedAt) {
        const after = await warnPayWindowInTx(ctx, w, now);
        await tellBothSides(ctx, 'pay_final_call', { tradeId: s.tradeId, clientId: s.clientId, payer: s.buy ? 'CLIENT' : 'TRADER', finalUntil: after.finalUntil.toISOString(), method: after.method });
        return 'WARNED';
      }
      if (now < w.finalUntil) return 'NONE';
      if (s.buy) {
        await cancelTradeInTx(ctx, { trade, reason: 'not paid within the payment window — the trader’s USDT goes back to it', expiredUnpaid: true });
        return 'CANCELLED';
      }
      return (await startP2pUnwindInTx(ctx, { tradeId: trade.id, reason: 'PAY_WINDOW_MISSED' })) ? 'UNWOUND' : 'NONE';
    });
    if (out === 'WARNED') warned += 1;
    else if (out === 'CANCELLED') cancelled += 1;
    else if (out === 'UNWOUND') unwound += 1;
  }

  // Payments said to be sent that their payee has not answered in their rail's time.
  const unanswered = await sql<{ trade_id: string; leg_id: string; payee: string; rail: string | null; minutes: number }>`
    select l.trade_id, l.id as leg_id, case when l.side = 'CLIENT_TO_EXCHANGE' then 'TRADER' else 'CLIENT' end as payee, f.rail, x.minutes
      from settlement_leg l
      join trade_economics e on e.trade_id = l.trade_id
      left join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null and a.fiat_transfer_id is not null
      left join fiat_transfer f on f.id = a.fiat_transfer_id
      left join p2p_pay_window w on w.trade_id = l.trade_id
      cross join lateral (select coalesce((coalesce(w.timing, (select p2p_timing from trader_program where id = 1))->'receipt'->>coalesce(f.rail, 'IMPS'))::integer, 30) as minutes) x
     where e.route_execution_mode = 'P2P' and l.asset = 'INR' and l.status = 'PROCESSING'
       and (l.side = 'CLIENT_TO_EXCHANGE' or (l.side = 'EXCHANGE_TO_CLIENT' and l.payer = 'ROUTE'))
       and l.created_at + make_interval(mins => x.minutes) < inrp2p_now()
       and not exists (select 1 from exception_case c where c.type = 'P2P_RECEIPT_OVERDUE' and c.subject_id = l.id and c.status in ('OPEN', 'IN_PROGRESS'))
       -- A payment its payee disputed is INRP2P's already.
       and not exists (select 1 from p2p_dispute d where d.settlement_leg_id = l.id)
     order by l.created_at limit ${limit}`.execute(db);
  for (const r of unanswered.rows) {
    if (await once(r.trade_id, 'escrow.receipt_overdue', async (ctx) => {
      const trade = await lockTrade(ctx.tx, r.trade_id);
      const before = await ctx.tx.selectFrom('exception_case').select('id').where('type', '=', 'P2P_RECEIPT_OVERDUE').where('subject_id', '=', r.leg_id).executeTakeFirst();
      const opened = await openExceptionInTx(ctx, { type: 'P2P_RECEIPT_OVERDUE', subjectType: 'SETTLEMENT_LEG', subjectId: r.leg_id, tradeId: r.trade_id, details: { payee: r.payee, rail: r.rail, windowMinutes: r.minutes } });
      // Both sides hear, once, that INRP2P is checking — and that nothing is cancelled for a bank's delay.
      if (opened.opened && !before) await tellBothSides(ctx, 'receipt_late', { tradeId: trade.id, clientId: trade.client_id, payee: r.payee, rail: r.rail });
      return opened.opened;
    })) cases += 1;
  }
  return { cancelled, unwound, warned, cases, failures };
}

/**
 * Minutes past the escrow deadline before a deal is undone for want of the seller's USDT: a transfer sent in the last
 * minute must have time to be seen by the deposit scanner.
 */
export const ESCROW_SEEN_GRACE_MINUTES = 5;

/** A transfer into the deal's escrow the chain already shows, final or not: the client's deposit, or the trader's delivery. */
async function escrowTransferSeen(ex: Executor, tradeId: string, buy: boolean): Promise<boolean> {
  if (!buy) return (await ex.selectFrom('settlement_leg').select('id').where('trade_id', '=', tradeId).where('side', '=', 'CLIENT_TO_EXCHANGE').executeTakeFirst()) !== undefined;
  const r = await sql<{ id: string }>`
    select s.id from route_settlement s join route_obligation o on o.id = s.route_obligation_id
     where o.trade_id = ${tradeId} and s.obligation_side = 'ROUTE_DELIVERS' and s.status in ('RECORDED', 'CONFIRMED') limit 1`.execute(ex);
  return r.rows.length > 0;
}

export type P2pStep = 'ESCROW' | 'PAY' | 'CONFIRM' | 'RELEASE' | 'REFUND' | 'DONE' | 'CANCELLED';

/** The account the rupees go to, as the one who pays them needs it: every field it types into its bank's app. */
export interface P2pPayee {
  readonly holderName: string;
  readonly bankName: string;
  readonly ifsc: string;
  readonly accountNumber: string;
  readonly last4: string;
  readonly rails: readonly string[];
  /** The account's own UPI address (`<account>@<ifsc>.ifsc.npci`): a UPI payment to it lands in exactly this account. */
  readonly upiId: string;
  /** The `upi://pay` link with the exact amount — a QR code on a computer, a tap on a phone; null above UPI's limit. */
  readonly upiLink: string | null;
  /** What to put in the payment's remarks, so the payee recognises it on its statement. */
  readonly remarks: string;
  /** The IFSC has RBI's shape (four letters, 0, six characters). */
  readonly ifscValid: boolean;
}

/** One way to pay, as the buyer chooses it: its time, whether the amount allows it, and whether its time is still open. */
export interface P2pPayMethod {
  readonly rail: InrRail;
  readonly minutes: number;
  readonly possible: boolean;
  readonly limit: string | null;
  /** When this method's time from the escrow ends. */
  readonly dueAt: string;
  /** Its time is not over yet, so it can still be chosen. */
  readonly open: boolean;
}

/** The buyer's time to pay (ADR 0023): its method and deadline, then the final period, and the methods it could choose. */
export interface P2pPayWindowView {
  readonly method: InrRail;
  /** The buyer chose it; otherwise it is the one the amount suggests. */
  readonly chosen: boolean;
  readonly dueAt: string;
  readonly finalUntil: string;
  /** The method's time is up: only the final period is left. */
  readonly final: boolean;
  readonly changesLeft: number;
  readonly methods: readonly P2pPayMethod[];
}

/**
 * A P2P deal as either side's screen shows it (ADR 0019): which step it is at, whose move that is and until when, the
 * rupee amount, and — for the one who pays, while it is to pay, and to nobody else — the other side's account. Keys stay
 * neutral (no route, client, margin or obligation) so both the client's and the trader's projection fuses accept it.
 */
export interface P2pDeal {
  readonly step: P2pStep;
  /** Whose move it is: the side that pays or confirms now. Null when nobody has to act. */
  readonly turn: 'BUYER' | 'SELLER' | 'INRP2P' | null;
  /** When the current step's time runs out; null when no step is timed. */
  readonly dueBy: string | null;
  readonly inr: string;
  readonly escrowFunded: boolean;
  readonly payTo: P2pPayee | null;
  readonly payments: Awaited<ReturnType<typeof p2pPayments>>;
  /** A cancelled deal whose seller's USDT goes back from the escrow: where that stands. */
  readonly escrowReturn: { readonly status: 'PENDING' | 'SENT'; readonly amount: string } | null;
  /** The seller said the buyer's rupees did not arrive (block 9): INRP2P decides. The latest of the deal's disputes. */
  readonly dispute: P2pDisputeView | null;
  /**
   * A client's SELL its trader did not pay — in time, or at all: the client's USDT goes back (step REFUND, then
   * CANCELLED). WAITING until its return is under way, SENDING while it is, SENT once it is back.
   */
  readonly unwind: { readonly reason: 'PAY_WINDOW_MISSED' | 'NOT_PAID'; readonly status: 'WAITING' | 'SENDING' | 'SENT'; readonly amount: string } | null;
  /** Step PAY: the buyer's window — both sides see how the buyer pays and until when. */
  readonly payWindow: P2pPayWindowView | null;
  /** Step CONFIRM: the payee's time for this rail is over — INRP2P is checking; nothing is cancelled for it. */
  readonly receiptLate: boolean;
  /** The deal's private chat (ADR 0023). */
  readonly chat: DealChatView;
  /** The server's clock when this was read: what a countdown counts from. */
  readonly now: string;
}

export const P2P_DISPUTE_REASONS = ['NO_CREDIT', 'WRONG_AMOUNT', 'OTHER'] as const;
export type P2pDisputeReason = (typeof P2P_DISPUTE_REASONS)[number];

/** A dispute as either side sees it: never the other side's words — those are INRP2P's to read. */
export interface P2pDisputeView {
  readonly ref: string;
  readonly reason: P2pDisputeReason;
  readonly status: 'OPEN' | 'PAID' | 'NOT_PAID';
  readonly openedAt: string;
  readonly decidedAt: string | null;
  /** What the viewer itself told INRP2P. */
  readonly yourNote: string | null;
  /** The buyer added its side for INRP2P. */
  readonly buyerAnswered: boolean;
}

/**
 * Who pays rupees on a P2P deal is the buyer of USDT: the client buying, or the trader buying a client's USDT. The
 * payee's account is opened only for that viewer, only at the PAY step.
 */
export async function p2pDeal(ex: Executor, protector: { open(value: string, context: string): Promise<string> } | null, input: { readonly tradeId: string; readonly viewer: 'CLIENT' | 'TRADER' }): Promise<P2pDeal | null> {
  const t = await ex
    .selectFrom('trade as t')
    .innerJoin('trade_economics as e', 'e.trade_id', 't.id')
    .innerJoin('route_obligation as o', 'o.trade_id', 't.id')
    .innerJoin('liquidity_route as r', 'r.id', 'o.route_id')
    .select(['t.id', 't.ref', 't.direction', 't.lifecycle_state', 't.opened_at', 'e.route_execution_mode', 'e.quote_inr_minor', 'o.id as obligation_id', 'r.trader_id'])
    .where('t.id', '=', requireUuid(input.tradeId, 'tradeId'))
    .executeTakeFirst();
  if (!t || t.route_execution_mode !== 'P2P') return null;
  const buy = t.direction === 'BUY_USDT';
  const legs = await ex.selectFrom('settlement_leg').select(['ref', 'side', 'payer', 'status', 'asset', 'created_at', 'confirmed_at']).where('trade_id', '=', t.id).orderBy('created_at').execute();
  const rupeeLeg = legs.filter((l) => l.asset === 'INR' && (buy ? l.side === 'CLIENT_TO_EXCHANGE' : l.side === 'EXCHANGE_TO_CLIENT' && l.payer === 'ROUTE') && l.status !== 'FAILED' && l.status !== 'CANCELLED').at(-1);
  const funded = buy
    ? (await sql<{ d: boolean; at: Date | null }>`
        select inrp2p_counterparty_delivered(${t.obligation_id}::uuid) as d,
               (select max(confirmed_at) from route_settlement where route_obligation_id = ${t.obligation_id} and flow = 'FROM_ROUTE_TO_EXCHANGE' and status = 'CONFIRMED') as at`.execute(ex)).rows[0]!
    : (() => {
        const l = legs.find((x) => x.side === 'CLIENT_TO_EXCHANGE' && x.status === 'COMPLETED');
        return { d: l !== undefined, at: l?.confirmed_at ?? null };
      })();
  const plus = (d: Date | null, minutes: number) => (d ? new Date(d.getTime() + minutes * 60_000).toISOString() : null);
  const now = await dealNow(ex);
  const timing = await programP2pTiming(ex);
  const payments = await p2pPayments(ex, t.id);

  let step: P2pStep;
  let dueBy: string | null = null;
  let window: PayWindow | null = null;
  let receiptLate = false;
  if (t.lifecycle_state === 'CANCELLED') step = 'CANCELLED';
  else if (t.lifecycle_state === 'COMPLETED') step = 'DONE';
  else if (!funded.d) {
    // The seller's time to fund the escrow: the trader's USDT of a BUY, the client's own of a SELL.
    step = 'ESCROW';
    dueBy = plus(t.opened_at, timing.escrowMinutes);
  } else if (!rupeeLeg) {
    step = 'PAY';
    // The window the deadlines opened — or, in the minute before they run, the one they will open.
    const state = await p2pPayState(ex, t.id);
    window = (await payWindowOf(ex, t.id)) ?? (state ? prospectiveWindow(state, timing) : null);
    // A deal whose rupees were once said to be sent (and then not counted) waits for a person, never for a clock.
    if (window && !state?.everFiled) dueBy = (now < window.dueAt ? window.dueAt : window.finalUntil).toISOString();
  } else if (rupeeLeg.status === 'PROCESSING' || rupeeLeg.status === 'PENDING') {
    step = 'CONFIRM';
    const rail = (payments.find((p) => p.ref === rupeeLeg.ref)?.rail ?? 'IMPS') as InrRail;
    const minutes = ((await payWindowOf(ex, t.id))?.timing ?? timing).receipt[rail];
    dueBy = plus(rupeeLeg.created_at, minutes);
    receiptLate = dueBy !== null && Date.parse(dueBy) <= now.getTime();
  } else step = 'RELEASE';
  const disputeRow = await ex.selectFrom('p2p_dispute').select(['ref', 'reason', 'status', 'created_at', 'decided_at', 'payee_note', 'payer_note']).where('trade_id', '=', t.id).orderBy('created_at', 'desc').executeTakeFirst();
  const unwindRow = buy ? undefined : await unwindOf(ex, t.id);
  if (unwindRow && step !== 'CANCELLED' && step !== 'DONE') {
    step = 'REFUND';
    dueBy = null;
  }
  // The buyer pays, the seller funds the escrow and confirms the rupees; INRP2P releases, refunds, and decides disputes.
  const disputed = disputeRow?.status === 'OPEN';
  if (disputed) {
    dueBy = null;
    receiptLate = false;
  }
  // Late is INRP2P's to check: the payee can still answer, but no clock runs on it any more.
  if (receiptLate) dueBy = null;
  const turn = disputed || step === 'RELEASE' || step === 'REFUND' ? 'INRP2P' : step === 'ESCROW' || step === 'CONFIRM' ? 'SELLER' : step === 'PAY' ? 'BUYER' : null;

  // The viewer that pays is the buyer: the client on a BUY, the trader on a SELL.
  const viewerPays = (input.viewer === 'CLIENT') === buy;
  let payTo: P2pPayee | null = null;
  if (step === 'PAY' && viewerPays && protector) {
    const accountId = buy
      ? (await ex.selectFrom('trader_profile').select('bank_account_id').where('id', '=', t.trader_id!).executeTakeFirstOrThrow()).bank_account_id
      : (await sql<{ bank_account_id: string | null }>`select bank_account_id from inrp2p_trade_payout_destination(${t.id}::uuid)`.execute(ex)).rows[0]?.bank_account_id ?? null;
    if (accountId) {
      const b = await ex.selectFrom('bank_account').select(['client_id', 'holder_name', 'bank_name', 'ifsc', 'account_number_enc', 'account_last4', 'rail_preferences', 'status']).where('id', '=', accountId).executeTakeFirstOrThrow();
      if (b.status === 'ACTIVE') {
        const accountNumber = await protector.open(b.account_number_enc, bankAccountSealContext(b.client_id));
        const upiId = accountUpiAddress(accountNumber, b.ifsc);
        // The payee recognises the payment by the reference it knows: the trader its order, the client its trade.
        const remarks = `INRP2P ${buy ? ((await ex.selectFrom('trader_order').select('ref').where('trade_id', '=', t.id).orderBy('offered_at', 'desc').executeTakeFirst())?.ref ?? t.ref) : t.ref}`;
        const upiPossible = railOptions(t.quote_inr_minor).some((o) => o.rail === 'UPI' && o.possible);
        payTo = {
          holderName: b.holder_name, bankName: b.bank_name, ifsc: b.ifsc, last4: b.account_last4, rails: b.rail_preferences, accountNumber, upiId, remarks,
          upiLink: upiPossible ? upiPayUri({ vpa: upiId, payeeName: b.holder_name, amount: Money.ofMinor(t.quote_inr_minor, 'INR').toDecimalString(), note: remarks }) : null,
          ifscValid: checkIfsc(b.ifsc).ok,
        };
      }
    }
  }

  let escrowReturn: P2pDeal['escrowReturn'] = null;
  if (step === 'CANCELLED' && buy) {
    const owed = BigInt((await sql<{ n: string }>`select inrp2p_escrow_returnable(${t.obligation_id}::uuid)::text as n`.execute(ex)).rows[0]!.n);
    const sends = await ex.selectFrom('chain_send').select(['status', 'amount_minor']).where('route_obligation_id', '=', t.obligation_id).where('purpose', '=', 'ESCROW_RETURN').where('status', '!=', 'CANCELLED').execute();
    const sent = sends.filter((s) => s.status === 'CONFIRMED').reduce((sum, s) => sum + s.amount_minor, 0n);
    const going = sends.filter((s) => s.status !== 'CONFIRMED').reduce((sum, s) => sum + s.amount_minor, 0n);
    if (owed + going > 0n) escrowReturn = { status: 'PENDING', amount: Money.ofMinor(owed + going, 'USDT').toDecimalString() };
    else if (sent > 0n) escrowReturn = { status: 'SENT', amount: Money.ofMinor(sent, 'USDT').toDecimalString() };
  }

  // The seller is the payee of the rupees: the viewer is the seller when it is the client of a SELL or the trader of a BUY.
  const viewerSells = (input.viewer === 'CLIENT') !== buy;
  const dispute: P2pDisputeView | null = disputeRow
    ? {
        ref: disputeRow.ref, reason: disputeRow.reason, status: disputeRow.status, openedAt: disputeRow.created_at.toISOString(), decidedAt: disputeRow.decided_at?.toISOString() ?? null,
        yourNote: viewerSells ? disputeRow.payee_note : disputeRow.payer_note, buyerAnswered: disputeRow.payer_note !== null,
      }
    : null;

  let unwind: P2pDeal['unwind'] = null;
  if (unwindRow) {
    const refund = unwindRow.refund_leg_id
      ? await ex.selectFrom('settlement_leg').select(['status', 'amount_minor']).where('id', '=', unwindRow.refund_leg_id).executeTakeFirst()
      : undefined;
    const sent = await ex.selectFrom('settlement_leg').select(({ fn }) => fn.sum<string>('amount_minor').as('n')).where('trade_id', '=', t.id).where('side', '=', 'CLIENT_TO_EXCHANGE').where('status', '=', 'COMPLETED').executeTakeFirst();
    unwind = {
      reason: unwindRow.reason,
      status: refund?.status === 'COMPLETED' || t.lifecycle_state === 'CANCELLED' ? 'SENT' : refund?.status === 'PROCESSING' ? 'SENDING' : 'WAITING',
      amount: Money.ofMinor(refund?.amount_minor ?? BigInt(sent?.n ?? '0'), 'USDT').toDecimalString(),
    };
  }

  let payWindow: P2pPayWindowView | null = null;
  if (window && step === 'PAY') {
    const w = window;
    payWindow = {
      method: w.method, chosen: w.chosen, dueAt: w.dueAt.toISOString(), finalUntil: w.finalUntil.toISOString(), final: now >= w.dueAt, changesLeft: Math.max(0, PAY_METHOD_CHANGES - w.changes),
      methods: railOptions(t.quote_inr_minor).map((o) => {
        const due = new Date(w.openedAt.getTime() + w.timing.pay[o.rail] * 60_000);
        return { rail: o.rail, minutes: w.timing.pay[o.rail], possible: o.possible, limit: o.limit, dueAt: due.toISOString(), open: due.getTime() > now.getTime() + 60_000 };
      }),
    };
  }

  return {
    step, turn, dueBy, inr: Money.ofMinor(t.quote_inr_minor, 'INR').toDecimalString(), escrowFunded: funded.d,
    payTo, payments, escrowReturn, dispute, unwind, payWindow, receiptLate,
    chat: await dealChatView(ex, { tradeId: t.id, viewer: input.viewer }), now: now.toISOString(),
  };
}
