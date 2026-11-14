import { sql } from 'kysely';
import { DomainError, Money, RAIL_LIMITS_INR, maskVpa, matchNames, optionalText, requireOneOf, requireRegisteredVpa, requireText, requireUuid } from '@inrp2p/kernel';
import { type DestinationStatus, type Executor, type TxContext, isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type AuthorizationDecision, type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { type ClientAdminCheck, type ClientDataActor, clientDataCommand } from './authz.ts';
import { requireActiveClient } from './clients.ts';

/**
 * UPI IDs as payment destinations of their own (ADR 0029, migration 0050). A client or a trader registers the UPI IDs it
 * is paid to and pays from — as many as it has, with no bank account needed for it. A deal pays to that address, never to
 * one made up from an account number.
 *
 * Who checks it is the one who pays it (ADR 0030, migration 0051): its UPI app shows the name the address resolves to,
 * and the deal tells it the name to expect — the payee's own. One added is live at once, for at most
 * `UPI_FIRST_DEAL_MAX_MINOR` a payment and a day, until a deal paid to it is confirmed by its owner with the payer having
 * checked the name; then its own limits. A payer whose app shows another name says so: the address is paused for a person
 * at INRP2P, and the deal goes on by bank transfer.
 */

/** UPI's own ceiling for one payment between two people, in paise. */
export const UPI_PER_PAYMENT_MAX_MINOR = BigInt(RAIL_LIMITS_INR.upiMax) * 100n;

/**
 * What a UPI ID takes, a payment and a day, until a deal paid to it has shown it is its owner's (ADR 0030): ₹25,000 — what a
 * stranger's address could take before the first payer looked at its name.
 */
export const UPI_FIRST_DEAL_MAX_MINOR = 2_500_000n;

export const upiLabel = (vpa: string) => `UPI ID ${maskVpa(vpa)}`;

export interface AddUpiIdPayload {
  readonly clientId: string;
  readonly vpa: string;
  /**
   * The desk's only: the name the address resolves to, as the person adding it saw it. A client's own is never asked — a
   * payer is told the client's own name to expect, not one typed beside the address (ADR 0030).
   */
  readonly holderName?: string | null;
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

const confirmedBy = (via: AuthorizationDecision | ClientAdminCheck): string => ('confirmedBy' in via ? via.confirmedBy : 'OPERATOR');

/**
 * The name a client is paid under: the holder of its oldest active bank account — the name a payer's bank shows for it —
 * or, with none, its legal name. What a payer of one of its UPI IDs is told to expect, and what its sender is judged by.
 */
export async function ownNameOf(ex: Executor, clientId: string): Promise<string> {
  const bank = await ex.selectFrom('bank_account').select('holder_name').where('client_id', '=', clientId).where('status', '=', 'ACTIVE').orderBy('created_at').orderBy('id').executeTakeFirst();
  if (bank) return bank.holder_name;
  return (await ex.selectFrom('client').select('legal_name').where('id', '=', clientId).executeTakeFirstOrThrow()).legal_name;
}

/**
 * `client_upi.add` — the client's CLIENT_ADMIN, or an operator with `client_bank:add` (⧗). It is live at once (ADR 0030):
 * like a bank account, the client's first UPI ID is confirmed by a sign-in or a code in the last ten minutes, any further
 * one by a factor other than the sign-in. Until a deal shows it is the client's own it takes the first deals' limit
 * (`usableUpiId`); one the desk adds is the desk's own look-up, with the name it saw, and has its full limits at once.
 */
export function addUpiId(actor: ClientDataActor) {
  return clientDataCommand(actor, 'client_bank:add', { stepUp: true, firstDestination: 'UPI_ID' }, async (_ctx, p: AddUpiIdPayload) => requireUuid(p.clientId, 'clientId'), async (ctx, p, clientId, via) => {
    const byDesk = actor.kind === 'OPERATOR';
    await requireActiveClient(ctx.tx, clientId);
    const vpa = requireRegisteredVpa(p.vpa);
    const holderName = byDesk ? requireText(p.holderName, 'holderName', 140) : await ownNameOf(ctx.tx, clientId);
    const label = optionalText(p.label, 'label', 80);
    const limits = limitsOf(p);
    let row;
    try {
      row = await ctx.tx
        .insertInto('upi_id')
        .values({
          client_id: clientId, vpa, holder_name: holderName, label, per_payment_limit_minor: limits.perPayment, daily_limit_minor: limits.daily, created_by: actorLabel(ctx), status: 'ACTIVE',
          ...(byDesk
            ? { verified_name: holderName, reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`statement_timestamp()`, review_note: 'added and looked up by the desk', name_confirmed_at: sql<Date>`statement_timestamp()` }
            : {}),
        })
        .returning(['id', 'status'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e, 'upi_id_live_unique')) throw new DomainError('DUPLICATE_DESTINATION', 'this UPI ID is already registered', { field: 'vpa' });
      throw e;
    }
    await appendAudit(ctx, {
      action: 'client_upi.added', entityType: 'upi_id', entityId: row.id,
      after: { client_id: clientId, vpa, holder_name: holderName, per_payment_limit_minor: limits.perPayment, daily_limit_minor: limits.daily, status: row.status, name_confirmed: byDesk, added_via: actor.kind, confirmed_by: confirmedBy(via) },
    });
    await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: clientId, payload: { clientId, destination: 'UPI_ID', id: row.id, label: upiLabel(vpa), confirmed: byDesk } });
    return { upiId: row.id, status: row.status };
  });
}

