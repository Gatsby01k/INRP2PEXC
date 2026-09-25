import { sql } from 'kysely';
import { DomainError, Money, Rate, computeTradeEconomics, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, authorizeOperator, operatorCommand } from '@inrp2p/identity';
import { requireUsableRoute } from '@inrp2p/routes';
import { requireCurrentRouteRate } from '@inrp2p/pricing';
import { type QuoteDeps, policyOf } from './policy.ts';
import { lockRow } from './actors.ts';
import { closePendingChallenges } from './challenges.ts';
import { cancelSentQuoteOfRequest } from './requests.ts';
import { businessNow, linkTokenHash, newLinkToken } from './security.ts';

export interface CreateQuotePayload {
  readonly requestId: string;
  readonly routeId: string;
  /** Client rate (INR per USDT) the desk offers. */
  readonly clientRate: string;
  /** Validity in seconds; omitted means the shareable-link default of 180 s (D-01 rev 3). Link quotes need at least the policy link minimum. */
  readonly validitySeconds?: number;
  /** Optional re-quote of a different amount than requested (counter); defaults to the request amount and side. */
  readonly amount?: string;
  readonly fixedSide?: 'BASE' | 'QUOTE';
  /** Mandatory when the computed margin is negative (FINANCIAL_INVARIANTS §1.3). */
  readonly negativeMarginReason?: string | null;
}

/**
 * `quote.create` (STATE_MACHINES §2 create → DRAFT) — `quote:create`. The desk supplies amount, fixed side, client rate
 * and validity only: INR value, route value and margin are computed from the current route snapshot (FI-02).
 */
