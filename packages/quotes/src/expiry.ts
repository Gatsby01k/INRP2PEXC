import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { requireUuid } from '@inrp2p/kernel';
import type { Db, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { executeCommand } from '@inrp2p/commands';
import { lockRow } from './actors.ts';
import { closePendingChallenges } from './challenges.ts';
import { type QuoteDeps, policyOf } from './policy.ts';
import { reopenRequest } from './quotes.ts';
import { expireInactiveRequests } from './requests.ts';
import { businessNow, pruneRateLimitCounters } from './security.ts';

/**
 * SENT → EXPIRED (STATE_MACHINES §2). Idempotent and safe to run early: the transition happens only when database
 * time has actually passed `expires_at`, so a job that fires a moment early simply does nothing and is retried.
 * Expiry never depends on the job: acceptance is judged against `expires_at` at decision time (FI-04).
 */
export async function expireQuoteInTx(ctx: TxContext, quoteId: string): Promise<boolean> {
  const id = requireUuid(quoteId, 'quoteId');
  const q0 = await ctx.tx.selectFrom('quote').select(['trade_request_id']).where('id', '=', id).executeTakeFirst();
  if (!q0) return false;
  await lockRow(ctx.tx, 'trade_request', 'trade_request', q0.trade_request_id);
  await lockRow(ctx.tx, 'quote', 'quote', id);
  const quote = await ctx.tx.selectFrom('quote').select(['id', 'status', 'expires_at', 'client_id', 'trade_request_id']).where('id', '=', id).executeTakeFirstOrThrow();
  if (quote.status !== 'SENT' || !quote.expires_at) return false;
  const now = await businessNow(ctx.tx);
  if (now < quote.expires_at) return false;

  await ctx.tx.updateTable('quote').set({ status: 'EXPIRED', closed_at: sql<Date>`inrp2p_now()` }).where('id', '=', quote.id).execute();
  await closePendingChallenges(ctx, quote.id, 'EXPIRED');
  await reopenRequest(ctx, quote.trade_request_id);
  await appendAudit(ctx, { action: 'quote.expired', entityType: 'quote', entityId: quote.id, before: { status: 'SENT' }, after: { status: 'EXPIRED', expires_at: quote.expires_at } });
  await enqueueOutbox(ctx, { type: 'client.quote_expired', aggregateType: 'quote', aggregateId: quote.id, payload: { quoteId: quote.id, clientId: quote.client_id } });
  return true;
}

/** System command wrapper for the scheduled `quote_expire` job. */
export async function expireQuote(db: Db, quoteId: string): Promise<boolean> {
  const key = randomUUID();
  const out = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => expireQuoteInTx(ctx, quoteId) }, {
    name: 'quote.expire',
    actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' },
    payload: { quoteId, run: key },
    idempotencyKey: key,
    financial: false,
  });
  return out.result;
}

/** Safety net for quotes whose scheduled job was lost: ids of SENT quotes already past their expiry. */
export async function dueQuoteIds(db: Db, limit = 100): Promise<string[]> {
  const r = await sql<{ id: string }>`
    select id from quote
    where status = 'SENT' and expires_at <= inrp2p_now()
    order by expires_at, id limit ${limit}`.execute(db);
  return r.rows.map((row) => row.id);
}

export interface ExpirySweepReport {
  readonly quotes: number;
  readonly requests: number;
  readonly prunedRateLimits: bigint;
}

/**
 * Periodic sweep: expire overdue quotes (one transaction each, so the global lock order holds), expire inactive
 * OPEN requests and prune spent rate-limit windows.
 */
export async function runExpirySweep(db: Db, deps: Pick<QuoteDeps, 'policy'>, limit = 100): Promise<ExpirySweepReport> {
  let quotes = 0;
  for (const id of await dueQuoteIds(db, limit)) {
    if (await expireQuote(db, id)) quotes++;
  }
  const key = randomUUID();
  const requests = await executeCommand(db, {
    authorize: async () => {},
    handle: async (ctx) => (await expireInactiveRequests(ctx, { policy: policyOf(deps) }, limit)).length,
  }, { name: 'request.expire_inactive', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { run: key }, idempotencyKey: key, financial: false });
  const prunedRateLimits = await pruneRateLimitCounters(db);
  return { quotes, requests: requests.result, prunedRateLimits };
}
