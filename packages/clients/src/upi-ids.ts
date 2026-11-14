import { sql } from 'kysely';
import { DomainError, Money, RAIL_LIMITS_INR, maskVpa, matchNames, optionalText, requireOneOf, requireRegisteredVpa, requireText, requireUuid } from '@inrp2p/kernel';
import { type DestinationStatus, type Executor, type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, actorLabel, operatorCommand, requireConfirmation } from '@inrp2p/identity';
import { type ClientDataActor, clientDataCommand } from './authz.ts';
import { requireActiveClient } from './clients.ts';

/**
 * UPI IDs as payment destinations of their own (ADR 0029, migration 0050). A client or a trader registers the UPI IDs it
 * is paid to and pays from — as many as it has, with no bank account needed for it. One it adds itself is used by nothing
 * until a person at INRP2P has looked the address up and recorded the name it resolves to; from then on a deal pays to
 * that address, never to one made up from an account number, and its payer is told that name to check in its app.
 */

/** UPI's own ceiling for one payment between two people, in paise. */
export const UPI_PER_PAYMENT_MAX_MINOR = BigInt(RAIL_LIMITS_INR.upiMax) * 100n;

export const upiLabel = (vpa: string) => `UPI ID ${maskVpa(vpa)}`;

export interface AddUpiIdPayload {
  readonly clientId: string;
  readonly vpa: string;
  /** The name a payer's app shows for it. */
  readonly holderName: string;
  readonly label?: string | null;
  /** Decimal rupees; at most UPI's ₹1,00,000. Omitted: that ceiling. */
  readonly perPaymentLimit?: string | null;
  /** Decimal rupees for one Indian day; omitted or empty: no ceiling of its own. */
  readonly dailyLimit?: string | null;
}

function limitsOf(p: { perPaymentLimit?: string | null | undefined; dailyLimit?: string | null | undefined }, current?: { perPayment: bigint; daily: bigint | null }): { perPayment: bigint; daily: bigint | null } {
  const perPayment = p.perPaymentLimit === undefined ? (current?.perPayment ?? UPI_PER_PAYMENT_MAX_MINOR) : p.perPaymentLimit === null || p.perPaymentLimit === '' ? UPI_PER_PAYMENT_MAX_MINOR : Money.parse(p.perPaymentLimit, 'INR').minor;
  if (perPayment < 100n || perPayment > UPI_PER_PAYMENT_MAX_MINOR) {
    throw new DomainError('INVALID_AMOUNT', `one UPI payment is between ₹1 and ₹${RAIL_LIMITS_INR.upiMax.toLocaleString('en-IN')}`, { field: 'perPaymentLimit' });
  }
  const daily = p.dailyLimit === undefined ? (current?.daily ?? null) : p.dailyLimit === null || p.dailyLimit === '' ? null : Money.parse(p.dailyLimit, 'INR').minor;
  if (daily !== null && daily < perPayment) throw new DomainError('INVALID_AMOUNT', 'a day’s limit cannot be below the limit of one payment', { field: 'dailyLimit' });
  return { perPayment, daily };
}

/**
 * `client_upi.add` — the client's CLIENT_ADMIN, confirmed by a sign-in or a code in the last ten minutes, or an operator
 * with `client_bank:add` (⧗). A UPI ID the client adds waits for review and is used by nothing meanwhile — which is why a
 * recent confirmation is enough for it; one the desk adds is the desk's own verification and is live at once.
 */
export function addUpiId(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: false }, async (_ctx, p: AddUpiIdPayload) => requireUuid(p.clientId, 'clientId'), async (ctx, p, clientId) => {
    const byDesk = actor.kind === 'OPERATOR';
    const confirmedBy = byDesk ? 'OPERATOR' : await requireConfirmation(ctx.tx, actor.sessionId, 'RECENT', 'DESTINATION');
    await requireActiveClient(ctx.tx, clientId);
    const vpa = requireRegisteredVpa(p.vpa);
    const holderName = requireText(p.holderName, 'holderName', 140);
    const label = optionalText(p.label, 'label', 80);
    const limits = limitsOf(p);
    let row;
    try {
      row = await ctx.tx
        .insertInto('upi_id')
        .values({
          client_id: clientId, vpa, holder_name: holderName, label, per_payment_limit_minor: limits.perPayment, daily_limit_minor: limits.daily, created_by: actorLabel(ctx),
          ...(byDesk ? { status: 'ACTIVE' as const, verified_name: holderName, reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`statement_timestamp()`, review_note: 'added and verified by the desk' } : {}),
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e, 'upi_id_live_unique')) throw new DomainError('DUPLICATE_DESTINATION', 'this UPI ID is already registered', { field: 'vpa' });
      throw e;
    }
    await appendAudit(ctx, {
      action: byDesk ? 'client_upi.added' : 'client_upi.submitted', entityType: 'upi_id', entityId: row.id,
      after: { client_id: clientId, vpa, holder_name: holderName, per_payment_limit_minor: limits.perPayment, daily_limit_minor: limits.daily, status: row.status, added_via: actor.kind, confirmed_by: confirmedBy },
    });
    if (byDesk) await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'UPI_ID', id: row.id, label: upiLabel(vpa) } });
    return { upiId: row.id, status: row.status };
  });
}

