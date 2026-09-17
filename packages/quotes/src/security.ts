import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db, Executor } from '@inrp2p/db';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** 128-bit CSPRNG token, base62, exactly 22 characters (SECURITY §2.3). */
export function newLinkToken(): string {
  let n = BigInt(`0x${randomBytes(16).toString('hex')}`);
  let out = '';
  for (let i = 0; i < 22; i++) {
    out = BASE62[parseInt((n % 62n).toString(), 10)]! + out;
    n /= 62n;
  }
  return out;
}

/**
 * Token → stored hash. Every token, well-formed or not, is hashed the same way before any lookup, so response
 * time does not depend on how close a guess is; the stored hash is then compared in constant time.
 */
export function linkTokenHash(token: unknown): string {
  return sha256Hex(typeof token === 'string' ? token : '');
}

export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length === 32 && timingSafeEqual(x, y);
}

/** Six-digit code, CSPRNG, uniform over 000000–999999. */
export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function newOtpSalt(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Fixed-window rate limiter. Runs in its own transaction and commits even when the calling operation fails, so
 * failed attempts count. `subject` must already be non-identifying (hash of IP or token).
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

/** Business clock (migration 0012). */
export async function businessNow(ex: Executor): Promise<Date> {
  const r = await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex);
  return r.rows[0]!.now;
}

export function maskEmailAddress(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}
