import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import {
  type ReceiptObjectStore, type ReceiptPdfPrinter, getReceipt, issueReceipt, readStoredReceipt, receiptHandler, receiptsNotStored, regenerateReceipt, storeReceiptObjects,
} from '../src/index.ts';
import { type World, createWorld, openTrade, payClient, settleFirstLeg } from '../../settlement/test/world.ts';
import { type LocalS3, startLocalS3 } from '../../../test/minio.ts';

/**
 * E2 (TD-12): a receipt's artifacts written once to a private, versioned bucket under Object Lock, at keys that name
 * their content, recorded against the issued hashes — and served only after their bytes are checked again.
 */
let w: World;
let s3: LocalS3;
let store: ReceiptObjectStore;

/** A printer whose PDFs differ on every print, as real ones do (a creation time in the metadata). */
const printer: ReceiptPdfPrinter = {
  render: async ({ html }) => Buffer.from(`%PDF-1.7 source=${createHash('sha256').update(html).digest('hex')} printed=${randomUUID()}`),
};

async function completedTrade(): Promise<{ tradeId: string; tradeRef: string }> {
  const trade = await openTrade(w, { baseUsdt: '100', clientRate: '90.000000' });
  await settleFirstLeg(w, trade.tradeId);
  await payClient(w, trade);
  return trade;
}

beforeAll(async () => {
  w = await createWorld('receipt_storage');
  s3 = await startLocalS3();
  store = await s3.bucket('inrp2p-receipts');
}, 180_000);
afterAll(async () => {
  await s3?.stop();
  await w?.close();
});

const objectsOf = (receiptId: string) =>
  w.app.selectFrom('receipt_object').select(['format', 'object_key', 'version_id', 'sha256', 'source_sha256', 'retain_until']).where('receipt_id', '=', receiptId).orderBy('format').execute();