/**
 * A UPI ID submitted for review inside another command's transaction — a trader's application names one beside its bank
 * account. The caller has authorized the client. One already waiting or verified for this client is left as it is.
 */
export async function submitUpiIdInTx(ctx: TxContext, clientId: string, p: { vpa: string; holderName: string }): Promise<{ upiId: string; status: DestinationStatus; reused: boolean }> {
  const vpa = requireRegisteredVpa(p.vpa);
  const holderName = requireText(p.holderName, 'holderName', 140);
  const mine = await ctx.tx.selectFrom('upi_id').select(['id', 'status']).where('client_id', '=', clientId).where('vpa', '=', vpa).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).executeTakeFirst();
  if (mine) return { upiId: mine.id, status: mine.status, reused: true };
  // One live address belongs to one client (`upi_id_live_unique`): said here in words, before the insert would refuse it.
  const taken = await ctx.tx.selectFrom('upi_id').select('id').where('vpa', '=', vpa).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).executeTakeFirst();
  if (taken) throw new DomainError('DUPLICATE_DESTINATION', 'this UPI ID is already registered by someone else', { field: 'vpa' });
  const row = await ctx.tx.insertInto('upi_id').values({ client_id: clientId, vpa, holder_name: holderName, created_by: actorLabel(ctx) }).returning(['id', 'status']).executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'client_upi.submitted', entityType: 'upi_id', entityId: row.id, after: { client_id: clientId, vpa, holder_name: holderName, status: row.status, added_via: 'trader.apply' } });
  return { upiId: row.id, status: row.status, reused: false };
}

async function clientOfUpiId(ctx: TxContext, id: string): Promise<string> {
  const row = await ctx.tx.selectFrom('upi_id').select('client_id').where('id', '=', requireUuid(id, 'upiId')).executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'UPI ID not found');
  return row.client_id;
}

/**
 * `client_upi.update` — its limits and its label, by the client's CLIENT_ADMIN (confirmed by another factor: a limit
 * decides how much is paid to the address) or the desk. The address itself never changes: another address is another row.
 */
export function updateUpiId(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: true, purpose: 'DESTINATION' }, async (ctx, p: { upiId: string; label?: string | null; perPaymentLimit?: string | null; dailyLimit?: string | null }) => clientOfUpiId(ctx, p.upiId), async (ctx, p) => {
    const before = await ctx.tx.selectFrom('upi_id').select(['id', 'status', 'label', 'per_payment_limit_minor', 'daily_limit_minor']).where('id', '=', p.upiId).forUpdate().executeTakeFirstOrThrow();
    if (before.status !== 'ACTIVE' && before.status !== 'PENDING_REVIEW') throw new DomainError('INVALID_TRANSITION', `this UPI ID is ${before.status.toLowerCase()}`);
    const limits = limitsOf(p, { perPayment: before.per_payment_limit_minor, daily: before.daily_limit_minor });
    const label = p.label === undefined ? before.label : optionalText(p.label, 'label', 80);
    await ctx.tx.updateTable('upi_id').set({ label, per_payment_limit_minor: limits.perPayment, daily_limit_minor: limits.daily, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, {
      action: 'client_upi.updated', entityType: 'upi_id', entityId: before.id,
      before: { label: before.label, per_payment_limit_minor: before.per_payment_limit_minor, daily_limit_minor: before.daily_limit_minor },
      after: { label, per_payment_limit_minor: limits.perPayment, daily_limit_minor: limits.daily, changed_via: actor.kind },
    });
    return { updated: true as const };
  });
}

/**
 * `client_upi.archive` — a UPI ID stops being paid to, for good; one still waiting for review is simply withdrawn. Its own
 * client cannot archive one a deal in progress is being paid to, or one a payment still being checked was declared from:
 * the deal keeps the address it opened with. The desk can (a compromised address) — the deal then offers a bank transfer.
 */
