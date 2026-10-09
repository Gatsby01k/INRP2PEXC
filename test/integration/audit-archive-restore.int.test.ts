import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { appendAudit, exportAuditSeals, sealAudit, verifyAuditArchive } from '@inrp2p/audit';
import { holdOutgoingPayments } from '@inrp2p/trades';
import { type LocalS3, startLocalS3 } from '../minio.ts';

/**
 * E4: the archive after a point-in-time restore. A database recovered to an earlier moment has forgotten the seals made
 * after it and seals again under the same numbers, while the archive keeps what the lost timeline exported. Verification
 * must still prove the restored trail from the archive, name the lost range instead of alarming forever, and the export
 * must go on — and without a recorded database change to explain it, the same divergence is a finding.
 */
let t: TestDatabase;
let s3: LocalS3;
beforeAll(async () => {
  t = await createTestDatabase('audit_archive_restore');
  s3 = await startLocalS3();
}, 180_000);
afterAll(async () => {
  await s3?.stop();
  await t?.close();
});

const actor = { type: 'USER' as const, id: randomUUID(), surface: 'OPERATOR' as const, sessionId: randomUUID() };
async function events(n: number, tag: string) {
  for (let i = 0; i < n; i++) {
    await executeCommand(t.app, { authorize: async () => {}, handle: (ctx) => appendAudit(ctx, { action: 'quote.sent', entityType: 'test_entity', entityId: `${tag}-${i}`, after: { tag, i } }) }, { name: 'test.audit', actor, payload: { tag, i }, financial: false });
  }
}
const seal = () => sealAudit(t.worker, { settleSeconds: 0 });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the seal archive across a point-in-time restore (E4)', () => {
  it('proves the restored trail from the archive, names the lost range, and keeps exporting', async () => {
    const archive = await s3.bucket('inrp2p-audit-seals');
    // The original timeline: seal 1 exported, then the moment a restore will go back to, then seal 2 exported too.
    await events(3, 'before');
    await seal();
    expect(await exportAuditSeals(t.worker, archive, { retainDays: 1 })).toMatchObject({ firstSeal: 1, lastSeal: 1 });
    await pause(50);
    const knownUntil = (await sql<{ now: Date }>`select inrp2p_now() as now`.execute(t.app)).rows[0]!.now;
    await pause(50);
    await events(2, 'lost');
    await seal();
    const lost = await exportAuditSeals(t.worker, archive, { retainDays: 1 });
    expect(lost).toMatchObject({ firstSeal: 2, lastSeal: 2 });

    // What a recovery to `knownUntil` leaves: seal 2, its events and the record of its export are gone; the archive,
    // under Object Lock, still has the range.
    await t.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      const gone = await sql<{ from_seq: string }>`select from_seq::text from audit_seal where id = 2`.execute(tx);
      await sql`delete from audit_event where seq >= ${gone.rows[0]!.from_seq}::bigint`.execute(tx);
      await sql`delete from audit_seal where id = 2`.execute(tx);
      await sql`delete from audit_seal_export where first_seal_id = 2`.execute(tx);
    });

    // Before anyone records the change, the lost range is what it looks like: the archive has a seal this database does not.
    const unexplained = await verifyAuditArchive(t.worker, archive, { record: false });
    expect(unexplained.ok).toBe(false);
    expect(unexplained.findings).toEqual(expect.arrayContaining([{ kind: 'SEAL_MISSING_HERE', seal: 2 }, { kind: 'EVENTS_DIFFER', seal: 2 }]));

    // The restore fence records the change and the moment the records were whole: the lost range is history, not a finding,
    // and the restored trail is proved from the archive up to the restore point.
    const fence = await holdOutgoingPayments(t.app, { by: 'SYSTEM:test', reason: 'recovered to an earlier moment in this test', knownUntil });
    const explained = await verifyAuditArchive(t.worker, archive);
    expect(explained).toEqual({ ok: true, archivedSeals: 1, findings: [], superseded: [{ key: lost!.key, firstSeal: 2, lastSeal: 2, divergesAt: 2, fence: fence!.ref }] });

    // The restored database seals again, with other events, under whatever number its sequence gives — a sequence does
    // not go back with a restore and may skip after a crash, so continuity is the event sequence and the hash chain, never
    // the numbers. The export writes its own range beside the lost one under its own name; both are kept.
    await events(1, 'after');
    await seal();
    const newest = await t.app.selectFrom('audit_seal').select(['id', 'from_seq']).orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(Number(newest.id)).toBeGreaterThan(2);
    const next = await exportAuditSeals(t.worker, archive, { retainDays: 1 });
    expect(next).toMatchObject({ firstSeal: Number(newest.id), lastSeal: Number(newest.id) });
    expect(next!.key).not.toBe(lost!.key);
    expect((await archive.list('audit-seals/')).length).toBe(3);
    expect(await verifyAuditArchive(t.worker, archive)).toEqual({ ok: true, archivedSeals: 2, findings: [], superseded: [{ key: lost!.key, firstSeal: 2, lastSeal: 2, divergesAt: 2, fence: fence!.ref }] });
    const row = await t.app.selectFrom('audit_archive_verification').select(['ok', 'superseded']).orderBy('ran_at', 'desc').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ ok: true, superseded: [{ key: lost!.key, fence: fence!.ref }] });
  });
});
