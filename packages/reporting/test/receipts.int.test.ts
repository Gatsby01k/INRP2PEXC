import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { runAs } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import { approveAdjustment, confirmPayout, createPayoutLeg, recordLegEvidence, requestAdjustment, sendPayoutLeg } from '@inrp2p/settlement';
import { FORBIDDEN_CLIENT_KEY } from '@inrp2p/quotes';
import {
  type ReceiptSnapshot, buildReceiptSnapshot, canonicalJson, getReceipt, issueReceipt, receiptArtifacts,
  receiptCsv, receiptHandler, receiptHtml, regenerateReceipt, sha256,
} from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from '../../settlement/test/world.ts';

/**
 * Phase 8 exit: a receipt regenerated from its snapshot is the same document, byte for byte.
 *
 * The world settles one trade in two payments, which is the ordinary case and the one a receipt has to get
 * right: the client wants to see both bank references and a total that adds up.
 */
const CLIENT_RATE = '90.000000';
const ROUTE_RATE = '92.500000';

let w: World;
let tradeId = '';
let tradeRef = '';

beforeAll(async () => {
  w = await createWorld('receipts', { capacityInr: '500000000.00' });
  const trade = await openTrade(w, { baseUsdt: '1000', clientRate: CLIENT_RATE, routeRate: ROUTE_RATE, executionMode: 'TO_EXCHANGE' });
  tradeId = trade.tradeId;
  tradeRef = trade.tradeRef;
  await settleFirstLeg(w, tradeId);
  await payLeg('50000.00');
  await payLeg('40000.00');
});
afterAll(async () => w.close());

async function payLeg(amount: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
    tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
  });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
  await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