export function archiveUpiId(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: true, purpose: 'DESTINATION' }, async (ctx, p: { upiId: string; reason: string }) => clientOfUpiId(ctx, p.upiId), async (ctx, p, clientId) => {
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('upi_id').select(['id', 'status', 'vpa']).where('id', '=', p.upiId).forUpdate().executeTakeFirstOrThrow();
    if (before.status !== 'ACTIVE' && before.status !== 'PENDING_REVIEW') throw new DomainError('INVALID_TRANSITION', `this UPI ID is already ${before.status.toLowerCase()}`);
    if (actor.kind !== 'OPERATOR' && before.status === 'ACTIVE') {
      const deal = await sql<{ n: string }>`
        select count(*)::text as n from p2p_pay_window w join trade t on t.id = w.trade_id
         where w.payee_upi_id = ${before.id}::uuid and t.lifecycle_state not in ('COMPLETED', 'CANCELLED')`.execute(ctx.tx);
      if (deal.rows[0]!.n !== '0') throw new DomainError('DESTINATION_IN_USE', 'A deal in progress is being paid to this UPI ID. Archive it once the deal has finished.', { field: 'upiId' });
      const paying = await ctx.tx.selectFrom('fiat_transfer').select('id').where('payer_upi_id', '=', before.id).where('status', '=', 'RECORDED').executeTakeFirst();
      if (paying) throw new DomainError('DESTINATION_IN_USE', 'A payment you made from this UPI ID is still being confirmed. Archive it once that deal has finished.', { field: 'upiId' });
    }
    await ctx.tx.updateTable('upi_id').set({ status: 'ARCHIVED', archived_by: actorLabel(ctx), archived_at: sql<Date>`statement_timestamp()`, archive_reason: reason, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'client_upi.archived', entityType: 'upi_id', entityId: before.id, before: { status: before.status }, after: { status: 'ARCHIVED', reason, vpa: before.vpa, archived_via: actor.kind } });
    if (before.status === 'ACTIVE') {
      await enqueueOutbox(ctx, { type: 'client.destination_archived', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'UPI_ID', id: before.id, label: upiLabel(before.vpa) } });
    }
    return { archived: true as const };
  });
}

export interface ReviewUpiIdPayload {
  readonly upiId: string;
  readonly decision: 'VERIFY' | 'REJECT';
  /** To verify: the name the address resolves to when a person at INRP2P looks it up in a UPI app. */
  readonly resolvedName?: string | null;
  /** Required to reject, and to verify a name that only partly matches; the client sees a rejection's note. */
  readonly note?: string | null;
}

/**
 * The names a client is known by on its own record: its legal and display names, and the holder of every bank account
 * it has on file. A UPI ID is its own only when the name the address resolves to is one of these — never merely the name
 * typed beside it, which whoever holds the session also typed.
 */
async function namesOfClient(ex: Executor, clientId: string): Promise<string[]> {
  const c = await ex.selectFrom('client').select(['legal_name', 'display_name']).where('id', '=', clientId).executeTakeFirstOrThrow();
  const banks = await ex.selectFrom('bank_account').select('holder_name').where('client_id', '=', clientId).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).execute();
  return [...new Set([c.legal_name, c.display_name, ...banks.map((b) => b.holder_name)])];
}

const RANK = { MATCH: 3, PARTIAL: 2, UNKNOWN: 1, MISMATCH: 0 } as const;

/** How the name an address resolved to compares with the client's own names: the best of them. */
export async function upiNameVerdict(ex: Executor, clientId: string, resolvedName: string): Promise<{ verdict: 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN'; against: string | null }> {
  let best: { verdict: 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'UNKNOWN'; against: string | null } = { verdict: 'MISMATCH', against: null };
  for (const name of await namesOfClient(ex, clientId)) {
    const v = matchNames(name, resolvedName).verdict;
    if (best.against === null || RANK[v] > RANK[best.verdict]) best = { verdict: v, against: name };
  }
  return best;
}

/**
 * `client_upi.review` — `client_bank:add` (⧗). The desk looks the address up in a UPI app and records the name it
 * resolves to. That name is judged word by word against the client's own names on its record (`upiNameVerdict`), as a
 * sender's is against an account's holder (ADR 0018): a match verifies it; a partial match needs the reviewer's reason;
 * another name is never verified — it is someone else's address, rejected with a note the client reads. Verified, it is
 * live: deals are paid to it, and its owner may pay from it.
 */