export function createQuote(actor: OperatorActor, deps: Pick<QuoteDeps, 'policy'>) {
  const policy = policyOf(deps);
  return operatorCommand(actor, 'quote:create', async (ctx, p: CreateQuotePayload) => {
    const requested = p.validitySeconds === undefined || p.validitySeconds === null ? policy.linkDefaultValiditySeconds : p.validitySeconds;
    const validity = typeof requested === 'number' && Number.isInteger(requested) ? requested : -1;
    if (validity < policy.minValiditySeconds || validity > policy.maxValiditySeconds) {
      throw new DomainError('QUOTE_VALIDITY_INVALID', `validity must be a whole number of seconds between ${policy.minValiditySeconds} and ${policy.maxValiditySeconds}`);
    }
    await lockRow(ctx.tx, 'trade_request', 'trade_request', requireUuid(p.requestId, 'requestId'));
    const request = await ctx.tx.selectFrom('trade_request').selectAll().where('id', '=', p.requestId).executeTakeFirstOrThrow();
    if (request.status !== 'OPEN' && request.status !== 'QUOTED') throw new DomainError('REQUEST_NOT_OPEN', `request is ${request.status}`);
    const client = await ctx.tx.selectFrom('client').select(['status']).where('id', '=', request.client_id).executeTakeFirstOrThrow();
    if (client.status !== 'ACTIVE') throw new DomainError('CLIENT_NOT_ACTIVE', 'client is suspended');

    const route = await requireUsableRoute(ctx.tx, requireUuid(p.routeId, 'routeId'), request.direction);
    const snapshot = await requireCurrentRouteRate(ctx.tx, route.id, request.direction);
    const clientRate = Rate.parse(p.clientRate, 'CLIENT');
    const fixedSide = p.fixedSide ? requireOneOf(p.fixedSide, 'fixedSide', ['BASE', 'QUOTE'] as const) : request.fixed_side;
    // The requested amount is in the request's own fixed side; quoting the other side needs its own amount.
    if (fixedSide !== request.fixed_side && p.amount === undefined) {
      throw new DomainError('INVALID_ARGUMENT', 'an amount is required when the quote fixes a different side than the request', { field: 'amount' });
    }
    const amount = p.amount !== undefined
      ? (fixedSide === 'BASE' ? Money.parse(p.amount, 'USDT') : Money.parse(p.amount, 'INR'))
      : (request.fixed_side === 'BASE' ? Money.ofMinor(request.requested_base_minor!, 'USDT') : Money.ofMinor(request.requested_quote_minor!, 'INR'));
    const econ = computeTradeEconomics(
      fixedSide === 'BASE'
        ? { direction: request.direction, fixedSide: 'BASE', amount: amount as Money<'USDT'>, clientRate, routeRate: snapshot.rate }
        : { direction: request.direction, fixedSide: 'QUOTE', amount: amount as Money<'INR'>, clientRate, routeRate: snapshot.rate },
    );
    const negativeReason = econ.grossMargin.isNegative() ? requireText(p.negativeMarginReason, 'negativeMarginReason', 500) : null;
    const isCounter = request.target_rate_micro !== null && request.target_rate_micro !== clientRate.micro;

    const row = await ctx.tx
      .insertInto('quote')
      .values({
        trade_request_id: request.id,
        client_id: request.client_id,
        direction: request.direction,
        fixed_side: fixedSide,
        base_minor: econ.base.minor,
        quote_inr_minor: econ.clientInr.minor,
        client_rate_micro: clientRate.micro,
        route_rate_micro: snapshot.rate.micro,
        route_rate_snapshot_id: snapshot.id,
        route_id: route.id,
        route_value_inr_minor: econ.routeInr.minor,
        gross_margin_inr_minor: econ.grossMargin.minor,
        network: request.network,
        bank_account_id: request.bank_account_id,
        crypto_wallet_id: request.crypto_wallet_id,
        valid_for_seconds: validity,
        is_counter: isCounter,
        negative_margin_reason: negativeReason,
        created_by: ctx.actor.id ?? 'SYSTEM',
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    if (!request.assigned_dealer_id && ctx.actor.id) {
      await ctx.tx.updateTable('trade_request').set({ assigned_dealer_id: ctx.actor.id, last_activity_at: sql<Date>`inrp2p_now()`, version: request.version + 1 }).where('id', '=', request.id).execute();
    }
    await appendAudit(ctx, {
      action: 'quote.created', entityType: 'quote', entityId: row.id,
      after: { ref: row.ref, request_id: request.id, direction: request.direction, base: econ.base, client_inr: econ.clientInr, client_rate: clientRate, route_id: route.id, route_rate_snapshot_id: snapshot.id, gross_margin: econ.grossMargin, is_counter: isCounter, valid_for_seconds: validity },
    });
    return {
      quoteId: row.id,
      ref: row.ref,
      base: econ.base.toDecimalString(),
      clientInr: econ.clientInr.toDecimalString(),
      grossMarginInr: econ.grossMargin.toDecimalString(),
      isCounter,
    };
  });
}

export interface SendQuotePayload {
  readonly quoteId: string;
  /** Creates a shareable link in the same transaction (link quotes need ≥ the policy minimum validity). */
  readonly withLink?: boolean;
}

export interface SendQuoteResult {
  readonly status: 'SENT';
  readonly expiresAt: string;
  readonly supersededQuoteId: string | null;
  readonly linkId: string | null;
}

/**
 * `quote.send` (DRAFT → SENT) — `quote:send`, plus `quote:send_negative_margin` (⧗) with a reason when the margin is
 * negative. Refuses a stale route snapshot, supersedes a previous SENT quote of the request and fixes `expires_at`
 * from database time. The link token, when requested, is handed to `onToken` only — it is never stored in the
 * command result (which the idempotency store keeps) or in any log.
 */
export function sendQuote(actor: OperatorActor, deps: Pick<QuoteDeps, 'policy'>, onToken?: (token: string) => void) {
  const policy = policyOf(deps);
  return operatorCommand(actor, 'quote:send', async (ctx, p: SendQuotePayload): Promise<SendQuoteResult> => {
    const quoteId = requireUuid(p.quoteId, 'quoteId');
    const q0 = await ctx.tx.selectFrom('quote').select(['trade_request_id']).where('id', '=', quoteId).executeTakeFirst();
    if (!q0) throw new DomainError('NOT_FOUND', 'quote not found');
    await lockRow(ctx.tx, 'trade_request', 'trade_request', q0.trade_request_id);
    await lockRow(ctx.tx, 'quote', 'quote', quoteId);
    const quote = await ctx.tx.selectFrom('quote').selectAll().where('id', '=', quoteId).executeTakeFirstOrThrow();
    if (quote.status !== 'DRAFT') throw new DomainError('INVALID_TRANSITION', `quote is ${quote.status}`);
    const request = await ctx.tx.selectFrom('trade_request').selectAll().where('id', '=', quote.trade_request_id).executeTakeFirstOrThrow();
    if (request.status !== 'OPEN' && request.status !== 'QUOTED') throw new DomainError('REQUEST_NOT_OPEN', `request is ${request.status}`);

    if (quote.gross_margin_inr_minor < 0n) {
      await authorizeOperator(ctx.tx, actor, 'quote:send_negative_margin');
      if (!quote.negative_margin_reason) throw new DomainError('NEGATIVE_MARGIN_NOT_PERMITTED', 'a negative-margin quote needs a reason');
    }
    if (p.withLink && quote.valid_for_seconds < policy.linkMinValiditySeconds) {
      throw new DomainError('LINK_VALIDITY_TOO_SHORT', `a shareable link needs at least ${policy.linkMinValiditySeconds} seconds of validity`);
    }
    const snapshot = await ctx.tx.selectFrom('rate_snapshot').select(['effective_at']).where('id', '=', quote.route_rate_snapshot_id).executeTakeFirstOrThrow();
    const now = await businessNow(ctx.tx);
    const ageSeconds = (BigInt(now.getTime()) - BigInt(snapshot.effective_at.getTime())) / 1000n;
    if (ageSeconds > BigInt(policy.maxSnapshotAgeSeconds)) throw new DomainError('ROUTE_RATE_STALE', `route snapshot is ${ageSeconds}s old; refresh the rate`);
    await requireUsableRoute(ctx.tx, quote.route_id, quote.direction);

    const superseded = await cancelSentQuoteOfRequest(ctx, request.id, 'SUPERSEDED');
    const expiresAt = new Date(now.getTime() + quote.valid_for_seconds * 1000);
    await ctx.tx
      .updateTable('quote')
      .set({ status: 'SENT', sent_at: now, expires_at: expiresAt, sent_by: ctx.actor.id ?? 'SYSTEM' })
      .where('id', '=', quote.id)
      .execute();
    if (request.status === 'OPEN') {
      await ctx.tx.updateTable('trade_request').set({ status: 'QUOTED', last_activity_at: sql<Date>`inrp2p_now()`, version: request.version + 1 }).where('id', '=', request.id).execute();
    } else {
      await ctx.tx.updateTable('trade_request').set({ last_activity_at: sql<Date>`inrp2p_now()`, version: request.version + 1 }).where('id', '=', request.id).execute();
    }

    let linkId: string | null = null;
    if (p.withLink) {
      const token = newLinkToken();
      const link = await ctx.tx
        .insertInto('quote_link')
        .values({ quote_id: quote.id, token_hash: linkTokenHash(token), created_by: ctx.actor.id ?? 'SYSTEM' })
        .returning('id')
        .executeTakeFirstOrThrow();
      linkId = link.id;
      onToken?.(token);
      await appendAudit(ctx, { action: 'quote_link.created', entityType: 'quote_link', entityId: link.id, after: { quote_id: quote.id, valid_for_seconds: quote.valid_for_seconds } });
    }

    await appendAudit(ctx, { action: 'quote.sent', entityType: 'quote', entityId: quote.id, before: { status: 'DRAFT' }, after: { status: 'SENT', expires_at: expiresAt, superseded_quote_id: superseded, link: Boolean(linkId) } });
    await enqueueOutbox(ctx, { type: 'quote.sent', aggregateType: 'quote', aggregateId: quote.id, payload: { quoteId: quote.id, expiresAt: expiresAt.toISOString(), clientId: quote.client_id } });
    return { status: 'SENT', expiresAt: expiresAt.toISOString(), supersededQuoteId: superseded, linkId };
  });
}

/**
 * `quote_link.create` — `quote_link:create`. Attaches a link to an already SENT quote, allowed only while at least the
 * policy minimum validity remains (D-01 rev 3). The token is handed to `onToken` only.
 */
export function createQuoteLink(actor: OperatorActor, deps: Pick<QuoteDeps, 'policy'>, onToken: (token: string) => void) {
  const policy = policyOf(deps);
  return operatorCommand(actor, 'quote_link:create', async (ctx, p: { quoteId: string }) => {
    const quoteId = requireUuid(p.quoteId, 'quoteId');
    await lockRow(ctx.tx, 'quote', 'quote', quoteId);
    const quote = await ctx.tx.selectFrom('quote').select(['id', 'status', 'expires_at']).where('id', '=', quoteId).executeTakeFirstOrThrow();
    if (quote.status !== 'SENT' || !quote.expires_at) throw new DomainError('QUOTE_NOT_SENT', `quote is ${quote.status}`);
    const now = await businessNow(ctx.tx);
    const remaining = (BigInt(quote.expires_at.getTime()) - BigInt(now.getTime())) / 1000n;
    if (remaining < BigInt(policy.linkMinValiditySeconds)) {
      throw new DomainError('LINK_VALIDITY_TOO_SHORT', `only ${remaining > 0n ? remaining : 0n}s remain; a link needs at least ${policy.linkMinValiditySeconds}s`);
    }
    const existing = await ctx.tx.selectFrom('quote_link').select('id').where('quote_id', '=', quote.id).executeTakeFirst();
    if (existing) throw new DomainError('LINK_EXISTS', 'this quote already has a link');
    const token = newLinkToken();
    const link = await ctx.tx.insertInto('quote_link').values({ quote_id: quote.id, token_hash: linkTokenHash(token), created_by: ctx.actor.id ?? 'SYSTEM' }).returning('id').executeTakeFirstOrThrow();
    onToken(token);
    await appendAudit(ctx, { action: 'quote_link.created', entityType: 'quote_link', entityId: link.id, after: { quote_id: quote.id, remaining_seconds: remaining } });
    return { linkId: link.id };
  });
}

/** `quote_link.revoke` — `quote_link:revoke`. The token stops working immediately; pending challenges are closed. */
export function revokeQuoteLink(actor: OperatorActor) {
  return operatorCommand(actor, 'quote_link:revoke', async (ctx, p: { linkId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const link = await ctx.tx.selectFrom('quote_link').select(['id', 'quote_id', 'revoked_at']).where('id', '=', requireUuid(p.linkId, 'linkId')).forUpdate().executeTakeFirst();
    if (!link) throw new DomainError('NOT_FOUND', 'link not found');
    if (link.revoked_at) return { revoked: false };
    await ctx.tx.updateTable('quote_link').set({ revoked_at: sql<Date>`inrp2p_now()`, revoked_by: ctx.actor.id ?? 'SYSTEM' }).where('id', '=', link.id).execute();
    await closePendingChallenges(ctx, link.quote_id, 'SUPERSEDED', { linkId: link.id });
    await appendAudit(ctx, { action: 'quote_link.revoked', entityType: 'quote_link', entityId: link.id, after: { reason } });
    return { revoked: true };
  });
}

/** `quote.cancel` — `quote:cancel`. SENT → CANCELLED (OPERATOR) or DRAFT → CANCELLED (DISCARDED); request returns to OPEN. */
export function cancelQuote(actor: OperatorActor) {
  return operatorCommand(actor, 'quote:cancel', async (ctx, p: { quoteId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const quoteId = requireUuid(p.quoteId, 'quoteId');
    const q0 = await ctx.tx.selectFrom('quote').select(['trade_request_id']).where('id', '=', quoteId).executeTakeFirst();
    if (!q0) throw new DomainError('NOT_FOUND', 'quote not found');
    await lockRow(ctx.tx, 'trade_request', 'trade_request', q0.trade_request_id);
    await lockRow(ctx.tx, 'quote', 'quote', quoteId);
    const quote = await ctx.tx.selectFrom('quote').select(['id', 'status', 'trade_request_id']).where('id', '=', quoteId).executeTakeFirstOrThrow();
    if (quote.status !== 'SENT' && quote.status !== 'DRAFT') throw new DomainError('INVALID_TRANSITION', `quote is ${quote.status}`);
    const cancelReason = quote.status === 'DRAFT' ? 'DISCARDED' : 'OPERATOR';
    await ctx.tx.updateTable('quote').set({ status: 'CANCELLED', cancel_reason: cancelReason, closed_at: sql<Date>`inrp2p_now()` }).where('id', '=', quote.id).execute();
    await closePendingChallenges(ctx, quote.id, 'SUPERSEDED');
    if (quote.status === 'SENT') await reopenRequest(ctx, quote.trade_request_id);
    await appendAudit(ctx, { action: 'quote.cancelled', entityType: 'quote', entityId: quote.id, before: { status: quote.status }, after: { status: 'CANCELLED', reason: cancelReason, note: reason } });
    return { status: 'CANCELLED' as const, reason: cancelReason };
  });
}

/** QUOTED → OPEN when the live quote of a request ends without acceptance (STATE_MACHINES §1). */
export async function reopenRequest(ctx: TxContext, requestId: string): Promise<void> {
  const r = await ctx.tx.selectFrom('trade_request').select(['id', 'status', 'version']).where('id', '=', requestId).executeTakeFirstOrThrow();
  if (r.status !== 'QUOTED') return;
  const otherSent = await ctx.tx.selectFrom('quote').select('id').where('trade_request_id', '=', requestId).where('status', '=', 'SENT').executeTakeFirst();
  if (otherSent) return;
  await ctx.tx.updateTable('trade_request').set({ status: 'OPEN', last_activity_at: sql<Date>`inrp2p_now()`, version: r.version + 1 }).where('id', '=', requestId).execute();
  await enqueueOutbox(ctx, { type: 'desk.request_needs_action', aggregateType: 'trade_request', aggregateId: requestId, payload: { requestId } });
}