describe('the snapshot', () => {
  it('describes the settled trade in the client’s own terms', async () => {
    const s = await buildReceiptSnapshot(w.app, tradeId);
    expect(s.tradeRef).toBe(tradeRef);
    expect(s.direction).toBe('SELL_USDT');
    expect(s.base).toEqual({ amount: '1000.000000', currency: 'USDT' });
    expect(s.inr).toEqual({ amount: '90000.00', currency: 'INR' });
    expect(s.clientRate).toBe(CLIENT_RATE);
    expect(s.destination).toMatch(/•••• \d{4}$/);
    expect(s.payments).toHaveLength(2);
    expect(s.payments.map((p) => p.amount)).toEqual(['50000.00', '40000.00']);
    // The full bank reference is on the client's own receipt (D-09); a masked one would be useless to their bank.
    for (const p of s.payments) expect(p.reference).toMatch(/^[A-Z0-9]{8,22}$/);
    expect(s.totalPaid).toEqual({ amount: '90000.00', currency: 'INR' });
    expect(s.funding?.reference).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('carries nothing of the desk’s, by key or by figure', async () => {
    const s = await buildReceiptSnapshot(w.app, tradeId);
    const json = canonicalJson(s as never);
    for (const key of Object.keys(flatten(s))) expect(FORBIDDEN_CLIENT_KEY.test(key.split('.').at(-1) ?? ''), key).toBe(false);
    // The desk bought at 92.50 and sold at 90.00, making ₹2,500. None of that is the client's business (S14).
    for (const value of ['92.50', '92.500000', '2500.00']) expect(json.includes(value), `leaks ${value}`).toBe(false);
  });

  it('refuses to describe a trade that has not finished', async () => {
    const open = await openTrade(w, { baseUsdt: '10', clientRate: CLIENT_RATE, routeRate: ROUTE_RATE, executionMode: 'TO_EXCHANGE' });
    await expect(buildReceiptSnapshot(w.app, open.tradeId)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('issuing', () => {
  it('writes one receipt, however often the event is redelivered', async () => {
    const first = await issueReceipt(w.app, { tradeId });
    expect(first.issued).toBe(true);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

    for (let i = 0; i < 3; i++) {
      const again = await issueReceipt(w.app, { tradeId });
      expect(again.issued).toBe(false);
      expect(again.receiptId).toBe(first.receiptId);
      expect(again.sha256).toBe(first.sha256);
    }
    const rows = await w.t.owner.selectFrom('receipt').select('id').where('trade_id', '=', tradeId).execute();
    expect(rows).toHaveLength(1);
  });

  it('is what the outbox handler does with `receipt.generate`', async () => {
    const other = await openTrade(w, { baseUsdt: '20', clientRate: CLIENT_RATE, routeRate: ROUTE_RATE, executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, other.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
      tradeId: other.tradeId, amount: '1800.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
    await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });

    // Completion enqueued the event; the worker's own handler turns it into the document.
    await dispatchOutbox(w.t.worker, [receiptHandler(w.app), { name: 'ignore_rest', handles: (t) => t !== 'receipt.generate', run: async () => {} }]);
    const receipt = await getReceipt(w.app, other.tradeRef);
    expect(receipt?.snapshot.tradeRef).toBe(other.tradeRef);
  });

  it('records the issue in the audit trail, with the hash and not the document', async () => {
    const event = await w.t.owner
      .selectFrom('audit_event')
      .select(['action', 'after'])
      .where('action', '=', 'receipt.generated')
      .orderBy('seq', 'desc')
      .executeTakeFirstOrThrow();
    const after = event.after as Record<string, unknown>;
    expect(after.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(after.snapshot_json).toBeUndefined();
  });
});

describe('regeneration is byte-stable', () => {
  it('reproduces every artifact from the stored snapshot, and says so with the hash', async () => {
    await issueReceipt(w.app, { tradeId });
    const stored = await getReceipt(w.app, tradeRef);
    expect(stored).not.toBeNull();

    for (const format of ['json', 'csv', 'html'] as const) {
      const first = regenerateReceipt(stored!, format);
      const second = regenerateReceipt(stored!, format);
      expect(second.body).toBe(first.body);
      expect(first.sha256).toBe(stored!.hashes[format]);
      expect(sha256(first.body)).toBe(stored!.hashes[format]);
    }
  });

  it('is the same document after the rows around it have moved on', async () => {
    const stored = await getReceipt(w.app, tradeRef);
    const before = regenerateReceipt(stored!, 'html').body;

    // The client is renamed and their destination archived — both perfectly ordinary, and both things a
    // receipt built from a live view would silently follow.
    await sql`update client set display_name = 'Acme Pay (renamed)', version = version + 1 where id = ${w.clientId}`.execute(w.t.owner);
    await sql`update bank_account set status = 'ARCHIVED', archived_by = 'test', archived_at = statement_timestamp() where id = ${w.bankAccountId}`.execute(w.t.owner);

    const after = await getReceipt(w.app, tradeRef);
    const regenerated = regenerateReceipt(after!, 'html');
    expect(regenerated.body).toBe(before);
    expect(regenerated.sha256).toBe(stored!.hashes.html);
    expect(after!.snapshot.clientName).toBe('Acme Pay');
  });

  it('raises rather than quietly handing over a different document', async () => {
    const stored = await getReceipt(w.app, tradeRef);
    const tampered = { ...stored!, hashes: { ...stored!.hashes, csv: 'f'.repeat(64) } };
    expect(() => regenerateReceipt(tampered, 'csv')).toThrow(/does not match the issued document/);
  });

  it('cannot be rewritten in the database', async () => {
    await expect(sql`update receipt set sha256 = ${'a'.repeat(64)} where trade_id = ${tradeId}`.execute(w.t.owner)).rejects.toThrow();
    await expect(sql`delete from receipt where trade_id = ${tradeId}`.execute(w.t.owner)).rejects.toThrow();
  });
});

describe('the artifacts themselves', () => {
  it('serializes canonically: sorted keys, no whitespace, decimal strings', () => {
    expect(canonicalJson({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
    expect(canonicalJson({ a: ['1', null, true] })).toBe('{"a":["1",null,true]}');
    // Two objects that differ only in key order are the same document, and hash the same.
    expect(sha256(canonicalJson({ a: '1', b: '2' }))).toBe(sha256(canonicalJson({ b: '2', a: '1' })));
  });

  it('writes a CSV a spreadsheet opens: RFC 4180 quoting, CRLF, one row per payment', async () => {
    const snapshot = (await getReceipt(w.app, tradeRef))!.snapshot;
    const csv = receiptCsv(snapshot);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(1 + snapshot.payments.length);
    expect(lines[0]).toContain('trade_ref,client,direction');
    expect(lines[1]).toContain(snapshot.tradeRef);
    // Ungrouped decimals in machine formats (D-11).
    expect(csv).toContain('50000.00');
    expect(csv).not.toContain('50,000');

    const quoted = receiptCsv({ ...snapshot, clientName: 'Acme, "the" Pay' });
    expect(quoted).toContain('"Acme, ""the"" Pay"');
  });

  it('writes a standalone print document: no network, no script, grouped figures', async () => {
    const snapshot = (await getReceipt(w.app, tradeRef))!.snapshot;
    const html = receiptHtml(snapshot);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script|src=|href=|@import/i);
    // Grouped for a person (D-11), and every payment reference present in full.
    expect(html).toContain('₹90,000.00');
    for (const p of snapshot.payments) expect(html).toContain(p.reference);
    expect(html).toContain('SETTLED');
  });

  it('escapes what a client put in their own name', () => {
    const html = receiptHtml({ ...({} as ReceiptSnapshot), ...stub(), clientName: '<script>alert(1)</script>' });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });

  it('hashes all three artifacts together', async () => {
    const snapshot = (await getReceipt(w.app, tradeRef))!.snapshot;
    const a = receiptArtifacts(snapshot);
    expect(a.hashes.json).toBe(sha256(a.json));
    expect(a.hashes.csv).toBe(sha256(a.csv));
    expect(a.hashes.html).toBe(sha256(a.html));
    expect(new Set([a.hashes.json, a.hashes.csv, a.hashes.html]).size).toBe(3);
  });
});

function stub(): ReceiptSnapshot {
  return {
    schema: 'inrp2p.receipt.v1',
    tradeRef: 'IX-260919-0001',
    clientName: 'Acme',
    direction: 'SELL_USDT',
    base: { amount: '1.000000', currency: 'USDT' },
    inr: { amount: '90.00', currency: 'INR' },
    clientRate: '90.000000',
    network: 'TRON',
    destination: 'HDFC Bank •••• 8219',
    funding: null,
    payments: [],
    totalPaid: { amount: '0.00', currency: 'INR' },
    acceptedAt: '2026-09-19T09:11:00.000Z',
    completedAt: '2026-09-19T09:12:00.000Z',
    issuer: { name: 'INRP2P Exchange' },
  };
}

function flatten(value: unknown, prefix = '$', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}.${i}`, out));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, `${prefix}.${k}`, out);
  return out;
}

describe('an adjusted trade is receipted at what actually changed hands (FI-12)', () => {
  // Its own world: the suite above archives the client's bank account to prove a snapshot does not follow it.
  let a: World;
  beforeAll(async () => { a = await createWorld('receipts_adjusted', { capacityInr: '500000000.00' }); });
  afterAll(async () => a.close());

  it('writing off an unpaid remainder receipts the INR the client received, not the INR it was quoted', async () => {
    const w = a;
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: CLIENT_RATE, routeRate: ROUTE_RATE, executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
      tradeId: trade.tradeId, amount: '8900.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
    await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    const requested = await runAs(w.app, requestAdjustment(w.financeOp.actor), w.financeOp.ref, 'adjustment.request', {
      tradeId: trade.tradeId, type: 'WRITE_OFF' as const, deltaClientInr: '-100.00', reason: 'client agreed to settle the last ₹100 as a fee',
    });
    await runAs(w.app, approveAdjustment(w.financeOp2.actor), w.financeOp2.ref, 'adjustment.approve', { adjustmentId: requested.adjustmentId });

    const s = await buildReceiptSnapshot(w.app, trade.tradeId);
    expect(s.inr).toEqual({ amount: '8900.00', currency: 'INR' });
    expect(s.totalPaid).toEqual({ amount: '8900.00', currency: 'INR' });
    expect(s.base).toEqual({ amount: '100.000000', currency: 'USDT' });
  });
});
