import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Db, Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { executeCommand } from '@inrp2p/commands';
import type { OutboxHandler } from '@inrp2p/outbox';
import { sha256 } from './canonical.ts';
import { receiptArtifacts, receiptJson } from './artifacts.ts';
import { type ReceiptSnapshot, RECEIPT_SNAPSHOT_VERSION, buildReceiptSnapshot } from './snapshot.ts';

export interface IssuedReceipt {
  readonly receiptId: string;
  readonly version: number;
  readonly sha256: string;
  /** False when a receipt already existed — a redelivered event, not a second document. */
  readonly issued: boolean;
}

/**
 * Issues the receipt for a completed trade, once.
 *
 * The snapshot is taken here and never taken again: `(trade_id, version)` is unique and the insert does nothing
 * on conflict, so at-least-once delivery from the outbox produces one document, not a new one each time it is
 * retried. That matters more than it sounds — a second snapshot taken a day later could legitimately differ
 * (a client renamed, a destination archived), and the client would have two receipts for one trade that do not
 * agree.
 */
export async function issueReceipt(db: Db, input: { tradeId: string; version?: number }): Promise<IssuedReceipt> {
  const tradeId = requireUuid(input.tradeId, 'tradeId');
  const version = input.version ?? RECEIPT_SNAPSHOT_VERSION;
  const existing = await db.selectFrom('receipt').select(['id', 'version', 'sha256']).where('trade_id', '=', tradeId).where('version', '=', version).executeTakeFirst();
  if (existing) return { receiptId: existing.id, version: existing.version, sha256: existing.sha256, issued: false };

  const snapshot = await buildReceiptSnapshot(db, tradeId);
  const artifacts = receiptArtifacts(snapshot);
  const digest = sha256(receiptJson(snapshot));

  const out = await executeCommand(
    db,
    {
      authorize: async () => {},
      handle: async (ctx) => {
        const row = await ctx.tx
          .insertInto('receipt')
          .values({
            trade_id: tradeId,
            version,
            snapshot_json: JSON.stringify(snapshot),
            sha256: digest,
            json_sha256: artifacts.hashes.json,
            csv_sha256: artifacts.hashes.csv,
            html_sha256: artifacts.hashes.html,
            generated_by: `SYSTEM:${ctx.commandName}`,
          })
          .onConflict((oc) => oc.columns(['trade_id', 'version']).doNothing())
          .returning(['id', 'version'])
          .executeTakeFirst();
        if (!row) {
          const already = await ctx.tx.selectFrom('receipt').select(['id', 'version', 'sha256']).where('trade_id', '=', tradeId).where('version', '=', version).executeTakeFirstOrThrow();
          return { receiptId: already.id, version: already.version, sha256: already.sha256, issued: false };
        }
        // The hash, the trade and the version — never the snapshot itself. The audit trail records that a
        // document was issued and which one it is; the document lives in its own immutable row.
        await appendAudit(ctx, {
          action: 'receipt.generated', entityType: 'receipt', entityId: row.id,
          after: { trade_id: tradeId, version: row.version, sha256: digest, json_sha256: artifacts.hashes.json, csv_sha256: artifacts.hashes.csv, html_sha256: artifacts.hashes.html },
        });
        return { receiptId: row.id, version: row.version, sha256: digest, issued: true };
      },
    },
    { name: 'receipt.generate', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { tradeId, version }, financial: false },
  );
  return out.result;
}

/** Outbox handler for `receipt.generate`, enqueued by trade completion (STATE_MACHINES T7). */
export function receiptHandler(db: Db): OutboxHandler {
  return {
    name: 'receipt_generate',
    handles: (type) => type === 'receipt.generate',
    run: async (event) => {
      const payload = (event.payload ?? {}) as { tradeId?: unknown };
      if (typeof payload.tradeId !== 'string') throw new Error('receipt.generate payload is missing tradeId');
      await issueReceipt(db, { tradeId: payload.tradeId });
    },
  };
}

export interface StoredReceipt {
  readonly receiptId: string;
  readonly tradeRef: string;
  readonly version: number;
  readonly sha256: string;
  readonly generatedAt: string;
  readonly snapshot: ReceiptSnapshot;
  readonly hashes: { readonly json: string; readonly csv: string; readonly html: string };
}

/** The receipt of a trade, by the reference the reader has. `clientId` scopes it to its own client. */
export async function getReceipt(ex: Executor, tradeRef: string, opts: { clientId?: string } = {}): Promise<StoredReceipt | null> {
  let q = ex
    .selectFrom('receipt as r')
    .innerJoin('trade as t', 't.id', 'r.trade_id')
    .select(['r.id', 'r.version', 'r.sha256', 'r.json_sha256', 'r.csv_sha256', 'r.html_sha256', 'r.snapshot_json', 'r.generated_at', 't.ref'])
    .where('t.ref', '=', tradeRef)
    .orderBy('r.version', 'desc')
    .limit(1);
  if (opts.clientId) q = q.where('t.client_id', '=', opts.clientId);
  const row = await q.executeTakeFirst();
  if (!row) return null;
  return {
    receiptId: row.id,
    tradeRef: row.ref,
    version: row.version,
    sha256: row.sha256,
    generatedAt: row.generated_at.toISOString(),
    snapshot: row.snapshot_json as ReceiptSnapshot,
    hashes: { json: row.json_sha256, csv: row.csv_sha256, html: row.html_sha256 },
  };
}

export type ReceiptFormat = 'json' | 'csv' | 'html';

const MEDIA: Record<ReceiptFormat, string> = { json: 'application/json', csv: 'text/csv', html: 'text/html' };

/**
 * Regenerates one artifact from the stored snapshot and checks it against the hash recorded when the receipt was
 * issued.
 *
 * The check is the point. Anyone can re-render a document; what makes this one evidence is that the bytes are
 * the same bytes, and a mismatch means the generator changed under a document that was supposed to be fixed.
 * That is a defect, not a difference to paper over, so it raises rather than returning the new version.
 */
export function regenerateReceipt(receipt: StoredReceipt, format: ReceiptFormat): { body: string; contentType: string; filename: string; sha256: string } {
  const artifacts = receiptArtifacts(receipt.snapshot);
  const body = artifacts[format];
  const recorded = receipt.hashes[format];
  const actual = artifacts.hashes[format];
  if (actual !== recorded) {
    throw new DomainError('RECEIPT_HASH_MISMATCH', `regenerated ${format} receipt for ${receipt.tradeRef} does not match the issued document`, { recorded, actual });
  }
  return { body, contentType: MEDIA[format], filename: `receipt-${receipt.tradeRef}.${format}`, sha256: actual };
}
