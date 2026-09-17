import { sql } from 'kysely';
import { DomainError, Money, Rate, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { DirectionValue, FixedSideValue, Tx, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { requireActiveClient } from '@inrp2p/clients';
import { type QuoteActor, lockRow, operatorOrMemberCommand } from './actors.ts';
import { type QuoteDeps, policyOf } from './policy.ts';
import { closePendingChallenges } from './challenges.ts';

export interface CreateRequestPayload {
  readonly clientId: string;
  readonly direction: DirectionValue;
  readonly fixedSide: FixedSideValue;
  /** Decimal string in USDT (BASE) or INR (QUOTE). */
  readonly amount: string;
  readonly targetRate?: string | null;
  /** SELL: INR destination. */
  readonly bankAccountId?: string | null;
  /** BUY: USDT destination. */
  readonly walletId?: string | null;
  /** SELL: optional expected sender (checked later, never used for attribution — D-02). */
  readonly sourceWalletId?: string | null;
}

/**
 * `request.create` (STATE_MACHINES §1 create → OPEN): client user of the client (app) or operator `request:create`.
 * Destination must be ACTIVE and owned by the client; amount within policy; direction enabled.
 */
export function createRequest(actor: QuoteActor, deps: Pick<QuoteDeps, 'policy'>) {
  const policy = policyOf(deps);
  return operatorOrMemberCommand(actor, 'request:create', async (_ctx, p: CreateRequestPayload) => requireUuid(p.clientId, 'clientId'), async (ctx, p, clientId) => {
    const client = await requireActiveClient(ctx.tx, clientId);
    const direction = requireOneOf(p.direction, 'direction', ['SELL_USDT', 'BUY_USDT'] as const);
    if (!policy.enabledDirections.includes(direction)) throw new DomainError('DIRECTION_DISABLED', `${direction} is not enabled`);
    const fixedSide = requireOneOf(p.fixedSide, 'fixedSide', ['BASE', 'QUOTE'] as const);
    const amount = fixedSide === 'BASE' ? Money.parse(p.amount, 'USDT') : Money.parse(p.amount, 'INR');
    if (!amount.isPositive()) throw new DomainError('INVALID_AMOUNT', 'amount must be positive');
    const max = fixedSide === 'BASE' ? Money.parse(policy.maxBaseUsdt, 'USDT') : Money.parse(policy.maxQuoteInr, 'INR');
    if (amount.minor > max.minor) throw new DomainError('AMOUNT_ABOVE_LIMIT', `amount exceeds ${max.toString()}`);
    const target = p.targetRate ? Rate.parse(p.targetRate, 'CLIENT') : null;

    let bankAccountId: string | null = null;
    let walletId: string | null = null;
    let sourceWalletId: string | null = null;
    if (direction === 'SELL_USDT') {
      bankAccountId = requireUuid(p.bankAccountId, 'bankAccountId');
      const b = await ctx.tx.selectFrom('bank_account').select(['client_id', 'status']).where('id', '=', bankAccountId).forShare().executeTakeFirst();
      if (!b || b.client_id !== client.id || b.status !== 'ACTIVE') throw new DomainError('DESTINATION_INVALID', 'bank account must be ACTIVE and belong to the client');
      if (p.sourceWalletId) {
        sourceWalletId = requireUuid(p.sourceWalletId, 'sourceWalletId');
        const w = await ctx.tx.selectFrom('crypto_wallet').select(['client_id', 'status', 'purpose']).where('id', '=', sourceWalletId).executeTakeFirst();
        if (!w || w.client_id !== client.id || w.status !== 'ACTIVE' || w.purpose === 'DESTINATION') throw new DomainError('DESTINATION_INVALID', 'source wallet must be an ACTIVE source wallet of the client');
      }
    } else {
      walletId = requireUuid(p.walletId, 'walletId');
      const w = await ctx.tx.selectFrom('crypto_wallet').select(['client_id', 'status', 'purpose']).where('id', '=', walletId).forShare().executeTakeFirst();
      if (!w || w.client_id !== client.id || w.status !== 'ACTIVE' || w.purpose === 'SOURCE') throw new DomainError('DESTINATION_INVALID', 'wallet must be an ACTIVE destination wallet of the client');
    }

    const row = await ctx.tx
      .insertInto('trade_request')
      .values({
        client_id: client.id,
        direction,
        fixed_side: fixedSide,
        requested_base_minor: fixedSide === 'BASE' ? amount.minor : null,
        requested_quote_minor: fixedSide === 'QUOTE' ? amount.minor : null,
        target_rate_micro: target?.micro ?? null,
        bank_account_id: bankAccountId,
        crypto_wallet_id: walletId,
        source_wallet_id: sourceWalletId,
        channel: actor.kind === 'OPERATOR' ? 'OPERATOR' : 'CLIENT_APP',
        created_by: ctx.actor.id ?? 'SYSTEM',
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'request.created', entityType: 'trade_request', entityId: row.id, after: { ref: row.ref, client_id: client.id, direction, fixed_side: fixedSide, amount, target_rate: target, channel: actor.kind } });
    await enqueueOutbox(ctx, { type: 'desk.new_request', aggregateType: 'trade_request', aggregateId: row.id, payload: { requestId: row.id, ref: row.ref } });
    return { requestId: row.id, ref: row.ref };
  });
}

async function requestClient(ctx: TxContext, requestId: string): Promise<string> {
  const r = await ctx.tx.selectFrom('trade_request').select('client_id').where('id', '=', requireUuid(requestId, 'requestId')).executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'request not found');
  return r.client_id;
}

/** Cancels the SENT quote of a request (if any) with a reason, closing its challenges. Caller holds the request lock. */
export async function cancelSentQuoteOfRequest(ctx: TxContext, requestId: string, reason: 'SUPERSEDED' | 'DECLINED_BY_DESK' | 'WITHDRAWN' | 'OPERATOR'): Promise<string | null> {
  const sent = await ctx.tx.selectFrom('quote').select('id').where('trade_request_id', '=', requestId).where('status', '=', 'SENT').executeTakeFirst();
  if (!sent) return null;
  await lockRow(ctx.tx, 'quote', 'quote', sent.id);
  await ctx.tx.updateTable('quote').set({ status: 'CANCELLED', cancel_reason: reason, closed_at: sql<Date>`inrp2p_now()` }).where('id', '=', sent.id).execute();
  await closePendingChallenges(ctx, sent.id, 'SUPERSEDED');
  await appendAudit(ctx, { action: 'quote.cancelled', entityType: 'quote', entityId: sent.id, before: { status: 'SENT' }, after: { status: 'CANCELLED', reason } });
  return sent.id;
}

async function closeRequest(tx: Tx, requestId: string, status: 'DECLINED' | 'WITHDRAWN' | 'EXPIRED', reason: string | null, version: number): Promise<void> {
  await tx
    .updateTable('trade_request')
    .set({ status, status_reason: reason, closed_at: sql<Date>`inrp2p_now()`, last_activity_at: sql<Date>`inrp2p_now()`, version: version + 1 })
    .where('id', '=', requestId)
    .execute();
}

/** `request.decline` — `request:decline` + reason. Cancels a SENT quote (DECLINED_BY_DESK) and notifies the client. */
export function declineRequest(actor: OperatorActor) {
  return operatorCommand(actor, 'request:decline', async (ctx, p: { requestId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    await lockRow(ctx.tx, 'trade_request', 'trade_request', requireUuid(p.requestId, 'requestId'));
    const r = await ctx.tx.selectFrom('trade_request').select(['id', 'status', 'version', 'client_id']).where('id', '=', p.requestId).executeTakeFirstOrThrow();
    if (r.status !== 'OPEN' && r.status !== 'QUOTED') throw new DomainError('REQUEST_NOT_OPEN', `request is ${r.status}`);
    await cancelSentQuoteOfRequest(ctx, r.id, 'DECLINED_BY_DESK');
    await closeRequest(ctx.tx, r.id, 'DECLINED', reason, r.version);
    await appendAudit(ctx, { action: 'request.declined', entityType: 'trade_request', entityId: r.id, before: { status: r.status }, after: { status: 'DECLINED', reason } });
    await enqueueOutbox(ctx, { type: 'client.request_declined', aggregateType: 'trade_request', aggregateId: r.id, payload: { requestId: r.id, clientId: r.client_id } });
    return { status: 'DECLINED' as const };
  });
}

/** `request.withdraw` — client user of the client, or operator `request:withdraw`. Cancels a SENT quote (WITHDRAWN). */
export function withdrawRequest(actor: QuoteActor) {
  return operatorOrMemberCommand(actor, 'request:withdraw', (ctx, p: { requestId: string; reason?: string | null }) => requestClient(ctx, p.requestId), async (ctx, p) => {
    await lockRow(ctx.tx, 'trade_request', 'trade_request', p.requestId);
    const r = await ctx.tx.selectFrom('trade_request').select(['id', 'status', 'version']).where('id', '=', p.requestId).executeTakeFirstOrThrow();
    if (r.status !== 'OPEN' && r.status !== 'QUOTED') throw new DomainError('REQUEST_NOT_OPEN', `request is ${r.status}`);
    const reason = typeof p.reason === 'string' && p.reason.trim() ? p.reason.trim().slice(0, 500) : null;
    await cancelSentQuoteOfRequest(ctx, r.id, 'WITHDRAWN');
    await closeRequest(ctx.tx, r.id, 'WITHDRAWN', reason, r.version);
    await appendAudit(ctx, { action: 'request.withdrawn', entityType: 'trade_request', entityId: r.id, before: { status: r.status }, after: { status: 'WITHDRAWN', reason, by: actor.kind } });
    return { status: 'WITHDRAWN' as const };
  });
}

/** Job step: OPEN requests with no activity for the TTL expire (STATE_MACHINES §1). Returns expired ids. */
export async function expireInactiveRequests(ctx: TxContext, deps: Pick<QuoteDeps, 'policy'>, limit = 200): Promise<string[]> {
  const ttl = policyOf(deps).requestTtlSeconds;
  const due = await sql<{ id: string }>`
    select id from trade_request
    where status = 'OPEN' and last_activity_at <= inrp2p_now() - make_interval(secs => ${ttl})
    order by last_activity_at, id limit ${limit}
    for update skip locked`.execute(ctx.tx);
  for (const { id } of due.rows) {
    const r = await ctx.tx.selectFrom('trade_request').select(['version']).where('id', '=', id).executeTakeFirstOrThrow();
    await closeRequest(ctx.tx, id, 'EXPIRED', 'no activity', r.version);
    await appendAudit(ctx, { action: 'request.expired', entityType: 'trade_request', entityId: id, before: { status: 'OPEN' }, after: { status: 'EXPIRED' } });
  }
  return due.rows.map((r) => r.id);
}
