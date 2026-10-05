import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db, Executor } from '@inrp2p/db';
import { type ReceiptFormat, type StoredReceipt, regenerateReceipt } from './issue.ts';

/**
 * Receipts kept in private object storage (production task E2, TD-12; migration 0032).
 *
 * At issue, each artifact is written once at a key that names its content (`receipts/{trade}/v{version}/{sha256}.{ext}`)
 * and recorded in `receipt_object`. JSON, CSV and HTML are the issued bytes, checked against the receipt's recorded
 * hashes before they are written; a PDF, where a renderer is configured, is printed from the verified HTML and
 * recorded with both hashes — its own bytes, and the HTML it means. Serving prefers the stored object and verifies its
 * bytes against the recorded hash on every read: bytes that differ are refused, never served.
 *
 * The store and the renderer are the adapters' ports, taken structurally so this package needs neither.
 */
export interface ReceiptObjectStore {
  readonly bucket: string;
  putOnce(key: string, body: Uint8Array, opts: { readonly contentType: string; readonly retainUntil?: Date | null }): Promise<{ readonly created: boolean; readonly versionId: string | null }>;
  get(key: string, versionId?: string | null): Promise<{ readonly body: Buffer; readonly versionId: string | null } | null>;
}

export interface ReceiptPdfPrinter {
  render(input: { readonly html: string; readonly title: string }): Promise<Uint8Array>;
}

export type StoredFormat = ReceiptFormat | 'pdf';

const MEDIA: Record<StoredFormat, string> = { json: 'application/json', csv: 'text/csv; charset=utf-8', html: 'text/html; charset=utf-8', pdf: 'application/pdf' };
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function receiptRow(ex: Executor, receiptId: string): Promise<StoredReceipt & { tradeId: string }> {
  const row = await ex
    .selectFrom('receipt as r')
    .innerJoin('trade as t', 't.id', 'r.trade_id')
    .select(['r.id', 'r.trade_id', 'r.version', 'r.sha256', 'r.json_sha256', 'r.csv_sha256', 'r.html_sha256', 'r.snapshot_json', 'r.generated_at', 't.ref'])
    .where('r.id', '=', receiptId)
    .executeTakeFirstOrThrow();
  return {
    receiptId: row.id, tradeId: row.trade_id, tradeRef: row.ref, version: row.version, sha256: row.sha256, generatedAt: row.generated_at.toISOString(),
    snapshot: row.snapshot_json as StoredReceipt['snapshot'], hashes: { json: row.json_sha256, csv: row.csv_sha256, html: row.html_sha256 },
  };
}

/**
 * Writes the receipt's artifacts that are not stored yet, and records each. Idempotent: an artifact already recorded is
 * skipped, and one already in the bucket (a crash between the write and the record) is the same bytes or a conflict.
 * `retainDays`, when set, writes under Object Lock until then — the retention period is the owner's decision.
 */
export async function storeReceiptObjects(
  db: Db,
  store: ReceiptObjectStore,
  receiptId: string,
  opts: { readonly pdf?: ReceiptPdfPrinter | null; readonly retainDays?: number | null } = {},
): Promise<{ readonly stored: readonly StoredFormat[] }> {
  const receipt = await receiptRow(db, receiptId);
  const done = new Set((await db.selectFrom('receipt_object').select('format').where('receipt_id', '=', receiptId).execute()).map((r) => r.format));
  const retainUntil = opts.retainDays ? new Date(Date.now() + opts.retainDays * 86_400_000) : null;
  const stored: StoredFormat[] = [];
  const formats: StoredFormat[] = ['json', 'csv', 'html', ...(opts.pdf ? (['pdf'] as const) : [])];
  for (const format of formats) {
    if (done.has(format)) continue;
    let body: Buffer;
    let source: string;
    if (format === 'pdf') {
      const html = regenerateReceipt(receipt, 'html');
      body = Buffer.from(await opts.pdf!.render({ html: html.body, title: `Settlement receipt ${receipt.tradeRef}` }));
      source = html.sha256;
    } else {
      // regenerateReceipt refuses an artifact that is not the issued one: what is stored is what was issued.
      const out = regenerateReceipt(receipt, format);
      body = Buffer.from(out.body, 'utf8');
      source = out.sha256;
    }
    const digest = sha256(body);
    const key = `receipts/${receipt.tradeId}/v${receipt.version}/${digest}.${format}`;
    const put = await store.putOnce(key, body, { contentType: MEDIA[format], retainUntil });
    await db
      .insertInto('receipt_object')
      .values({ receipt_id: receipt.receiptId, format, bucket: store.bucket, object_key: key, version_id: put.versionId, sha256: digest, source_sha256: source, byte_size: BigInt(body.length), retain_until: retainUntil })
      .onConflict((oc) => oc.columns(['receipt_id', 'format']).doNothing())
      .execute();
    stored.push(format);
  }
  return { stored };
}

/**
 * The stored bytes of one artifact, verified against what was recorded when they were written; `null` when that
 * artifact is not stored (the caller regenerates it, as before). Bytes that do not match are refused: a receipt that
 * differs from the one issued is never served.
 */
export async function readStoredReceipt(ex: Executor, store: ReceiptObjectStore, receiptId: string, format: StoredFormat): Promise<{ body: Buffer; contentType: string; sha256: string; sourceSha256: string } | null> {
  const row = await ex.selectFrom('receipt_object').select(['object_key', 'version_id', 'sha256', 'source_sha256']).where('receipt_id', '=', receiptId).where('format', '=', format).executeTakeFirst();
  if (!row) return null;
  // The version that was written, not whatever is newest under the key: a later version is not the issued document.
  const object = await store.get(row.object_key, row.version_id);
  if (!object || sha256(object.body) !== row.sha256) {
    throw new DomainError('RECEIPT_HASH_MISMATCH', `stored ${format} receipt ${row.object_key} is ${object ? 'not the bytes that were written' : 'missing'}`, { key: row.object_key });
  }
  return { body: object.body, contentType: MEDIA[format], sha256: row.sha256, sourceSha256: row.source_sha256 };
}

/**
 * Receipts with nothing stored yet — issued before a bucket was configured, or whose write failed — oldest first, for
 * the backfill job that stores them.
 */
export async function receiptsNotStored(ex: Executor, limit = 50): Promise<string[]> {
  const r = await sql<{ id: string }>`
    select r.id from receipt r
     where not exists (select 1 from receipt_object o where o.receipt_id = r.id and o.format = 'html')
     order by r.generated_at limit ${limit}`.execute(ex);
  return r.rows.map((x) => x.id);
}