export function reviewUpiId(actor: OperatorActor) {
  return operatorCommand(actor, 'client_bank:add', async (ctx, p: ReviewUpiIdPayload) => {
    const decision = requireOneOf(p.decision, 'decision', ['VERIFY', 'REJECT'] as const);
    const row = await ctx.tx.selectFrom('upi_id').select(['id', 'client_id', 'vpa', 'holder_name', 'status']).where('id', '=', requireUuid(p.upiId, 'upiId')).forUpdate().executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 'UPI ID not found');
    if (row.status !== 'PENDING_REVIEW') throw new DomainError('INVALID_TRANSITION', `this UPI ID is ${row.status === 'ACTIVE' ? 'already verified' : row.status.toLowerCase()}`);
    if (decision === 'REJECT') {
      const note = requireText(p.note, 'note', 500);
      await ctx.tx.updateTable('upi_id').set({ status: 'REJECTED', reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`statement_timestamp()`, review_note: note, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', row.id).execute();
      await appendAudit(ctx, { action: 'client_upi.rejected', entityType: 'upi_id', entityId: row.id, before: { status: 'PENDING_REVIEW' }, after: { status: 'REJECTED', note, vpa: row.vpa } });
      await enqueueOutbox(ctx, { type: 'client.destination_rejected', aggregateType: 'client', aggregateId: row.client_id, payload: { clientId: row.client_id, destination: 'UPI_ID', id: row.id, label: upiLabel(row.vpa), reason: note } });
      return { status: 'REJECTED' as const, verdict: null };
    }
    const resolvedName = requireText(p.resolvedName, 'resolvedName', 140);
    const note = optionalText(p.note, 'note', 500);
    const { verdict, against } = await upiNameVerdict(ctx.tx, row.client_id, resolvedName);
    if (verdict !== 'MATCH' && verdict !== 'PARTIAL') {
      throw new DomainError('UPI_NAME_MISMATCH', 'that name is not the client’s own: it is someone else’s address — reject it', { field: 'resolvedName', verdict });
    }
    if (verdict === 'PARTIAL' && !note) throw new DomainError('INVALID_ARGUMENT', 'the name only partly matches: say why it is the same person', { field: 'note', verdict });
    await ctx.tx
      .updateTable('upi_id')
      .set({ status: 'ACTIVE', verified_name: resolvedName, reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`statement_timestamp()`, review_note: note, updated_at: sql<Date>`statement_timestamp()` })
      .where('id', '=', row.id)
      .execute();
    await appendAudit(ctx, { action: 'client_upi.verified', entityType: 'upi_id', entityId: row.id, before: { status: 'PENDING_REVIEW' }, after: { status: 'ACTIVE', vpa: row.vpa, verified_name: resolvedName, verdict, judged_against: against, note } });
    await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: row.client_id, payload: { clientId: row.client_id, destination: 'UPI_ID', id: row.id, label: upiLabel(row.vpa) } });
    return { status: 'ACTIVE' as const, verdict };
  });
}

// ---- reading -----------------------------------------------------------------------------------------------------------

export interface UpiIdView {
  readonly id: string;
  readonly vpa: string;
  readonly holderName: string;
  readonly verifiedName: string | null;
  readonly label: string | null;
  /** Decimal rupees. */
  readonly perPaymentLimit: string;
  readonly dailyLimit: string | null;
  /** What deals opened today already count against the day's limit, in decimal rupees. */
  readonly usedToday: string;
  readonly status: DestinationStatus;
  readonly reviewNote: string | null;
  readonly createdAt: string;
}

/**
 * What a UPI ID has taken in the current Indian day: every deal whose buyer was shown it today, unless that deal was
 * cancelled or its buyer said it paid another way. Counted from the deal's opening, so two deals opened together cannot
 * both be promised the last of a day's limit.
 */
export async function upiUsedToday(ex: Executor, upiId: string, opts: { excludeTradeId?: string | null } = {}): Promise<bigint> {
  const r = await sql<{ used: string }>`
    select coalesce(sum(e.quote_inr_minor), 0)::text as used
      from p2p_pay_window w
      join trade t on t.id = w.trade_id
      join trade_economics e on e.trade_id = t.id
     where w.payee_upi_id = ${upiId}::uuid
       and (w.opened_at at time zone 'Asia/Kolkata')::date = (inrp2p_now() at time zone 'Asia/Kolkata')::date
       and t.lifecycle_state <> 'CANCELLED'
       and (${opts.excludeTradeId ?? null}::uuid is null or t.id <> ${opts.excludeTradeId ?? null}::uuid)
       and not exists (
         select 1 from settlement_leg l
           join transfer_allocation a on a.settlement_leg_id = l.id and a.voided_at is null
           join fiat_transfer f on f.id = a.fiat_transfer_id
          where l.trade_id = t.id and l.asset = 'INR' and l.status in ('PROCESSING', 'COMPLETED') and f.rail <> 'UPI')`.execute(ex);
  return BigInt(r.rows[0]!.used);
}

