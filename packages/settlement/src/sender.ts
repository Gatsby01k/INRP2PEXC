import { sql } from 'kysely';
import { DomainError, type NameMatchPair, judgeSender, normalizeVpa, optionalText, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor, SenderVerdict, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type DomainCommand, type OperatorActor, type Permission, authorizeOperator } from '@inrp2p/identity';
import { lockTrade } from '@inrp2p/trades';
import { openExceptionInTx } from './exceptions.ts';
import { lockMovement } from './movements.ts';

/**
 * Who sent the rupees (ADR 0018, FI-96). A client's INR — and a trader's INR into the exchange — count only when they
 * came from the payer's own registered account: the bank statement or a person looking at the account says who the
 * remitter was, that is judged word by word against the account the payment was declared from, and the database
 * refuses to confirm the payment until the verdict is MATCH, or a person accepted a partial match (IX116, IX119).
 *
 * A stranger's rupees are never kept: the verdict MISMATCH opens `INR_UNEXPECTED_SENDER`, which holds the trade until
 * the money goes back where it came from.
 */

export interface ExpectedAccount {
  readonly bankAccountId: string;
  readonly holderName: string;
  readonly bankName: string;
  readonly last4: string;
}

export interface SeenSender {
  readonly name: string | null;
  /** The sending account's digits, or a UPI ID, as the bank shows it. */
  readonly account: string | null;
}

interface TransferForCheck {
  readonly id: string;
  readonly status: 'RECORDED' | 'CONFIRMED' | 'FAILED';
  readonly payerType: string;
  readonly payerId: string;
  readonly payeeType: string;
  readonly declared: string | null;
}

async function transferForCheck(ex: Executor, transferId: string): Promise<TransferForCheck & { readonly needsCheck: boolean }> {
  const row = await sql<{ id: string; status: 'RECORDED' | 'CONFIRMED' | 'FAILED'; payer_type: string; payer_id: string; payee_type: string; payer_bank_account_id: string | null; needs: boolean }>`
    select f.id, f.status, f.payer_type, f.payer_id, f.payee_type, f.payer_bank_account_id, inrp2p_fiat_needs_sender_check(f) as needs
    from fiat_transfer f where f.id = ${requireUuid(transferId, 'transferId')}`.execute(ex);
  const f = row.rows[0];
  if (!f) throw new DomainError('NOT_FOUND', 'payment not found');
  return { id: f.id, status: f.status, payerType: f.payer_type, payerId: f.payer_id, payeeType: f.payee_type, declared: f.payer_bank_account_id, needsCheck: f.needs };
}

/**
 * The accounts the rupees may have come from: the one the payment was declared from, or — when nobody declared one —
 * every active account the payer registered (a client's own; a trader's, through its route).
 */
export async function expectedAccounts(ex: Executor, t: Pick<TransferForCheck, 'payerType' | 'payerId' | 'declared'>): Promise<readonly ExpectedAccount[]> {
  let q = ex.selectFrom('bank_account as b').select(['b.id', 'b.holder_name', 'b.bank_name', 'b.account_last4']);
  if (t.declared) q = q.where('b.id', '=', t.declared);
  else if (t.payerType === 'CLIENT') q = q.where('b.client_id', '=', t.payerId).where('b.status', '=', 'ACTIVE');
  else if (t.payerType === 'ROUTE') {
    q = q
      .where('b.status', '=', 'ACTIVE')
      .where('b.client_id', '=', (eb) => eb.selectFrom('liquidity_route as r').innerJoin('trader_profile as tp', 'tp.id', 'r.trader_id').select('tp.client_id').where('r.id', '=', t.payerId));
  } else return [];
  const rows = await q.orderBy('b.created_at').execute();
  return rows.map((r) => ({ bankAccountId: r.id, holderName: r.holder_name, bankName: r.bank_name, last4: r.account_last4 }));
}

const RANK: Record<string, number> = { MATCH: 3, PARTIAL: 2, UNKNOWN: 1, MISMATCH: 0 };

export interface SenderJudgement {
  readonly verdict: 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN';
  readonly account: ExpectedAccount | null;
  readonly pairs: readonly NameMatchPair[];
  readonly accountSeen: 'SAME' | 'DIFFERENT' | 'NOT_SHOWN';
}