/**
 * A UPI ID added inside another command's transaction — a trader's application names one beside its bank account. Live at
 * once, like one the client adds itself (ADR 0030); its name is the account's holder the application names. The caller
 * has authorized the client. One already live or paused for this client is left as it is.
 */
export async function submitUpiIdInTx(ctx: TxContext, clientId: string, p: { vpa: string; holderName: string }): Promise<{ upiId: string; status: DestinationStatus; reused: boolean }> {
  const vpa = requireRegisteredVpa(p.vpa);
  const holderName = requireText(p.holderName, 'holderName', 140);
  const mine = await ctx.tx.selectFrom('upi_id').select(['id', 'status']).where('client_id', '=', clientId).where('vpa', '=', vpa).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).executeTakeFirst();
  if (mine) return { upiId: mine.id, status: mine.status, reused: true };
  // One live address belongs to one client (`upi_id_live_unique`): said here in words, before the insert would refuse it.
  const taken = await ctx.tx.selectFrom('upi_id').select('id').where('vpa', '=', vpa).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).executeTakeFirst();
  if (taken) throw new DomainError('DUPLICATE_DESTINATION', 'this UPI ID is already registered by someone else', { field: 'vpa' });
  const row = await ctx.tx.insertInto('upi_id').values({ client_id: clientId, vpa, holder_name: holderName, status: 'ACTIVE', created_by: actorLabel(ctx) }).returning(['id', 'status']).executeTakeFirstOrThrow();
  await appendAudit(ctx, { action: 'client_upi.added', entityType: 'upi_id', entityId: row.id, after: { client_id: clientId, vpa, holder_name: holderName, status: row.status, name_confirmed: false, added_via: 'trader.apply' } });
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
 * `client_upi.archive` — a UPI ID stops being paid to, for good; one paused for a person at INRP2P is simply withdrawn. Its own
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
  /** VERIFY puts a paused UPI ID back, with its full limits; REJECT ends it — someone else's address. */
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
 * `client_upi.review` — `client_bank:add` (⧗). A UPI ID a payer said resolves to another name is paused (ADR 0030); a
 * person at INRP2P looks the address up in a UPI app and records the name it resolves to. That name is judged word by word
 * against the client's own names on its record (`upiNameVerdict`), as a sender's is against an account's holder (ADR
 * 0018): a match puts it back, with its full limits; a partial match needs the reviewer's reason; another name is never
 * put back — it is someone else's address, rejected with a note the client reads.
 */
