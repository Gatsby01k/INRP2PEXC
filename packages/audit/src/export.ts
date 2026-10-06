import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';

/**
 * Audit seals exported off the database (production task E4, TD-17; SECURITY §8; migration 0034).
 *
 * The hourly seals chain the audit trail, but every copy of that chain lived in the database it attests: someone able to
 * rewrite audit rows could re-seal them. Each day the seals not yet exported are written, as one contiguous range, to
 * write-once storage under Object Lock in compliance mode — a bucket this database's credentials cannot rewrite — and the
 * export is recorded. Verification then reads the **archive** and checks three things the database alone cannot:
 *
 *   1. the archive is whole: ranges start at seal 1, follow each other without gap or overlap, and chain seal to seal;
 *   2. the database still has exactly those seals (a seal rewritten or removed here differs from the archive);
 *   3. the audit events still hash to the archived seals — so even if the seal table itself were rewritten, or lost in
 *      a restore, the trail is verified against hashes kept where nobody here can change them.
 *
 * The store is the adapters' object-store port, taken structurally.
 */
export interface SealArchive {
  readonly bucket: string;
  putOnce(key: string, body: Uint8Array, opts: { readonly contentType: string; readonly retainUntil?: Date | null }): Promise<{ readonly created: boolean; readonly versionId: string | null }>;
  get(key: string, versionId?: string | null): Promise<{ readonly body: Buffer; readonly versionId: string | null; readonly retainUntil?: Date | null } | null>;
  list(prefix: string, max?: number): Promise<readonly string[]>;
}

export interface ArchivedSeal {
  readonly id: number;
  readonly fromSeq: string;
  readonly toSeq: string;
  readonly eventCount: string;
  readonly prevSealHash: string | null;
  readonly sealHash: string;
  readonly sealedAt: string;
}

export interface SealExportDocument {
  readonly schema: 'inrp2p.audit-seal-export.v1';
  readonly range: { readonly firstSeal: number; readonly lastSeal: number; readonly fromSeq: string; readonly toSeq: string };
  /** The seal this range continues from: the chain links ranges as it links seals. */
  readonly continues: { readonly seal: number; readonly sealHash: string | null };
  readonly seals: readonly ArchivedSeal[];
}

const PREFIX = 'audit-seals/v1/';
const pad = (n: number) => String(n).padStart(12, '0');
export const sealExportKey = (first: number, last: number) => `${PREFIX}${pad(first)}-${pad(last)}.json`;

/** An archived range as written, or null when it is missing or not JSON. Its shape is checked by the caller. */
function parseExport(body: Buffer | undefined): SealExportDocument | null {
  if (!body) return null;
  try {
    return JSON.parse(body.toString('utf8')) as SealExportDocument;
  } catch {
    return null;
  }
}

const toArchived = (r: { id: bigint; from_seq: bigint; to_seq: bigint; event_count: bigint | number; prev_seal_hash: string | null; seal_hash: string; sealed_at: Date }): ArchivedSeal => ({
  id: Number(r.id), fromSeq: String(r.from_seq), toSeq: String(r.to_seq), eventCount: String(r.event_count),
  prevSealHash: r.prev_seal_hash, sealHash: r.seal_hash, sealedAt: r.sealed_at.toISOString(),
});

/**
 * Exports every seal not yet exported (at most `maxSeals`) as one range. Returns what was written, or null if nothing.
 *
 * A run that wrote its range and stopped before recording it (a crash, a lost connection) left an object the archive
 * keeps and the database does not know. The next run finds it by the seal it starts at and records it as it is — after
 * checking that it describes exactly the seals here — instead of writing a second, overlapping range.
 */
