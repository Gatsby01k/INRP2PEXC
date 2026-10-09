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
 *   1. the archive is whole: ranges start at the first event, follow each other in the event sequence without gap or
 *      overlap, and chain seal to seal — seal numbers only name them, since they come from a sequence that may skip;
 *   2. the database still has exactly those seals (a seal rewritten or removed here differs from the archive);
 *   3. the audit events still hash to the archived seals — so even if the seal table itself were rewritten, or lost in
 *      a restore, the trail is verified against hashes kept where nobody here can change them.
 *
 * A restore makes the archive branch, and that is allowed for. A database recovered to an earlier moment has forgotten the
 * seals made after it, and seals again under the same numbers with other events; the archive still holds the ranges the
 * lost timeline exported. So a range is named by its last seal's hash as well as its numbers — two timelines never
 * collide — and verification follows **this** database's chain through the archive. A range that leaves that chain after
 * the moment a recorded database change says the records were whole (`restore_fence.known_until`) is history from before
 * the restore: kept, and reported as superseded. Any other range that disagrees is a finding.
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
const KEY = /^audit-seals\/v1\/(\d{12})-(\d{12})-([0-9a-f]{16})\.json$/;
const pad = (n: number) => String(n).padStart(12, '0');
/** A range's name: its first and last seal, and the first 16 hex digits of the last seal's hash. */
export const sealExportKey = (first: number, last: number, lastSealHash: string) => `${PREFIX}${pad(first)}-${pad(last)}-${lastSealHash.slice(0, 16)}.json`;

/** An archived range as written, or null when it is missing or not JSON. Its shape is checked by the caller. */
function parseExport(body: Buffer | undefined): SealExportDocument | null {
  if (!body) return null;
  try {
    return JSON.parse(body.toString('utf8')) as SealExportDocument;
  } catch {
    return null;
  }
}

/** The document is what its name says: the schema, and the range and last hash the key names. */
const wellFormed = (key: string, doc: SealExportDocument | null): doc is SealExportDocument =>
  !!doc && doc.schema === 'inrp2p.audit-seal-export.v1' && Array.isArray(doc.seals) && doc.seals.length > 0 &&
  key === sealExportKey(doc.range.firstSeal, doc.range.lastSeal, doc.seals.at(-1)!.sealHash);

const toArchived = (r: { id: bigint; from_seq: bigint; to_seq: bigint; event_count: bigint | number; prev_seal_hash: string | null; seal_hash: string; sealed_at: Date }): ArchivedSeal => ({
  id: Number(r.id), fromSeq: String(r.from_seq), toSeq: String(r.to_seq), eventCount: String(r.event_count),
  prevSealHash: r.prev_seal_hash, sealHash: r.seal_hash, sealedAt: r.sealed_at.toISOString(),
});

async function sealsHere(db: Db, first: number, last: number): Promise<ArchivedSeal[]> {
  return (await db.selectFrom('audit_seal').select(['id', 'from_seq', 'to_seq', 'event_count', 'prev_seal_hash', 'seal_hash', 'sealed_at'])
    .where('id', '>=', BigInt(first)).where('id', '<=', BigInt(last)).orderBy('id').execute()).map(toArchived);
}

/**
 * Exports every seal not yet exported (at most `maxSeals`) as one range. Returns what was written, or null if nothing.
 *
 * A run that wrote its range and stopped before recording it (a crash, a lost connection) left an object the archive
 * keeps and the database does not know. The next run looks at the ranges starting where the recorded exports end and
 * records the one that describes exactly the seals here, once, instead of writing a second range over the same seals. A
 * range there that does not describe them — another timeline's, from before a restore — is left as it is, and this
 * database's own range is written beside it under its own name.
 */
