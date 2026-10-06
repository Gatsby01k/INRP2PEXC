import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { appendAudit, exportAuditSeals, sealAudit, sealExportKey, verifyAuditArchive, verifyAuditSeals } from '@inrp2p/audit';
import { type LocalS3, startLocalS3 } from '../minio.ts';

/**
 * E4 (TD-17): the audit seals leave the database for write-once storage, and the archive — not the database's own seal
 * table — is what the trail is checked against: a missing range, a changed seal, and audit events changed and then
 * re-sealed so that the database agrees with itself are all found.
 */
let t: TestDatabase;
let s3: LocalS3;
beforeAll(async () => {
  t = await createTestDatabase('audit_archive');
  s3 = await startLocalS3();
}, 180_000);
afterAll(async () => {
  await s3?.stop();
  await t?.close();
});

const actor = { type: 'USER' as const, id: randomUUID(), surface: 'OPERATOR' as const, sessionId: randomUUID() };
async function events(n: number, action = 'quote.sent') {
  for (let i = 0; i < n; i++) {
    await executeCommand(t.app, { authorize: async () => {}, handle: (ctx) => appendAudit(ctx, { action, entityType: 'test_entity', entityId: String(i), after: { i } }) }, { name: 'test.audit', actor, payload: { i }, financial: false });
  }
}

describe('the audit seal archive (E4, TD-17)', () => {
  it('exports contiguous ranges under Object Lock, and the archive verifies against the seals and the events', async () => {
    const archive = await s3.bucket('inrp2p-audit-seals');
    expect(await exportAuditSeals(t.worker, archive, { retainDays: 1 })).toBeNull();
    await events(4);
    await sealAudit(t.worker, { settleSeconds: 0 });
    await events(3);
    await sealAudit(t.worker, { settleSeconds: 0 });
    const first = await exportAuditSeals(t.worker, archive, { retainDays: 1 });
    expect(first).toEqual({ firstSeal: 1, lastSeal: 2, key: sealExportKey(1, 2) });
    expect(await exportAuditSeals(t.worker, archive, { retainDays: 1 })).toBeNull();
    await events(2);
    await sealAudit(t.worker, { settleSeconds: 0 });
    expect(await exportAuditSeals(t.worker, archive, { retainDays: 1 })).toMatchObject({ firstSeal: 3, lastSeal: 3 });
    expect(await archive.list('audit-seals/')).toEqual([sealExportKey(1, 2), sealExportKey(3, 3)]);

    // A run that wrote its range and stopped before recording it: the next run records that object as it is, once,
    // instead of writing a second range over the same seals.
    await events(1);
    await sealAudit(t.worker, { settleSeconds: 0 });
    await writeRange(archive, 4, 4);
    expect(await exportAuditSeals(t.worker, archive, { retainDays: 1 })).toEqual({ firstSeal: 4, lastSeal: 4, key: sealExportKey(4, 4), adopted: true });
    expect(await exportAuditSeals(t.worker, archive, { retainDays: 1 })).toBeNull();
    expect(await archive.list('audit-seals/')).toEqual([sealExportKey(1, 2), sealExportKey(3, 3), sealExportKey(4, 4)]);
    const adopted = await t.app.selectFrom('audit_seal_export').select('retain_until').where('first_seal_id', '=', 4n).executeTakeFirstOrThrow();
    expect(adopted.retain_until.getTime(), 'the lock as the store reports it').toBeGreaterThan(Date.now() + 3_600_000);

    const verified = await verifyAuditArchive(t.worker, archive);
    expect(verified).toEqual({ ok: true, archivedSeals: 4, findings: [] });
    const recorded = await t.app.selectFrom('audit_archive_verification').select(['ok', 'archived_seals']).orderBy('ran_at', 'desc').executeTakeFirstOrThrow();
    expect(recorded).toEqual({ ok: true, archived_seals: 4 });

    // The export is locked: not even the bucket's own credentials remove it.
    const exported = await t.app.selectFrom('audit_seal_export').select(['object_key', 'version_id']).where('first_seal_id', '=', 1n).executeTakeFirstOrThrow();
    expect((await s3.raw('DELETE', `/inrp2p-audit-seals/${exported.object_key}?versionId=${encodeURIComponent(exported.version_id!)}`)).status).toBeGreaterThanOrEqual(400);

    // An unrecorded object that does not describe the seals here is neither recorded nor written over.
    await events(1);
    await sealAudit(t.worker, { settleSeconds: 0 });
    await writeRange(archive, 5, 5, { forge: true });
    await expect(exportAuditSeals(t.worker, archive, { retainDays: 1 })).rejects.toThrow(/does not describe the seals/);
    const last = await t.app.selectFrom('audit_seal_export').select((eb) => eb.fn.max('last_seal_id').as('m')).executeTakeFirstOrThrow();
    expect(last.m).toBe(4n);
  });

  it('finds audit events changed and re-sealed so that the database agrees with itself', async () => {
    // A second archive holding every seal so far as one range, written before anything is touched.
    const archive = await s3.bucket('inrp2p-audit-seals-2');
    await writeRange(archive, 1, 3);
    expect((await verifyAuditArchive(t.worker, archive, { record: false })).ok).toBe(true);

    // Someone with the database's keys rewrites an event in sealed range 1 and recomputes every seal after it.
    const target = (await t.app.selectFrom('audit_seal').select(['from_seq']).where('id', '=', 1n).executeTakeFirstOrThrow()).from_seq;
    await t.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      await sql`update audit_event set after = '{"i": "rewritten"}'::jsonb where seq = ${target}`.execute(tx);
      const seals = await sql<{ id: string; from_seq: string; to_seq: string }>`select id::text, from_seq::text, to_seq::text from audit_seal order by id`.execute(tx);
      let prev: string | null = null;
      for (const seal of seals.rows) {
        const h = await sql<{ hash: string }>`select inrp2p_audit_range_hash(${prev}, ${seal.from_seq}::bigint, ${seal.to_seq}::bigint) as hash`.execute(tx);
        await sql`update audit_seal set prev_seal_hash = ${prev}, seal_hash = ${h.rows[0]!.hash} where id = ${seal.id}::bigint`.execute(tx);
        prev = h.rows[0]!.hash;
      }
    });
    // The database alone is satisfied …
    expect((await verifyAuditSeals(t.worker)).ok).toBe(true);
    // … the archive is not: the seals differ from what was exported, and the events no longer hash to the archived seals.
    const v = await verifyAuditArchive(t.worker, archive, { record: false });
    expect(v.ok).toBe(false);
    expect(v.findings).toEqual(expect.arrayContaining([{ kind: 'SEAL_DIFFERS', seal: 1 }, { kind: 'EVENTS_DIFFER', seal: 1 }]));
  });

  it('finds a range missing from the archive, and the database refuses to record one (IX099)', async () => {
    // An archive that holds only a later range: the first one never reached it.
    const archive = await s3.bucket('inrp2p-audit-seals-3');
    await writeRange(archive, 3, 3);
    const v = await verifyAuditArchive(t.worker, archive, { record: false });
    expect(v.findings).toEqual(expect.arrayContaining([{ kind: 'GAP', after: 0, next: 3 }]));

    // Recorded exports end at seal 4; a record starting at 6 would leave 5 unproved.
    await expect(sql`insert into audit_seal_export (first_seal_id, last_seal_id, from_seq, to_seq, seal_count, last_seal_hash, bucket, object_key, sha256, retain_until)
                     values (6, 6, 1, 1, 1, ${'a'.repeat(64)}, 'b', ${sealExportKey(6, 6)}, ${'b'.repeat(64)}, now())`.execute(t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX099');
  });
});