export async function exportAuditSeals(
  db: Db,
  archive: SealArchive,
  opts: { retainDays: number; maxSeals?: number },
): Promise<{ firstSeal: number; lastSeal: number; key: string; adopted?: true } | null> {
  if (!Number.isInteger(opts.retainDays) || opts.retainDays < 1) throw new Error('audit seal export needs a retention in days');
  const last = await db.selectFrom('audit_seal_export').select(['last_seal_id', 'last_seal_hash']).orderBy('last_seal_id', 'desc').limit(1).executeTakeFirst();
  const after = last ? Number(last.last_seal_id) : 0;
  const unrecorded = (await archive.list(`${PREFIX}${pad(after + 1)}-`, 10)).filter((k) => /^audit-seals\/v1\/\d{12}-\d{12}\.json$/.test(k));
  if (unrecorded.length > 0) return adoptExport(db, archive, unrecorded[0]!, after, last?.last_seal_hash ?? null);
  const rows = await db
    .selectFrom('audit_seal')
    .select(['id', 'from_seq', 'to_seq', 'event_count', 'prev_seal_hash', 'seal_hash', 'sealed_at'])
    .where('id', '>', BigInt(after))
    .orderBy('id')
    .limit(opts.maxSeals ?? 1000)
    .execute();
  if (rows.length === 0) return null;
  const seals: ArchivedSeal[] = rows.map(toArchived);
  const first = seals[0]!;
  const final = seals.at(-1)!;
  const doc: SealExportDocument = {
    schema: 'inrp2p.audit-seal-export.v1',
    range: { firstSeal: first.id, lastSeal: final.id, fromSeq: first.fromSeq, toSeq: final.toSeq },
    continues: { seal: after, sealHash: last?.last_seal_hash ?? null },
    seals,
  };
  const body = Buffer.from(`${JSON.stringify(doc)}\n`, 'utf8');
  const key = sealExportKey(first.id, final.id);
  const retainUntil = new Date(Date.now() + opts.retainDays * 86_400_000);
  const put = await archive.putOnce(key, body, { contentType: 'application/json', retainUntil });
  await db
    .insertInto('audit_seal_export')
    .values({
      first_seal_id: BigInt(first.id), last_seal_id: BigInt(final.id), from_seq: BigInt(first.fromSeq), to_seq: BigInt(final.toSeq),
      seal_count: seals.length, last_seal_hash: final.sealHash, bucket: archive.bucket, object_key: key, version_id: put.versionId,
      sha256: createHash('sha256').update(body).digest('hex'), retain_until: retainUntil,
    })
    .execute();
  return { firstSeal: first.id, lastSeal: final.id, key };
}

/** Records an object a previous run wrote and did not record — only when it describes exactly the seals here. */
async function adoptExport(db: Db, archive: SealArchive, key: string, after: number, afterHash: string | null): Promise<{ firstSeal: number; lastSeal: number; key: string; adopted: true }> {
  const object = await archive.get(key);
  const doc = parseExport(object?.body);
  const refuse = (why: string): never => {
    // Not recorded and not overwritten: the daily verification reports the archive's state, and a person decides.
    throw new Error(`audit seal export: ${key} is in the archive but not recorded, and ${why}; see RUNBOOKS audit-archive-mismatch`);
  };
  if (!object || !doc || doc.schema !== 'inrp2p.audit-seal-export.v1' || key !== sealExportKey(doc.range.firstSeal, doc.range.lastSeal)) return refuse('it cannot be read');
  if (doc.range.firstSeal !== after + 1 || doc.continues.seal !== after || doc.continues.sealHash !== afterHash) return refuse('it does not continue the recorded exports');
  const here = (await db.selectFrom('audit_seal').select(['id', 'from_seq', 'to_seq', 'event_count', 'prev_seal_hash', 'seal_hash', 'sealed_at'])
    .where('id', '>=', BigInt(doc.range.firstSeal)).where('id', '<=', BigInt(doc.range.lastSeal)).orderBy('id').execute()).map(toArchived);
  if (JSON.stringify(here) !== JSON.stringify(doc.seals)) return refuse('it does not describe the seals in this database');
  const final = here.at(-1)!;
  await db
    .insertInto('audit_seal_export')
    .values({
      first_seal_id: BigInt(doc.range.firstSeal), last_seal_id: BigInt(final.id), from_seq: BigInt(here[0]!.fromSeq), to_seq: BigInt(final.toSeq),
      seal_count: here.length, last_seal_hash: final.sealHash, bucket: archive.bucket, object_key: key, version_id: object.versionId,
      sha256: createHash('sha256').update(object.body).digest('hex'),
      // As the store reports it; when it does not, the moment of recording — which understates the lock, never overstates it.
      retain_until: object.retainUntil ?? new Date(),
    })
    .execute();
  return { firstSeal: doc.range.firstSeal, lastSeal: final.id, key, adopted: true };
}

