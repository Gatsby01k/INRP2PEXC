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
 * Locks: the trade first, then the payment's own row through the check (the confirmation re-enters the same order).
 */
export async function confirmP2pReceiptInTx(
  ctx: TxContext,
  deps: SettlementDeps,
  input: { readonly tradeId: string; readonly legId: string; readonly payee: 'CLIENT' | 'TRADER'; readonly senderName: string; readonly senderAccount?: string | null },
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

  const name = requireText(input.senderName, 'senderName', 140);
  const check = await recordSenderCheckInTx(ctx, { transferId: allocation.fiat_transfer_id, via: 'PAYEE', seen: { name, account: optionalText(input.senderAccount, 'senderAccount', 80) }, locked: true });
  await appendAudit(ctx, { action: 'p2p.receipt_checked', entityType: 'settlement_leg', entityId: leg.id, after: { payee: input.payee, verdict: check.verdict } });
  if (check.verdict !== 'MATCH') return { verdict: check.verdict, confirmed: false, exceptionId: check.exceptionId };

  if (input.payee === 'CLIENT') await confirmPayoutLegInTx(ctx, deps, leg.id);
  else await confirmClientLegInTx(ctx, deps, leg.id);
  await closeCases(ctx, 'P2P_RECEIPT_OVERDUE', 'SETTLEMENT_LEG', leg.id, `the ${input.payee === 'CLIENT' ? 'client' : 'trader'} confirmed it received the payment`);
  return { verdict: 'MATCH', confirmed: true, exceptionId: null };
}

/** A late answer still counts: the case that waited for it is closed by it. */
async function closeCases(ctx: TxContext, type: ExceptionType, subjectType: 'TRADE' | 'SETTLEMENT_LEG', subjectId: string, notes: string): Promise<void> {
  const open = await ctx.tx.selectFrom('exception_case').select('id').where('type', '=', type).where('subject_type', '=', subjectType).where('subject_id', '=', subjectId)
    .where('status', 'in', ['OPEN', 'IN_PROGRESS']).execute();
  for (const c of open) await resolveExceptionInTx(ctx, { exceptionId: c.id, resolution: 'confirm', notes });
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
  readonly cases: number;
  readonly failures: readonly { readonly tradeId: string; readonly message: string }[];
}

/**
 * `p2p_deadlines` (cron, every minute): the time limits of P2P deals (ADR 0019 §2.7), each trade in its own step.
 *
 * - A client buying USDT whose trader did not fund the escrow in time, or who did not pay the funded escrow in time
 *   (and never said it paid), is cancelled exactly as the desk would — and whatever the trader delivered goes back to
 *   it (`planEscrowReturnInTx`, through autopay).
 * - A trader that has not paid a client whose USDT is in escrow gives the desk a case (`P2P_PAYMENT_OVERDUE`): the
 *   desk refunds the client or chases the trader.
 * - A payee that neither confirmed nor disputed a payment it was told of gives the desk a case (`P2P_RECEIPT_OVERDUE`):
 *   the desk confirms it with the bank's evidence, or marks it not received. A late confirmation still counts.
 *
 * A trade with a payment filed is never cancelled here: that one waits for its payee, or a person.
 */
export async function runP2pDeadlines(db: Db, windows: { readonly escrow: number; readonly pay: number; readonly receipt: number } = P2P_WINDOW_MINUTES, limit = 50): Promise<P2pDeadlinesReport> {
  const failures: { tradeId: string; message: string }[] = [];
  let cancelled = 0;
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
       and not exists (select 1 from exception_case c where c.type = 'P2P_PAYMENT_OVERDUE' and c.subject_id = t.id and c.status in ('OPEN', 'IN_PROGRESS'))
     order by t.opened_at limit ${limit}`.execute(db);
  for (const n of notPaid.rows) {
    if (await once(n.trade_id, 'escrow.payment_overdue', async (ctx) => {
      await lockTrade(ctx.tx, n.trade_id);
      return (await openExceptionInTx(ctx, { type: 'P2P_PAYMENT_OVERDUE', subjectType: 'TRADE', subjectId: n.trade_id, tradeId: n.trade_id, details: { windowMinutes: windows.pay } })).opened;
    })) cases += 1;
  }

  const unanswered = await sql<{ trade_id: string; leg_id: string; payee: string }>`
    select l.trade_id, l.id as leg_id, case when l.side = 'CLIENT_TO_EXCHANGE' then 'TRADER' else 'CLIENT' end as payee
      from settlement_leg l
      join trade_economics e on e.trade_id = l.trade_id
     where e.route_execution_mode = 'P2P' and l.asset = 'INR' and l.status = 'PROCESSING'
       and (l.side = 'CLIENT_TO_EXCHANGE' or (l.side = 'EXCHANGE_TO_CLIENT' and l.payer = 'ROUTE'))
       and l.created_at + make_interval(mins => ${windows.receipt}) < inrp2p_now()
       and not exists (select 1 from exception_case c where c.type = 'P2P_RECEIPT_OVERDUE' and c.subject_id = l.id and c.status in ('OPEN', 'IN_PROGRESS'))
     order by l.created_at limit ${limit}`.execute(db);
  for (const r of unanswered.rows) {
    if (await once(r.trade_id, 'escrow.receipt_overdue', async (ctx) => {
      await lockTrade(ctx.tx, r.trade_id);
      return (await openExceptionInTx(ctx, { type: 'P2P_RECEIPT_OVERDUE', subjectType: 'SETTLEMENT_LEG', subjectId: r.leg_id, tradeId: r.trade_id, details: { payee: r.payee, windowMinutes: windows.receipt } })).opened;
    })) cases += 1;
  }
  return { cancelled, cases, failures };
}

export type P2pStep = 'ESCROW' | 'PAY' | 'CONFIRM' | 'RELEASE' | 'DONE' | 'CANCELLED';

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
  // The buyer pays, the seller funds the escrow and confirms the rupees; INRP2P releases.
  const turn = step === 'ESCROW' || step === 'CONFIRM' ? 'SELLER' : step === 'PAY' ? 'BUYER' : step === 'RELEASE' ? 'INRP2P' : null;

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

  return {
    step, turn, dueBy, inr: Money.ofMinor(t.quote_inr_minor, 'INR').toDecimalString(), escrowFunded: funded.d,
    payTo, payments: await p2pPayments(ex, t.id), escrowReturn,
  };
}