describe('stored receipts (E2, TD-12)', () => {
  it('writes every artifact once at issue, content-addressed, locked, and recorded against the issued hashes', async () => {
    const trade = await completedTrade();
    const handler = receiptHandler(w.app, { store, pdf: printer, retainDays: 1 });
    const event = { id: randomUUID(), type: 'receipt.generate', aggregateType: 'trade', aggregateId: trade.tradeId, payload: { tradeId: trade.tradeId }, correlationId: randomUUID() };
    await handler.run(event);
    const receipt = (await getReceipt(w.app, trade.tradeRef))!;
    const objects = await objectsOf(receipt.receiptId);
    expect(objects.map((o) => o.format)).toEqual(['csv', 'html', 'json', 'pdf']);
    for (const o of objects) {
      expect(o.object_key).toBe(`receipts/${trade.tradeId}/v${receipt.version}/${o.sha256}.${o.format}`);
      expect(o.version_id).toBeTruthy();
      expect(o.retain_until).not.toBeNull();
      if (o.format !== 'pdf') expect([o.sha256, o.source_sha256]).toEqual([receipt.hashes[o.format], receipt.hashes[o.format]]);
    }
    // The PDF is recorded as what it means — the HTML it was printed from — and as the bytes that were stored.
    const pdf = objects.find((o) => o.format === 'pdf')!;
    expect(pdf.source_sha256).toBe(receipt.hashes.html);
    expect(pdf.sha256).not.toBe(receipt.hashes.html);

    // Redelivered: nothing is written twice, and the PDF is not printed again under another hash.
    await handler.run(event);
    expect(await objectsOf(receipt.receiptId)).toEqual(objects);

    // Served from storage: the issued bytes for json/csv/html, and the one printed PDF — never a reprint.
    for (const format of ['json', 'csv', 'html'] as const) {
      const out = (await readStoredReceipt(w.app, store, receipt.receiptId, format))!;
      expect(out.body.toString('utf8')).toBe(regenerateReceipt(receipt, format).body);
      expect(out.sha256).toBe(receipt.hashes[format]);
    }
    const storedPdf = (await readStoredReceipt(w.app, store, receipt.receiptId, 'pdf'))!;
    expect(createHash('sha256').update(storedPdf.body).digest('hex')).toBe(pdf.sha256);
    expect(storedPdf.sourceSha256).toBe(receipt.hashes.html);
  });

  it('serves the version that was written, refuses bytes that differ, and nobody can delete the original', async () => {
    const trade = await completedTrade();
    const issued = await issueReceipt(w.app, { tradeId: trade.tradeId });
    await storeReceiptObjects(w.app, store, issued.receiptId, { retainDays: 1 });
    const [csv] = (await objectsOf(issued.receiptId)).filter((o) => o.format === 'csv');
    // Someone with the bucket's keys writes other bytes under the same key: a new version, not a replacement.
    const forged = Buffer.from('trade_ref,client\nforged,forged\n');
    const md5 = createHash('md5').update(forged).digest('base64');
    expect((await s3.raw('PUT', `/inrp2p-receipts/${csv!.object_key}`, { 'content-md5': md5 }, forged)).status).toBe(200);
    expect((await store.get(csv!.object_key))!.body.equals(forged)).toBe(true);
    // The receipt still serves the version it recorded — the issued bytes.
    const served = (await readStoredReceipt(w.app, store, issued.receiptId, 'csv'))!;
    expect(served.sha256).toBe(csv!.sha256);
    expect(served.body.equals(forged)).toBe(false);
    // And the original version cannot be removed while its retention runs: the lock holds against the bucket's own
    // credentials. (Without a retention set, versioning still keeps it; how long to lock is the owner's decision.)
    const del = await s3.raw('DELETE', `/inrp2p-receipts/${csv!.object_key}?versionId=${encodeURIComponent(csv!.version_id!)}`);
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect((await store.get(csv!.object_key, csv!.version_id))!.body.toString('utf8')).toBe(regenerateReceipt((await getReceipt(w.app, trade.tradeRef))!, 'csv').body);

    // A store that hands back other bytes for the recorded version is refused, never served.
    const lying: ReceiptObjectStore = { bucket: store.bucket, putOnce: store.putOnce.bind(store), get: async () => ({ body: forged, versionId: csv!.version_id }) };
    await expect(readStoredReceipt(w.app, lying, issued.receiptId, 'csv')).rejects.toMatchObject({ code: 'RECEIPT_HASH_MISMATCH' });
  });

  it('stores receipts issued before the bucket existed, and the database refuses a record that is not the issued artifact (IX097)', async () => {
    const trade = await completedTrade();
    const issued = await issueReceipt(w.app, { tradeId: trade.tradeId });
    expect(await receiptsNotStored(w.app, 500)).toContain(issued.receiptId);
    await storeReceiptObjects(w.app, store, issued.receiptId);
    expect(await receiptsNotStored(w.app, 500)).not.toContain(issued.receiptId);

    const receipt = (await getReceipt(w.app, trade.tradeRef))!;
    const other = 'f'.repeat(64);
    const insert = (format: string, sha: string, source: string, key: string) => sql`
      insert into receipt_object (receipt_id, format, bucket, object_key, sha256, source_sha256, byte_size)
      values (${issued.receiptId}, ${format}, 'inrp2p-receipts', ${key}, ${sha}, ${source}, 10)`.execute(w.t.owner);
    const other2 = await completedTrade();
    await expect(insert('pdf', other, receipt.hashes.html, `receipts/${other2.tradeId}/v1/${other}.pdf`)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX097');
    await expect(insert('pdf', other, receipt.hashes.json, `receipts/${trade.tradeId}/v1/${other}.pdf`)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX097');
    // What was recorded stays recorded: append-only.
    await expect(sql`update receipt_object set sha256 = ${other} where receipt_id = ${issued.receiptId}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
  });
});