/** The best verdict any of the payer's accounts earns: the rupees are the payer's own if any of their accounts sent them. */
export function judgeAgainst(accounts: readonly ExpectedAccount[], seen: SeenSender): SenderJudgement {
  const digits = seen.account && !normalizeVpa(seen.account) ? seen.account : null;
  let best: SenderJudgement = { verdict: seen.name || digits ? 'MISMATCH' : 'UNKNOWN', account: null, pairs: [], accountSeen: 'NOT_SHOWN' };
  for (const a of accounts) {
    const j = judgeSender({ holderName: a.holderName, last4: a.last4 }, { name: seen.name, accountDigits: digits });
    if (best.account === null || RANK[j.verdict]! > RANK[best.verdict]!) best = { verdict: j.verdict, account: a, pairs: j.pairs, accountSeen: j.account };
  }
  return best;
}

/**
 * One check of a payment's sender, as evidence (`fiat_sender_check`). A stranger's rupees open `INR_UNEXPECTED_SENDER`
 * on the trade at once — confirmed already or not — and the client is told the payment will be returned.
 */
export async function recordSenderCheckInTx(
  ctx: TxContext,
  input: {
    readonly transferId: string; readonly via: 'STATEMENT' | 'DESK' | 'PAYEE'; readonly seen: SeenSender; readonly statementLineId?: string | null; readonly narration?: string | null;
    /** The caller already holds the trade and the payment in the global lock order (the statement import, a claim). */
    readonly locked?: boolean;
  },
): Promise<{ readonly verdict: SenderVerdict; readonly checkId: string; readonly exceptionId: string | null }> {
  const tradeId = await tradeOfTransfer(ctx.tx, requireUuid(input.transferId, 'transferId'));
  if (!input.locked) {
    // Trade before payment (ARCHITECTURE §4): a stranger's rupees put the trade on hold in this same transaction.
    if (tradeId) await lockTrade(ctx.tx, tradeId);
    await lockMovement(ctx, 'FIAT', input.transferId);
  }
  const t = await transferForCheck(ctx.tx, input.transferId);
  if (!t.needsCheck) throw new DomainError('INVALID_ARGUMENT', 'this payment is not one whose sender is checked');
  if (input.via !== 'STATEMENT' && t.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payment is ${t.status.toLowerCase()}; its sender is no longer decided by hand`);
  const seen: SeenSender = { name: optionalText(input.seen.name, 'senderName', 140), account: optionalText(input.seen.account, 'senderAccount', 80) };
  const judged = judgeAgainst(await expectedAccounts(ctx.tx, t), seen);
  const row = await ctx.tx
    .insertInto('fiat_sender_check')
    .values({
      fiat_transfer_id: t.id,
      via: input.via,
      seen_name: seen.name,
      seen_account: seen.account,
      expected_bank_account_id: judged.account?.bankAccountId ?? null,
      verdict: judged.verdict,
      detail: JSON.stringify({ pairs: judged.pairs, account: judged.accountSeen, narration: input.narration ?? null }),
      statement_line_id: input.statementLineId ?? null,
      checked_by: ctx.actor.id ?? `SYSTEM:${ctx.commandName}`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await appendAudit(ctx, {
    action: 'fiat.sender_checked', entityType: 'fiat_transfer', entityId: t.id,
    after: { via: input.via, verdict: judged.verdict, seen_name: seen.name, seen_account: seen.account, expected_bank_account_id: judged.account?.bankAccountId ?? null, account: judged.accountSeen },
  });
  let exceptionId: string | null = null;
  if (judged.verdict === 'MISMATCH') {
    const opened = await openExceptionInTx(ctx, {
      type: 'INR_UNEXPECTED_SENDER', subjectType: 'FIAT_TRANSFER', subjectId: t.id, tradeId,
      details: { seen_name: seen.name, seen_account: seen.account, via: input.via, confirmed_already: t.status === 'CONFIRMED', payer: t.payerType },
    });
    exceptionId = opened.exceptionId;
    if (opened.opened && tradeId && t.payerType === 'CLIENT') {
      await enqueueOutbox(ctx, { type: 'client.payment_third_party', aggregateType: 'trade', aggregateId: tradeId, payload: { tradeId, clientId: t.payerId, transferId: t.id } });
    }
  }
  return { verdict: judged.verdict, checkId: row.id, exceptionId };
}

/** The trade a payment belongs to: through the client's leg it pays, or the route settlement it records. */
export async function tradeOfTransfer(ex: Executor, transferId: string): Promise<string | null> {
  const viaLeg = await ex
    .selectFrom('transfer_allocation as a')
    .innerJoin('settlement_leg as l', 'l.id', 'a.settlement_leg_id')
    .select('l.trade_id')
    .where('a.fiat_transfer_id', '=', transferId)
    .executeTakeFirst();
  if (viaLeg) return viaLeg.trade_id;
  const viaRoute = await ex
    .selectFrom('route_settlement as s')
    .innerJoin('route_obligation as o', 'o.id', 's.route_obligation_id')
    .select('o.trade_id')
    .where('s.fiat_transfer_id', '=', transferId)
    .executeTakeFirst();
  return viaRoute?.trade_id ?? null;
}

/** The verdict that counts now (the latest check; a statement that once showed someone else is never outvoted). */
export async function senderVerdict(ex: Executor, transferId: string): Promise<SenderVerdict | 'NOT_CHECKED'> {
  const r = await sql<{ v: SenderVerdict | 'NOT_CHECKED' }>`select inrp2p_fiat_sender_verdict(${transferId}::uuid) as v`.execute(ex);
  return r.rows[0]!.v;
}

/**
 * The refusal the confirmation commands give before the database's own (IX116): rupees from a client or a trader's
 * route count only once someone has seen they are the payer's own.
 */
export async function assertSenderVerified(ex: Executor, transferId: string): Promise<void> {
  const t = await transferForCheck(ex, transferId);
  if (!t.needsCheck) return;
  const verdict = await senderVerdict(ex, transferId);
  if (verdict === 'MATCH' || verdict === 'ACCEPTED') return;
  const why: Record<string, string> = {
    NOT_CHECKED: 'nobody has checked who sent it yet — check the sender on the credit first',
    UNKNOWN: 'the credit showed no sender name — check the sender in the bank first',
    PARTIAL: 'the sender only partly matches the account — check it, or accept it as the payer’s own with the reason',
    MISMATCH: 'it came from someone other than the payer — it is returned, never counted',
  };
  throw new DomainError('INR_SENDER_NOT_VERIFIED', `this payment cannot count yet: ${why[verdict] ?? verdict}`, { verdict });
}

/**
 * The person who checks a payment's sender is the one who would confirm it: a client's rupees are the settlement
 * desk's (`settlement:record_incoming` to check, `settlement:confirm_incoming` ⧗ to accept), a trader's are finance's
 * (`route_settlement:record`, `route_settlement:confirm` ⧗).
 */
function senderCommand<P extends { transferId: string }, R>(actor: OperatorActor, step: 'check' | 'accept', handle: (ctx: TxContext, p: P) => Promise<R>): DomainCommand<P, R> {
  let authorized = false;
  return {
    authorize: async (ctx, p) => {
      const t = await ctx.tx.selectFrom('fiat_transfer').select('payer_type').where('id', '=', requireUuid(p.transferId, 'transferId')).executeTakeFirst();
      if (!t) throw new DomainError('NOT_FOUND', 'payment not found');
      const route = t.payer_type === 'ROUTE';
      const permission: Permission = step === 'check' ? (route ? 'route_settlement:record' : 'settlement:record_incoming') : route ? 'route_settlement:confirm' : 'settlement:confirm_incoming';
      await authorizeOperator(ctx.tx, actor, permission);
      authorized = true;
    },
    handle: async (ctx, p) => {
      if (!authorized) throw new Error('sender command executed without authorization');
      return handle(ctx, p);
    },
  };
}

/**
 * `fiat_in.check_sender`. What the desk sees on the credit in the bank: the remitter's name and, where shown, the
 * sending account or UPI ID. Judged against the declared account at once.
 */
export function checkIncomingSender(actor: OperatorActor) {
  return senderCommand(actor, 'check', async (ctx, p: { transferId: string; senderName: string; senderAccount?: string | null }) => {
    const name = requireText(p.senderName, 'senderName', 140);
    const out = await recordSenderCheckInTx(ctx, { transferId: p.transferId, via: 'DESK', seen: { name, account: p.senderAccount ?? null } });
    return { verdict: out.verdict, exceptionId: out.exceptionId };
  });
}

/**
 * `fiat_in.accept_sender` — `settlement:confirm_incoming` or `route_settlement:confirm` (⧗). A person accepts a partial match as the payer's own —
 * the account's digits matched on the bank's own screen, say — with the reason. Never a stranger (IX119).
 */
export function acceptIncomingSender(actor: OperatorActor) {
  return senderCommand(actor, 'accept', async (ctx, p: { transferId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const tradeId = await tradeOfTransfer(ctx.tx, requireUuid(p.transferId, 'transferId'));
    if (tradeId) await lockTrade(ctx.tx, tradeId);
    await lockMovement(ctx, 'FIAT', p.transferId);
    const t = await transferForCheck(ctx.tx, p.transferId);
    if (!t.needsCheck) throw new DomainError('INVALID_ARGUMENT', 'this payment is not one whose sender is checked');
    if (t.status !== 'RECORDED') throw new DomainError('INVALID_TRANSITION', `the payment is ${t.status.toLowerCase()}`);
    const verdict = await senderVerdict(ctx.tx, t.id);
    if (verdict !== 'PARTIAL') throw new DomainError('INVALID_TRANSITION', verdict === 'MISMATCH' ? 'a payment from someone else is returned, never accepted' : `only a partial match can be accepted (it is ${verdict.toLowerCase().replace('_', ' ')})`);
    const last = await ctx.tx.selectFrom('fiat_sender_check').select(['expected_bank_account_id']).where('fiat_transfer_id', '=', t.id).orderBy('checked_at', 'desc').orderBy('id', 'desc').executeTakeFirstOrThrow();
    await ctx.tx
      .insertInto('fiat_sender_check')
      .values({ fiat_transfer_id: t.id, via: 'DESK', verdict: 'ACCEPTED', expected_bank_account_id: last.expected_bank_account_id, reason, checked_by: ctx.actor.id ?? 'SYSTEM' })
      .execute();
    await appendAudit(ctx, { action: 'fiat.sender_accepted', entityType: 'fiat_transfer', entityId: t.id, before: { verdict }, after: { verdict: 'ACCEPTED', reason } });
    return { verdict: 'ACCEPTED' as const };
  });
}

export interface SenderView {
  readonly verdict: SenderVerdict | 'NOT_CHECKED';
  readonly declared: ExpectedAccount | null;
  readonly checks: readonly {
    readonly via: 'STATEMENT' | 'DESK' | 'PAYEE';
    readonly verdict: SenderVerdict;
    readonly seenName: string | null;
    readonly seenAccount: string | null;
    readonly pairs: readonly NameMatchPair[];
    readonly account: string | null;
    readonly narration: string | null;
    readonly reason: string | null;
    readonly checkedBy: string;
    readonly checkedAt: string;
  }[];
}

/** Everything the desk shows about who sent a payment: the declared account, every check, and the verdict now. */
export async function senderView(ex: Executor, transferId: string): Promise<SenderView> {
  const t = await transferForCheck(ex, transferId);
  const declared = t.declared ? ((await expectedAccounts(ex, t))[0] ?? null) : null;
  const rows = await ex
    .selectFrom('fiat_sender_check')
    .select(['via', 'verdict', 'seen_name', 'seen_account', 'detail', 'reason', 'checked_by', 'checked_at'])
    .where('fiat_transfer_id', '=', t.id)
    .orderBy('checked_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return {
    verdict: t.needsCheck ? await senderVerdict(ex, t.id) : 'NOT_CHECKED',
    declared,
    checks: rows.map((r) => {
      const d = (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as { pairs?: NameMatchPair[]; account?: string; narration?: string | null } | null;
      return {
        via: r.via, verdict: r.verdict, seenName: r.seen_name, seenAccount: r.seen_account,
        pairs: d?.pairs ?? [], account: d?.account ?? null, narration: d?.narration ?? null,
        reason: r.reason, checkedBy: r.checked_by, checkedAt: r.checked_at.toISOString(),
      };
    }),
  };
}
