import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError, Money, type InrRail, optionalText, requireOneOf, requireText, requireUtrShape, requireUuid } from '@inrp2p/kernel';
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
export async function tellBothSides(ctx: TxContext, what: 'dispute_opened' | 'dispute_decided' | 'unwind_started', payload: { readonly tradeId: string } & Record<string, unknown>): Promise<void> {
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

/** ADR 0019 §2.7: how long each side has for its step, in minutes — the same for every deal, so a screen can count it. */
export const P2P_WINDOW_MINUTES = Object.freeze({ escrow: 30, pay: 30, receipt: 30 });

export interface P2pDeadlinesReport {
  readonly cancelled: number;
  /** SELLs whose trader did not pay in time: the client's USDT goes back. */
  readonly unwound: number;
  readonly cases: number;
  readonly failures: readonly { readonly tradeId: string; readonly message: string }[];
}

/**
 * `p2p_deadlines` (cron, every minute): the time limits of P2P deals (ADR 0019 §2.7), each trade in its own step.
 *
 * - A client buying USDT whose trader did not fund the escrow in time, or who did not pay the funded escrow in time
 *   (and never said it paid), is cancelled exactly as the desk would — and whatever the trader delivered goes back to
 *   it (`planEscrowReturnInTx`, through autopay).
 * - A trader that has not paid a client whose USDT is in escrow loses the deal (TD-35): the client's USDT goes back to it
 *   (`startP2pUnwindInTx`; autopay returns it, then the trade is cancelled) and the trader can no longer pay.
 * - A payee that neither confirmed nor disputed a payment it was told of gives the desk a case (`P2P_RECEIPT_OVERDUE`):
 *   INRP2P decides it from the payee's bank, paid or not paid. A late confirmation still counts.
 *
 * A trade with a payment filed is never cancelled here: that one waits for its payee, or a person.
 */
export async function runP2pDeadlines(db: Db, windows: { readonly escrow: number; readonly pay: number; readonly receipt: number } = P2P_WINDOW_MINUTES, limit = 50): Promise<P2pDeadlinesReport> {
  const failures: { tradeId: string; message: string }[] = [];
  let cancelled = 0;
  let unwound = 0;
  let cases = 0;
  const once = async (tradeId: string, name: string, fn: (ctx: TxContext) => Promise<boolean>) => {
    const key = randomUUID();
    try {
      const out = await executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { tradeId, run: key }, idempotencyKey: key, financial: true });
      return out.result;
    } catch (e) {
      failures.push({ tradeId, message: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const unpaid = await sql<{ trade_id: string; funded: boolean }>`
    select t.id as trade_id, inrp2p_counterparty_delivered(o.id) as funded
      from trade t
      join trade_economics e on e.trade_id = t.id
      join route_obligation o on o.trade_id = t.id
     where e.route_execution_mode = 'P2P' and t.direction = 'BUY_USDT' and t.lifecycle_state = 'AWAITING_FIRST_LEG' and not t.hold
       and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'CLIENT_TO_EXCHANGE')
       and case when inrp2p_counterparty_delivered(o.id)
                then (select max(s.confirmed_at) from route_settlement s where s.route_obligation_id = o.id and s.flow = 'FROM_ROUTE_TO_EXCHANGE' and s.status = 'CONFIRMED')
                       + make_interval(mins => ${windows.pay}) < inrp2p_now()
                else t.opened_at + make_interval(mins => ${windows.escrow}) < inrp2p_now() end
     order by t.opened_at limit ${limit}`.execute(db);
  for (const u of unpaid.rows) {
    const done = await once(u.trade_id, 'trade.expire_unpaid_escrow', async (ctx) => {
      const trade = await lockTrade(ctx.tx, u.trade_id);
      // Looked at again under the lock: the client may have just said it paid.
      const legs = await ctx.tx.selectFrom('settlement_leg').select('id').where('trade_id', '=', trade.id).where('side', '=', 'CLIENT_TO_EXCHANGE').executeTakeFirst();
      if (trade.lifecycle_state !== 'AWAITING_FIRST_LEG' || trade.hold || legs) return false;
      await cancelTradeInTx(ctx, { trade, reason: u.funded ? 'not paid within the payment window — the trader’s USDT goes back to it' : 'the trader did not fund the escrow in time', expiredUnpaid: true });
      return true;
    });
    if (done) cancelled += 1;
  }

  const notPaid = await sql<{ trade_id: string }>`
    select t.id as trade_id
      from trade t
      join trade_economics e on e.trade_id = t.id
     where e.route_execution_mode = 'P2P' and t.direction = 'SELL_USDT' and t.lifecycle_state in ('FIRST_LEG_CONFIRMED', 'SETTLING')
       and (select max(l.confirmed_at) from settlement_leg l where l.trade_id = t.id and l.side = 'CLIENT_TO_EXCHANGE' and l.status = 'COMPLETED')
             + make_interval(mins => ${windows.pay}) < inrp2p_now()
       and not exists (select 1 from settlement_leg l where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status in ('PENDING', 'PROCESSING', 'COMPLETED'))
       and not exists (select 1 from p2p_unwind u where u.trade_id = t.id)
     order by t.opened_at limit ${limit}`.execute(db);
  for (const n of notPaid.rows) {
    if (await once(n.trade_id, 'escrow.payment_overdue', async (ctx) => {
      const trade = await lockTrade(ctx.tx, n.trade_id);
      // Looked at again under the lock: the trader may have just filed its payment.
      const filed = await ctx.tx.selectFrom('settlement_leg').select('id').where('trade_id', '=', trade.id).where('side', '=', 'EXCHANGE_TO_CLIENT').where('status', 'in', ['PENDING', 'PROCESSING', 'COMPLETED']).executeTakeFirst();
      if (filed || trade.lifecycle_state === 'COMPLETED' || trade.lifecycle_state === 'CANCELLED') return false;
      return startP2pUnwindInTx(ctx, { tradeId: trade.id, reason: 'PAY_WINDOW_MISSED' });
    })) unwound += 1;
  }

  const unanswered = await sql<{ trade_id: string; leg_id: string; payee: string }>`
    select l.trade_id, l.id as leg_id, case when l.side = 'CLIENT_TO_EXCHANGE' then 'TRADER' else 'CLIENT' end as payee
      from settlement_leg l
      join trade_economics e on e.trade_id = l.trade_id
     where e.route_execution_mode = 'P2P' and l.asset = 'INR' and l.status = 'PROCESSING'
       and (l.side = 'CLIENT_TO_EXCHANGE' or (l.side = 'EXCHANGE_TO_CLIENT' and l.payer = 'ROUTE'))
       and l.created_at + make_interval(mins => ${windows.receipt}) < inrp2p_now()
       and not exists (select 1 from exception_case c where c.type = 'P2P_RECEIPT_OVERDUE' and c.subject_id = l.id and c.status in ('OPEN', 'IN_PROGRESS'))
       -- A payment its payee disputed is INRP2P's already.
       and not exists (select 1 from p2p_dispute d where d.settlement_leg_id = l.id)
     order by l.created_at limit ${limit}`.execute(db);
  for (const r of unanswered.rows) {
    if (await once(r.trade_id, 'escrow.receipt_overdue', async (ctx) => {
      await lockTrade(ctx.tx, r.trade_id);
      return (await openExceptionInTx(ctx, { type: 'P2P_RECEIPT_OVERDUE', subjectType: 'SETTLEMENT_LEG', subjectId: r.leg_id, tradeId: r.trade_id, details: { payee: r.payee, windowMinutes: windows.receipt } })).opened;
    })) cases += 1;
  }
  return { cancelled, unwound, cases, failures };
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
  const legs = await ex.selectFrom('settlement_leg').select(['side', 'payer', 'status', 'asset', 'created_at', 'confirmed_at']).where('trade_id', '=', t.id).orderBy('created_at').execute();
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

  let step: P2pStep;
  let dueBy: string | null = null;
  if (t.lifecycle_state === 'CANCELLED') step = 'CANCELLED';
  else if (t.lifecycle_state === 'COMPLETED') step = 'DONE';
  else if (!funded.d) {
    step = 'ESCROW';
    dueBy = buy ? plus(t.opened_at, P2P_WINDOW_MINUTES.escrow) : null;
  } else if (!rupeeLeg) {
    step = 'PAY';
    dueBy = plus(funded.at, P2P_WINDOW_MINUTES.pay);
  } else if (rupeeLeg.status === 'PROCESSING' || rupeeLeg.status === 'PENDING') {
    step = 'CONFIRM';
    dueBy = plus(rupeeLeg.created_at, P2P_WINDOW_MINUTES.receipt);
  } else step = 'RELEASE';
  const disputeRow = await ex.selectFrom('p2p_dispute').select(['ref', 'reason', 'status', 'created_at', 'decided_at', 'payee_note', 'payer_note']).where('trade_id', '=', t.id).orderBy('created_at', 'desc').executeTakeFirst();
  const unwindRow = buy ? undefined : await unwindOf(ex, t.id);
  if (unwindRow && step !== 'CANCELLED' && step !== 'DONE') {
    step = 'REFUND';
    dueBy = null;
  }
  // The buyer pays, the seller funds the escrow and confirms the rupees; INRP2P releases, refunds, and decides disputes.
  const disputed = disputeRow?.status === 'OPEN';
  if (disputed) dueBy = null;
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
        payTo = {
          holderName: b.holder_name, bankName: b.bank_name, ifsc: b.ifsc, last4: b.account_last4, rails: b.rail_preferences,
          accountNumber: await protector.open(b.account_number_enc, bankAccountSealContext(b.client_id)),
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

  return {
    step, turn, dueBy, inr: Money.ofMinor(t.quote_inr_minor, 'INR').toDecimalString(), escrowFunded: funded.d,
    payTo, payments: await p2pPayments(ex, t.id), escrowReturn, dispute, unwind,
  };
}