export function reviewUpiId(actor: OperatorActor) {
  return operatorCommand(actor, 'client_bank:add', async (ctx, p: ReviewUpiIdPayload) => {
    const decision = requireOneOf(p.decision, 'decision', ['VERIFY', 'REJECT'] as const);
    const row = await ctx.tx.selectFrom('upi_id').select(['id', 'client_id', 'vpa', 'holder_name', 'status']).where('id', '=', requireUuid(p.upiId, 'upiId')).forUpdate().executeTakeFirst();
    if (!row) throw new DomainError('NOT_FOUND', 'UPI ID not found');
    if (row.status !== 'PENDING_REVIEW') throw new DomainError('INVALID_TRANSITION', `this UPI ID is ${row.status === 'ACTIVE' ? 'live — nothing to decide' : row.status.toLowerCase()}`);
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
      .set({
        status: 'ACTIVE', verified_name: resolvedName, reviewed_by: actorLabel(ctx), reviewed_at: sql<Date>`statement_timestamp()`, review_note: note,
        name_confirmed_at: sql<Date>`statement_timestamp()`, updated_at: sql<Date>`statement_timestamp()`,
      })
      .where('id', '=', row.id)
      .execute();
    await appendAudit(ctx, { action: 'client_upi.verified', entityType: 'upi_id', entityId: row.id, before: { status: 'PENDING_REVIEW' }, after: { status: 'ACTIVE', vpa: row.vpa, verified_name: resolvedName, verdict, judged_against: against, note } });
    await enqueueOutbox(ctx, { type: 'client.destination_added', aggregateType: 'client', aggregateId: row.client_id, payload: { clientId: row.client_id, destination: 'UPI_ID', id: row.id, label: upiLabel(row.vpa), confirmed: true } });
    return { status: 'ACTIVE' as const, verdict };
  });
}

/**
 * A payer's app showed another name for a deal's UPI ID (ADR 0030): it is paused — nothing more is paid to it — with what
 * was seen, until a person at INRP2P decides (`reviewUpiId`). Its owner is told. The caller holds the deal's lock and has
 * checked the reporter is that deal's payer. False: it was no longer live.
 */
export async function pauseUpiIdInTx(ctx: TxContext, input: { readonly upiId: string; readonly tradeId: string; readonly shownName: string }): Promise<boolean> {
  const shownName = requireText(input.shownName, 'shownName', 140);
  const row = await ctx.tx.selectFrom('upi_id').select(['id', 'client_id', 'vpa', 'status']).where('id', '=', input.upiId).forUpdate().executeTakeFirstOrThrow();
  if (row.status !== 'ACTIVE') return false;
  await ctx.tx
    .updateTable('upi_id')
    .set({
      status: 'PENDING_REVIEW', reported_name: shownName, reported_at: sql<Date>`statement_timestamp()`, reported_by: actorLabel(ctx), reported_trade_id: input.tradeId,
      updated_at: sql<Date>`statement_timestamp()`,
    })
    .where('id', '=', row.id)
    .execute();
  await appendAudit(ctx, { action: 'client_upi.paused', entityType: 'upi_id', entityId: row.id, before: { status: 'ACTIVE' }, after: { status: 'PENDING_REVIEW', vpa: row.vpa, shown_name: shownName, trade_id: input.tradeId } });
  // The deal is named to its own client only: a trader knows its deals by its orders, not by the client's trade.
  const own = (await ctx.tx.selectFrom('trade').select('client_id').where('id', '=', input.tradeId).executeTakeFirst())?.client_id === row.client_id;
  await enqueueOutbox(ctx, {
    type: 'client.destination_paused', aggregateType: 'client', aggregateId: row.client_id,
    payload: { clientId: row.client_id, destination: 'UPI_ID', id: row.id, label: upiLabel(row.vpa), ...(own ? { tradeId: input.tradeId } : {}) },
  });
  return true;
}

/**
 * A deal paid to a UPI ID was confirmed by its owner, and its payer had said its app showed the owner's name (ADR 0030):
 * the address is its owner's, and takes its own limits from now on. Once; a paused one is the desk's to decide.
 */
export async function confirmUpiNameInTx(ctx: TxContext, input: { readonly upiId: string; readonly tradeId: string }): Promise<boolean> {
  const done = await ctx.tx
    .updateTable('upi_id')
    .set({ name_confirmed_at: sql<Date>`statement_timestamp()`, name_confirmed_trade_id: input.tradeId, updated_at: sql<Date>`statement_timestamp()` })
    .where('id', '=', input.upiId)
    .where('status', '=', 'ACTIVE')
    .where('name_confirmed_at', 'is', null)
    .returning('vpa')
    .executeTakeFirst();
  if (done) await appendAudit(ctx, { action: 'client_upi.name_confirmed', entityType: 'upi_id', entityId: input.upiId, after: { vpa: done.vpa, trade_id: input.tradeId } });
  return done !== undefined;
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
  /** A deal (or the desk) showed it is its owner's: its own limits apply. Until then, the first deals' limit. */
  readonly nameConfirmed: boolean;
  /** What a payer's app showed instead, when one said so — why it is paused. */
  readonly reportedName: string | null;
  readonly reportedAt: string | null;
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
      nameConfirmed: r.name_confirmed_at !== null, reportedName: r.reported_name, reportedAt: r.reported_at?.toISOString() ?? null,
    });
  }
  return out;
}

