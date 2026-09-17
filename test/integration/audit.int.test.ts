import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { appendAudit, sealAudit, verifyAuditSeals } from '@inrp2p/audit';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('audit');
});
afterAll(async () => t.close());

const actor = { type: 'USER' as const, id: randomUUID(), surface: 'OPERATOR' as const, sessionId: randomUUID() };

async function audited(action: string, after: unknown) {
  await executeCommand(t.app, { authorize: async () => {}, handle: (ctx) => appendAudit(ctx, { action, entityType: 'test_entity', entityId: '1', after }) }, { name: 'test.audit', actor, payload: { action }, financial: false });
}

describe('append-only audit (FI-51)', () => {
  it('writes redacted events with actor, correlation and session', async () => {
    await audited('rate.changed', { utr: 'UTR1234567890' });
    const row = await t.app.selectFrom('audit_event').selectAll().orderBy('seq', 'desc').limit(1).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ action: 'rate.changed', actor_id: actor.id, surface: 'OPERATOR', session_id: actor.sessionId });
    expect(row.after).toEqual({ utr: '••••7890' });
  });

  it('rejects UPDATE, DELETE and TRUNCATE at the database, even for the owner', async () => {
    await expect(sql`update audit_event set action = 'x.y'`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`delete from audit_event`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`truncate audit_event`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
    await expect(sql`update audit_event set action = 'x.y'`.execute(t.app)).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    await expect(sql`delete from audit_seal`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
  });

  it('audit rows roll back with a failed command (no audit without state, no state without audit)', async () => {
    const before = await t.app.selectFrom('audit_event').select(sql<bigint>`count(*)`.as('n')).executeTakeFirstOrThrow();
    await expect(
      executeCommand(t.app, {
        authorize: async () => {},
        handle: async (ctx) => {
          await appendAudit(ctx, { action: 'trade.cancelled', entityType: 'trade', entityId: 'x' });
          throw new Error('boom after audit');
        },
      }, { name: 'test.audit_fail', actor, payload: {}, financial: false }),
    ).rejects.toThrow('boom');
    const after = await t.app.selectFrom('audit_event').select(sql<bigint>`count(*)`.as('n')).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });

  it('seals contiguous ranges in a hash chain and detects silent tampering', async () => {
    for (let i = 0; i < 5; i++) await audited('quote.sent', { i });
    const s1 = await sealAudit(t.worker, { settleSeconds: 0 });
    expect(s1.sealed).toBe(true);
    await audited('quote.accepted', { i: 99 });
    const s2 = await sealAudit(t.worker, { settleSeconds: 0 });
    expect(s2.fromSeq).toBe(s1.toSeq! + 1n);
    expect(await verifyAuditSeals(t.app)).toEqual({ ok: true, checkedSeals: 2 });

    // Simulate a superuser bypassing triggers to silently edit history.
    await t.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`update audit_event set after = '{"i": 1000}'::jsonb where seq = ${s1.fromSeq!}`.execute(tx);
    });
    const v = await verifyAuditSeals(t.app);
    expect(v.ok).toBe(false);
  });

  it('refuses non-contiguous or unchained seals', async () => {
    await expect(sql`insert into audit_seal (from_seq, to_seq, event_count, prev_seal_hash, seal_hash) values (100000, 100001, 2, null, ${'0'.repeat(64)})`.execute(t.worker))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX002');
  });
});
