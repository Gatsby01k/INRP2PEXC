import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db, Executor } from '@inrp2p/db';

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Fixed-window rate limiter (SECURITY §7).
 *
 * It runs in **its own transaction** and commits whether or not the operation that called it succeeds, which is
 * the whole point: a limiter whose count rolls back with the failed attempt counts only successes, and an
 * attacker's attempts all fail by definition.
 *
 * `subject` must already be non-identifying — a hash of an IP, a token or a user id. The bucket key is hashed
 * again here so the table never holds an address even if a caller forgets.
 */
export async function hitRateLimit(db: Db, input: { bucket: string; subject: string; limit: number; windowSeconds: number }): Promise<void> {
  const key = `${input.bucket}:${sha256Hex(input.subject)}`;
  const r = await sql<{ hits: number }>`
    insert into rate_limit_counter (bucket, window_start, hits)
    values (${key}, to_timestamp(floor(extract(epoch from statement_timestamp()) / ${input.windowSeconds}) * ${input.windowSeconds}), 1)
    on conflict (bucket, window_start) do update set hits = rate_limit_counter.hits + 1
    returning hits`.execute(db);
  if (r.rows[0]!.hits > input.limit) {
    throw new DomainError('RATE_LIMITED', 'too many requests, try again later', { bucket: input.bucket, retryAfterSeconds: input.windowSeconds });
  }
}

/** Worker maintenance: drop windows older than a day. */
export async function pruneRateLimitCounters(ex: Executor): Promise<bigint> {
  const r = await sql`delete from rate_limit_counter where window_start < statement_timestamp() - interval '1 day'`.execute(ex);
  return r.numAffectedRows ?? 0n;
}

/**
 * Financial mutations per user per minute (SECURITY §7).
 *
 * The number is a ceiling on a human being, not on the system: a dealer working flat out confirms a payout
 * every few seconds, and sixty in a minute is already several times that. What it actually bounds is a
 * compromised session or a loop with a bug in it, which is exactly the case where the trade log fills up faster
 * than anyone can read it.
 *
 * It is a constant rather than configuration on purpose. A limit an environment variable can raise is a limit
 * that is raised at 3am during an incident and never put back.
 */
export const FINANCIAL_MUTATIONS_PER_USER_PER_MINUTE = 60;

/**
 * Applies that ceiling to one actor. Only a **user** is limited: a `SYSTEM` actor is this product's own worker
 * running jobs it scheduled, and throttling it would mean the outbox falling behind whenever it had work to do.
 */
export async function limitFinancialMutations(db: Db, actor: { type: string; id?: string | null }): Promise<void> {
  if (actor.type !== 'USER' || !actor.id) return;
  await hitRateLimit(db, {
    bucket: 'financial_user',
    subject: actor.id,
    limit: FINANCIAL_MUTATIONS_PER_USER_PER_MINUTE,
    windowSeconds: 60,
  });
}