/** A UPI ID paused because a payer's app showed another name (ADR 0030): what the desk decides. */
export interface PendingUpiId {
  readonly id: string;
  readonly clientId: string;
  readonly clientRef: string;
  readonly clientName: string;
  readonly vpa: string;
  /** The name the payer was told to expect: the client's own. */
  readonly holderName: string;
  /** What the payer's app showed instead. */
  readonly reportedName: string | null;
  readonly reportedAt: string | null;
  /** The deal it was seen on. */
  readonly tradeRef: string | null;
  readonly submittedAt: string;
}

/** Every UPI ID paused for the desk, oldest report first: the desk's queue is the rows themselves. */
export async function pendingUpiIds(ex: Executor, limit = 100): Promise<PendingUpiId[]> {
  const rows = await ex
    .selectFrom('upi_id as u')
    .innerJoin('client as c', 'c.id', 'u.client_id')
    .leftJoin('trade as t', 't.id', 'u.reported_trade_id')
    .select(['u.id', 'u.client_id', 'c.ref', 'c.legal_name', 'u.vpa', 'u.holder_name', 'u.reported_name', 'u.reported_at', 't.ref as trade_ref', 'u.created_at'])
    .where('u.status', '=', 'PENDING_REVIEW')
    .orderBy(sql`coalesce(u.reported_at, u.created_at)`)
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id, clientId: r.client_id, clientRef: r.ref, clientName: r.legal_name, vpa: r.vpa, holderName: r.holder_name,
    reportedName: r.reported_name, reportedAt: r.reported_at?.toISOString() ?? null, tradeRef: r.trade_ref, submittedAt: r.created_at.toISOString(),
  }));
}

export interface UsableUpiId {
  readonly id: string;
  readonly vpa: string;
  /** The name the desk saw the address resolve to, when a person looked it up; otherwise the payer is told the payee's own. */
  readonly verifiedName: string | null;
  /** A deal (or the desk) showed it is its owner's. */
  readonly confirmed: boolean;
}

/**
 * The live UPI ID of a client that can take one payment of `inrMinor` now: within its own limit for a payment and, where it
 * has one, what is left of its day — and, until a deal has shown it is the client's own, within the first deals' limit
 * (ADR 0030). The oldest that fits — a stable choice, so the same question asked twice in a minute gets the same address.
 * Null: nothing of the client's can be paid this amount by UPI.
 */
export async function usableUpiId(ex: Executor, clientId: string, inrMinor: bigint, opts: { excludeTradeId?: string | null } = {}): Promise<UsableUpiId | null> {
  if (inrMinor <= 0n || inrMinor > UPI_PER_PAYMENT_MAX_MINOR) return null;
  const rows = await ex
    .selectFrom('upi_id')
    .select(['id', 'vpa', 'verified_name', 'daily_limit_minor', 'name_confirmed_at'])
    .where('client_id', '=', clientId)
    .where('status', '=', 'ACTIVE')
    .where('per_payment_limit_minor', '>=', inrMinor)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  for (const r of rows) {
    const confirmed = r.name_confirmed_at !== null;
    const daily = confirmed ? r.daily_limit_minor : r.daily_limit_minor === null || r.daily_limit_minor > UPI_FIRST_DEAL_MAX_MINOR ? UPI_FIRST_DEAL_MAX_MINOR : r.daily_limit_minor;
    if (!confirmed && inrMinor > UPI_FIRST_DEAL_MAX_MINOR) continue;
    if (daily !== null && (await upiUsedToday(ex, r.id, opts)) + inrMinor > daily) continue;
    return { id: r.id, vpa: r.vpa, verifiedName: r.verified_name, confirmed };
  }
  return null;
}

/** A live UPI ID by its id, as a deal that was opened with it keeps showing it. Null once it is paused or archived. */
export async function activeUpiId(ex: Executor, id: string): Promise<UsableUpiId | null> {
  const r = await ex.selectFrom('upi_id').select(['id', 'vpa', 'verified_name', 'status', 'name_confirmed_at']).where('id', '=', id).executeTakeFirst();
  return r && r.status === 'ACTIVE' ? { id: r.id, vpa: r.vpa, verifiedName: r.verified_name, confirmed: r.name_confirmed_at !== null } : null;
}