/** A client's UPI IDs as its own screens and the desk show them, newest first; archived and rejected ones on request. */
export async function listUpiIds(ex: Executor, clientId: string, opts: { includeClosed?: boolean } = {}): Promise<UpiIdView[]> {
  let q = ex.selectFrom('upi_id').selectAll().where('client_id', '=', requireUuid(clientId, 'clientId')).orderBy('created_at', 'desc');
  if (!opts.includeClosed) q = q.where('status', 'in', ['ACTIVE', 'PENDING_REVIEW', 'REJECTED']);
  const rows = await q.execute();
  const out: UpiIdView[] = [];
  for (const r of rows) {
    out.push({
      id: r.id, vpa: r.vpa, holderName: r.holder_name, verifiedName: r.verified_name, label: r.label,
      perPaymentLimit: Money.ofMinor(r.per_payment_limit_minor, 'INR').toDecimalString(),
      dailyLimit: r.daily_limit_minor === null ? null : Money.ofMinor(r.daily_limit_minor, 'INR').toDecimalString(),
      usedToday: Money.ofMinor(r.status === 'ACTIVE' ? await upiUsedToday(ex, r.id) : 0n, 'INR').toDecimalString(),
      status: r.status, reviewNote: r.review_note, createdAt: r.created_at.toISOString(),
    });
  }
  return out;
}

export interface PendingUpiId {
  readonly id: string;
  readonly clientId: string;
  readonly clientRef: string;
  readonly clientName: string;
  readonly vpa: string;
  readonly holderName: string;
  readonly submittedAt: string;
}

/** Every UPI ID waiting for the desk, oldest first: the desk's queue is the rows themselves. */
export async function pendingUpiIds(ex: Executor, limit = 100): Promise<PendingUpiId[]> {
  const rows = await ex
    .selectFrom('upi_id as u')
    .innerJoin('client as c', 'c.id', 'u.client_id')
    .select(['u.id', 'u.client_id', 'c.ref', 'c.legal_name', 'u.vpa', 'u.holder_name', 'u.created_at'])
    .where('u.status', '=', 'PENDING_REVIEW')
    .orderBy('u.created_at')
    .limit(limit)
    .execute();
  return rows.map((r) => ({ id: r.id, clientId: r.client_id, clientRef: r.ref, clientName: r.legal_name, vpa: r.vpa, holderName: r.holder_name, submittedAt: r.created_at.toISOString() }));
}

export interface UsableUpiId {
  readonly id: string;
  readonly vpa: string;
  /** The name a payer's app shows: what the desk saw the address resolve to. */
  readonly name: string;
}

/**
 * The verified UPI ID of a client that can take one payment of `inrMinor` now: within its own limit for a payment and,
 * where it has one, what is left of its day. The oldest that fits — a stable choice, so the same question asked twice in
 * a minute gets the same address. Null: nothing of the client's can be paid this amount by UPI.
 */
export async function usableUpiId(ex: Executor, clientId: string, inrMinor: bigint, opts: { excludeTradeId?: string | null } = {}): Promise<UsableUpiId | null> {
  if (inrMinor <= 0n || inrMinor > UPI_PER_PAYMENT_MAX_MINOR) return null;
  const rows = await ex
    .selectFrom('upi_id')
    .select(['id', 'vpa', 'verified_name', 'holder_name', 'daily_limit_minor'])
    .where('client_id', '=', clientId)
    .where('status', '=', 'ACTIVE')
    .where('per_payment_limit_minor', '>=', inrMinor)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  for (const r of rows) {
    if (r.daily_limit_minor !== null && (await upiUsedToday(ex, r.id, opts)) + inrMinor > r.daily_limit_minor) continue;
    return { id: r.id, vpa: r.vpa, name: r.verified_name ?? r.holder_name };
  }
  return null;
}

/** A verified UPI ID by its id, as a deal that was opened with it keeps showing it. Null once it is no longer active. */
export async function activeUpiId(ex: Executor, id: string): Promise<UsableUpiId | null> {
  const r = await ex.selectFrom('upi_id').select(['id', 'vpa', 'verified_name', 'holder_name', 'status']).where('id', '=', id).executeTakeFirst();
  return r && r.status === 'ACTIVE' ? { id: r.id, vpa: r.vpa, name: r.verified_name ?? r.holder_name } : null;
}