/**
 * Writes seals `first`–`last`, as they are in the database now, as one archived range (the export's own format) — what
 * a run that stopped before recording its export leaves behind. `forge` changes the last seal's hash.
 */
async function writeRange(archive: Awaited<ReturnType<LocalS3['bucket']>>, first: number, last: number, opts: { forge?: boolean } = {}): Promise<void> {
  const seals = await t.app.selectFrom('audit_seal').select(['id', 'from_seq', 'to_seq', 'event_count', 'prev_seal_hash', 'seal_hash', 'sealed_at'])
    .where('id', '>=', BigInt(first)).where('id', '<=', BigInt(last)).orderBy('id').execute();
  const doc = {
    schema: 'inrp2p.audit-seal-export.v1',
    range: { firstSeal: first, lastSeal: last, fromSeq: String(seals[0]!.from_seq), toSeq: String(seals.at(-1)!.to_seq) },
    continues: { seal: first - 1, sealHash: seals[0]!.prev_seal_hash },
    seals: seals.map((x, i) => ({
      id: Number(x.id), fromSeq: String(x.from_seq), toSeq: String(x.to_seq), eventCount: String(x.event_count), prevSealHash: x.prev_seal_hash,
      sealHash: opts.forge && i === seals.length - 1 ? 'f'.repeat(64) : x.seal_hash, sealedAt: x.sealed_at.toISOString(),
    })),
  };
  await archive.putOnce(sealExportKey(first, last), Buffer.from(`${JSON.stringify(doc)}\n`), { contentType: 'application/json', retainUntil: new Date(Date.now() + 86_400_000) });
}