export async function exportAuditSeals(
  db: Db,
  archive: SealArchive,
  opts: { retainDays: number; maxSeals?: number },
): Promise<{ firstSeal: number; lastSeal: number; key: string; adopted?: true } | null> {
  if (!Number.isInteger(opts.retainDays) || opts.retainDays < 1) throw new Error('audit seal export needs a retention in days');
  const last = await db.selectFrom('audit_seal_export').select(['last_seal_id', 'last_seal_hash']).orderBy('last_seal_id', 'desc').limit(1).executeTakeFirst();
  const after = last ? Number(last.last_seal_id) : 0;
  const afterHash = last?.last_seal_hash ?? null;
  const next = await db.selectFrom('audit_seal').select('id').where('id', '>', BigInt(after)).orderBy('id').limit(1).executeTakeFirst();
  if (!next) return null;
  for (const key of (await archive.list(`${PREFIX}${pad(Number(next.id))}-`, 100)).filter((k) => KEY.test(k))) {
    const adopted = await adoptExport(db, archive, key, after, afterHash);
    if (adopted) return adopted;
  }
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
    continues: { seal: after, sealHash: afterHash },
    seals,
  };
  const body = Buffer.from(`${JSON.stringify(doc)}\n`, 'utf8');
  const key = sealExportKey(first.id, final.id, final.sealHash);
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
async function adoptExport(db: Db, archive: SealArchive, key: string, after: number, afterHash: string | null): Promise<{ firstSeal: number; lastSeal: number; key: string; adopted: true } | null> {
  const object = await archive.get(key);
  const doc = parseExport(object?.body);
  if (!object || !wellFormed(key, doc) || doc.range.firstSeal <= after || doc.continues.seal !== after || doc.continues.sealHash !== afterHash) return null;
  const here = await sealsHere(db, doc.range.firstSeal, doc.range.lastSeal);
  if (JSON.stringify(here) !== JSON.stringify(doc.seals)) return null;
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
  | { readonly kind: 'NOT_ARCHIVED'; readonly firstSeal: number; readonly sealedAt: string }
  /** An archived range off this database's chain that no recorded database change explains. */
  | { readonly kind: 'DIVERGED'; readonly key: string; readonly firstSeal: number; readonly lastSeal: number };

/** A range from a timeline this database no longer has — exported before a restore and kept, as evidence. */
export interface SupersededRange {
  readonly key: string;
  readonly firstSeal: number;
  readonly lastSeal: number;
  /** The first seal of the range that this database does not have as archived. */
  readonly divergesAt: number;
  /** The restore fence whose `known_until` it was sealed after. */
  readonly fence: string;
}

export interface ArchiveVerification {
  readonly ok: boolean;
  readonly archivedSeals: number;
  readonly findings: readonly ArchiveFinding[];
  readonly superseded: readonly SupersededRange[];
}

interface Archived {
  readonly key: string;
  readonly doc: SealExportDocument;
}

/**
 * Verifies the archive against itself, the seals here and the audit events (see above), and records the result.
 * `exportGraceHours`: how long a sealed range may wait for its export before it is reported as not archived.
 */
export async function verifyAuditArchive(db: Db, archive: SealArchive, opts: { exportGraceHours?: number; record?: boolean } = {}): Promise<ArchiveVerification> {
  const findings: ArchiveFinding[] = [];
  const objects: Archived[] = [];
  for (const key of await archive.list(PREFIX, 1000)) {
    if (!KEY.test(key)) continue;
    const doc = parseExport((await archive.get(key))?.body);
    if (!wellFormed(key, doc)) findings.push({ kind: 'UNREADABLE', key });
    else objects.push({ key, doc });
  }
  const seals = await db.selectFrom('audit_seal').select(['id', 'from_seq', 'to_seq', 'event_count', 'prev_seal_hash', 'seal_hash', 'sealed_at']).execute();
  const here = new Map(seals.map((s) => [Number(s.id), toArchived(s)]));
  const recorded = new Set((await db.selectFrom('audit_seal_export').select('object_key').where('bucket', '=', archive.bucket).execute()).map((r) => r.object_key));
  const fences = (await db.selectFrom('restore_fence').select(['ref', 'known_until']).where('known_until', 'is not', null).orderBy('known_until').execute())
    .map((f) => ({ ref: f.ref, knownUntil: f.known_until!.getTime() }));

  const same = (a: ArchivedSeal, b: ArchivedSeal | undefined) =>
    !!b && a.sealHash === b.sealHash && a.prevSealHash === b.prevSealHash && a.fromSeq === b.fromSeq && a.toSeq === b.toSeq;
  const firstDifference = (o: Archived) => o.doc.seals.find((s) => !same(s, here.get(s.id)));
  // A range that leaves this database's chain after the records were last known whole is the lost timeline of a restore.
  const supersession = (o: Archived): SupersededRange | null => {
    const d = firstDifference(o);
    if (!d) return null;
    const fence = fences.find((f) => Date.parse(d.sealedAt) > f.knownUntil);
    return fence ? { key: o.key, firstSeal: o.doc.range.firstSeal, lastSeal: o.doc.range.lastSeal, divergesAt: d.id, fence: fence.ref } : null;
  };

  // Follow this database's chain through the event sequence: at each point, its own recorded export; else a range
  // agreeing with every seal here; else — when nothing explains the disagreement — the archived range itself, whose
  // differences are then findings.
  const chain: Archived[] = [];
  const superseded = new Map<string, SupersededRange>();
  const placed = new Set<string>();
  const fromSeq = (o: Archived) => BigInt(o.doc.range.fromSeq);
  let expectedFrom = 1n;
  for (;;) {
    const candidates = objects.filter((o) => fromSeq(o) === expectedFrom && !placed.has(o.key));
    if (candidates.length === 0) {
      const later = objects.filter((o) => fromSeq(o) > expectedFrom && !placed.has(o.key) && !supersession(o)).sort((a, b) => (fromSeq(a) < fromSeq(b) ? -1 : 1));
      if (later.length === 0) break;
      findings.push({ kind: 'GAP', after: chain.at(-1)?.doc.range.lastSeal ?? 0, next: later[0]!.doc.range.firstSeal });
      expectedFrom = fromSeq(later[0]!);
      continue;
    }
    for (const c of candidates) {
      const s = supersession(c);
      if (s) superseded.set(c.key, s);
    }
    const pick = candidates.find((c) => recorded.has(c.key)) ?? candidates.find((c) => !firstDifference(c)) ?? candidates.find((c) => !superseded.has(c.key));
    if (!pick) break; // only a lost timeline continues here: this database's own seals are not archived yet
    superseded.delete(pick.key);
    placed.add(pick.key);
    chain.push(pick);
    expectedFrom = BigInt(pick.doc.range.toSeq) + 1n;
  }
  for (const o of objects) {
    if (placed.has(o.key) || superseded.has(o.key)) continue;
    const s = supersession(o);
    if (s) superseded.set(o.key, s);
    else if (firstDifference(o)) findings.push({ kind: 'DIVERGED', key: o.key, firstSeal: o.doc.range.firstSeal, lastSeal: o.doc.range.lastSeal });
  }

  // The chain: seal to seal across ranges, as within them.
  const archived: ArchivedSeal[] = [];
  let previousHash: string | null = null;
  for (const o of chain) {
    for (const seal of o.doc.seals) {
      if (seal.prevSealHash !== previousHash) findings.push({ kind: 'CHAIN_BROKEN', seal: seal.id });
      previousHash = seal.sealHash;
      archived.push(seal);
    }
  }
  // The seals here, against the archive.
  for (const seal of archived) {
    const row = here.get(seal.id);
    if (!row) findings.push({ kind: 'SEAL_MISSING_HERE', seal: seal.id });
    else if (!same(seal, row)) findings.push({ kind: 'SEAL_DIFFERS', seal: seal.id });
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
  const archivedTo = archived.at(-1)?.toSeq ?? '0';
  const pending = await sql<{ id: string; sealed_at: Date }>`
    select id::text, sealed_at from audit_seal where from_seq > ${archivedTo}::bigint and sealed_at < inrp2p_now() - make_interval(hours => ${grace}) order by from_seq limit 1`.execute(db);
  if (pending.rows[0]) findings.push({ kind: 'NOT_ARCHIVED', firstSeal: Number(pending.rows[0].id), sealedAt: pending.rows[0].sealed_at.toISOString() });

  const result: ArchiveVerification = { ok: findings.length === 0, archivedSeals: archived.length, findings, superseded: [...superseded.values()].sort((a, b) => a.firstSeal - b.firstSeal) };
  if (opts.record !== false) {
    await db.insertInto('audit_archive_verification').values({ ok: result.ok, archived_seals: result.archivedSeals, findings: JSON.stringify(findings), superseded: JSON.stringify(result.superseded) }).execute();
  }
  return result;
}
