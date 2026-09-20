import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { Executor } from '@inrp2p/db';
import { sha256Hex } from '@inrp2p/commands';

/**
 * The rate limiter itself lives in `@inrp2p/commands`, next to the pipeline that applies it to every financial
 * mutation. It is re-exported here because the link flow is where most of its buckets are used, and because
 * moving a name out of a package's public surface is a change nobody asked for.
 */
export { hitRateLimit, pruneRateLimitCounters, sha256Hex } from '@inrp2p/commands';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

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

/** Business clock (migration 0012). */
export async function businessNow(ex: Executor): Promise<Date> {
  const r = await sql<{ now: Date }>`select inrp2p_now() as now`.execute(ex);
  return r.rows[0]!.now;
}

export function maskEmailAddress(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}