export type ArchiveFinding =
  | { readonly kind: 'GAP'; readonly after: number; readonly next: number }
  | { readonly kind: 'CHAIN_BROKEN'; readonly seal: number }
  | { readonly kind: 'UNREADABLE'; readonly key: string }
  | { readonly kind: 'SEAL_DIFFERS'; readonly seal: number }
  | { readonly kind: 'SEAL_MISSING_HERE'; readonly seal: number }
  | { readonly kind: 'EVENTS_DIFFER'; readonly seal: number }
  | { readonly kind: 'NOT_ARCHIVED'; readonly firstSeal: number; readonly sealedAt: string };

export interface ArchiveVerification {
  readonly ok: boolean;
  readonly archivedSeals: number;
  readonly findings: readonly ArchiveFinding[];
}

/**
 * Verifies the archive against itself, the seals here and the audit events (see above), and records the result.
 * `exportGraceHours`: how long a sealed range may wait for its export before it is reported as not archived.
 */
export async function verifyAuditArchive(db: Db, archive: SealArchive, opts: { exportGraceHours?: number; record?: boolean } = {}): Promise<ArchiveVerification> {
  const findings: ArchiveFinding[] = [];
  const keys = (await archive.list(PREFIX, 1000)).filter((k) => /^audit-seals\/v1\/\d{12}-\d{12}\.json$/.test(k));
  const archived: ArchivedSeal[] = [];
  let expectedNext = 1;
  let previousHash: string | null = null;
  for (const key of keys) {
    const doc = parseExport((await archive.get(key))?.body);
    if (!doc || doc.schema !== 'inrp2p.audit-seal-export.v1' || key !== sealExportKey(doc.range.firstSeal, doc.range.lastSeal)) {
      findings.push({ kind: 'UNREADABLE', key });
      continue;
    }
    if (doc.range.firstSeal !== expectedNext) findings.push({ kind: 'GAP', after: expectedNext - 1, next: doc.range.firstSeal });
    for (const seal of doc.seals) {
      // Seal to seal, across ranges as within them: each names the hash before it.
      if (seal.prevSealHash !== previousHash && seal.id === expectedNext) findings.push({ kind: 'CHAIN_BROKEN', seal: seal.id });
      previousHash = seal.sealHash;
      expectedNext = seal.id + 1;
      archived.push(seal);
    }
  }

  // The seals here, against the archive.
  const here = new Map((await db.selectFrom('audit_seal').select(['id', 'from_seq', 'to_seq', 'event_count', 'prev_seal_hash', 'seal_hash']).execute()).map((s) => [Number(s.id), s]));
  for (const seal of archived) {
    const row = here.get(seal.id);
    if (!row) findings.push({ kind: 'SEAL_MISSING_HERE', seal: seal.id });
    else if (row.seal_hash !== seal.sealHash || row.prev_seal_hash !== seal.prevSealHash || String(row.from_seq) !== seal.fromSeq || String(row.to_seq) !== seal.toSeq) {
      findings.push({ kind: 'SEAL_DIFFERS', seal: seal.id });
    }
  }
  // The audit events, re-hashed against the archived seals: what the trail is checked against when the seal table cannot be trusted.
  for (const seal of archived) {
    const r = await sql<{ hash: string; n: string }>`
      select inrp2p_audit_range_hash(${seal.prevSealHash}, ${seal.fromSeq}::bigint, ${seal.toSeq}::bigint) as hash,
             (select count(*) from audit_event where seq between ${seal.fromSeq}::bigint and ${seal.toSeq}::bigint)::text as n`.execute(db);
    if (r.rows[0]!.hash !== seal.sealHash || r.rows[0]!.n !== seal.eventCount) findings.push({ kind: 'EVENTS_DIFFER', seal: seal.id });
  }
  // Sealed here and still not archived after the grace period: a range nobody outside could vouch for.
  const grace = opts.exportGraceHours ?? 48;
  const pending = await sql<{ id: string; sealed_at: Date }>`
    select id::text, sealed_at from audit_seal where id > ${expectedNext - 1} and sealed_at < inrp2p_now() - make_interval(hours => ${grace}) order by id limit 1`.execute(db);
  if (pending.rows[0]) findings.push({ kind: 'NOT_ARCHIVED', firstSeal: Number(pending.rows[0].id), sealedAt: pending.rows[0].sealed_at.toISOString() });

  const result = { ok: findings.length === 0, archivedSeals: archived.length, findings };
  if (opts.record !== false) {
    await db.insertInto('audit_archive_verification').values({ ok: result.ok, archived_seals: result.archivedSeals, findings: JSON.stringify(findings) }).execute();
  }
  return result;
}
