import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isDomainError } from '@inrp2p/kernel';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { FINANCIAL_MUTATIONS_PER_USER_PER_MINUTE, hitRateLimit, limitFinancialMutations, pruneRateLimitCounters } from '../src/index.ts';

/**
 * The rate limiter, tested as the control it is (SECURITY §7).
 *
 * Three properties matter, and only the first is obvious:
 *   1. The limit refuses the request after the limit, not before and not two later.
 *   2. Refusals count. A limiter that counts only successes is no limiter at all — every attempt an attacker
 *      makes fails by definition, so it would let them try forever.
 *   3. Subjects are independent, and the table holds no identifier that could be read back.
 */
let t: TestDatabase;
// The application's own role, not the owner's: the limiter runs with exactly the grants the app has.
const db = () => t.app;

beforeAll(async () => {
  t = await createTestDatabase('commands_rate_limit');
});
afterAll(async () => t.close());

const refuses = async (fn: () => Promise<void>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (e) {
    if (isDomainError(e) && e.code === 'RATE_LIMITED') return true;
    throw e;
  }
};

describe('a fixed window', () => {
  it('allows exactly the limit and refuses the next one', async () => {
    const subject = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_exact', subject, limit: 5, windowSeconds: 60 })), `attempt ${i + 1}`).toBe(false);
    }
    expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_exact', subject, limit: 5, windowSeconds: 60 }))).toBe(true);
    // And keeps refusing, rather than letting one through every other time.
    expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_exact', subject, limit: 5, windowSeconds: 60 }))).toBe(true);
  });

  it('counts the refusals too', async () => {
    const subject = randomUUID();
    await hitRateLimit(db(), { bucket: 'test_refusals', subject, limit: 1, windowSeconds: 60 });
    for (let i = 0; i < 3; i += 1) await refuses(() => hitRateLimit(db(), { bucket: 'test_refusals', subject, limit: 1, windowSeconds: 60 }));
    const row = await sql<{ hits: number }>`select hits from rate_limit_counter where bucket like 'test_refusals:%'`.execute(db());
    expect(row.rows[0]!.hits).toBe(4);
  });

  it('keeps one subject’s attempts away from another’s, and one bucket from another', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await hitRateLimit(db(), { bucket: 'test_isolation', subject: mine, limit: 1, windowSeconds: 60 });
    expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_isolation', subject: mine, limit: 1, windowSeconds: 60 }))).toBe(true);
    // A different person is unaffected by mine, and so is the same person in a different bucket.
    expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_isolation', subject: theirs, limit: 1, windowSeconds: 60 }))).toBe(false);
    expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_other_bucket', subject: mine, limit: 1, windowSeconds: 60 }))).toBe(false);
  });

  it('stores no identifier, only a hash of one', async () => {
    const subject = 'user-0198-very-identifiable';
    await hitRateLimit(db(), { bucket: 'test_hashing', subject, limit: 5, windowSeconds: 60 });
    const rows = await sql<{ bucket: string }>`select bucket from rate_limit_counter where bucket like 'test_hashing:%'`.execute(db());
    expect(rows.rows[0]!.bucket).not.toContain(subject);
    expect(rows.rows[0]!.bucket).toMatch(/^test_hashing:[0-9a-f]{64}$/);
  });

  it('separates windows, so a limit is per window rather than forever', async () => {
    const subject = randomUUID();
    // A one-second window: the second call lands in the next window and is allowed.
    await hitRateLimit(db(), { bucket: 'test_window', subject, limit: 1, windowSeconds: 1 });
    expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_window', subject, limit: 1, windowSeconds: 1 }))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await refuses(() => hitRateLimit(db(), { bucket: 'test_window', subject, limit: 1, windowSeconds: 1 }))).toBe(false);
  });

  it('prunes windows older than a day, and leaves today’s alone', async () => {
    // The bucket column is constrained to `name:sha256`, so a fixture row has to look like a real one.
    const stale = `test_stale:${'a'.repeat(64)}`;
    await sql`insert into rate_limit_counter (bucket, window_start, hits) values (${stale}, statement_timestamp() - interval '2 days', 1)`.execute(db());
    const before = await sql<{ n: string }>`select count(*)::text as n from rate_limit_counter`.execute(db());
    const pruned = await pruneRateLimitCounters(t.worker);
    expect(pruned).toBeGreaterThanOrEqual(1n);
    const after = await sql<{ n: string }>`select count(*)::text as n from rate_limit_counter`.execute(db());
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) - Number(pruned));
    expect(Number(after.rows[0]!.n)).toBeGreaterThan(0);
  });
});

describe('the ceiling on one person moving money (SECURITY §7)', () => {
  it('is sixty a minute, and the sixty-first is refused', async () => {
    const actor = { type: 'USER', id: randomUUID() };
    expect(FINANCIAL_MUTATIONS_PER_USER_PER_MINUTE).toBe(60);
    for (let i = 0; i < FINANCIAL_MUTATIONS_PER_USER_PER_MINUTE; i += 1) {
      expect(await refuses(() => limitFinancialMutations(db(), actor)), `mutation ${i + 1}`).toBe(false);
    }
    expect(await refuses(() => limitFinancialMutations(db(), actor))).toBe(true);
  });

  it('does not throttle the system’s own work', async () => {
    // The worker and the scanner move money on schedules this product set for itself. Throttling them would
    // mean the outbox falling behind precisely when it has the most to do.
    const system = { type: 'SYSTEM', id: null };
    for (let i = 0; i < FINANCIAL_MUTATIONS_PER_USER_PER_MINUTE + 5; i += 1) {
      expect(await refuses(() => limitFinancialMutations(db(), system))).toBe(false);
    }
  });
});
