import { afterAll, describe, expect, it } from 'vitest';
import { ChromiumPdfRenderer, UnconfiguredPdfRenderer, defaultChromiumPath, isPdfRendererConfigured } from '@inrp2p/adapters';
import { type ReceiptSnapshot, receiptHtml } from '../src/index.ts';

/**
 * Printing a receipt.
 *
 * The interesting assertions are not "it produced bytes". They are that the printed document needs nothing from
 * the network, that it is a real PDF a person's reader will open, and that every distinction it draws survives a
 * grayscale printer — which is the first thing anyone does with a receipt.
 */
// A skipped test is not a gate, so the browser is resolved the same way the runtime resolves it, and these
// only skip when the machine genuinely has none.
const CHROMIUM = defaultChromiumPath(process.env.RECEIPT_CHROMIUM ?? process.env.LIGHTHOUSE_CHROME);
const available = CHROMIUM !== null;

const SNAPSHOT: ReceiptSnapshot = {
  schema: 'inrp2p.receipt.v1',
  tradeRef: 'IX-260919-0042',
  clientName: 'Acme Pay Private Limited',
  direction: 'SELL_USDT',
  base: { amount: '1000.000000', currency: 'USDT' },
  inr: { amount: '90000.00', currency: 'INR' },
  clientRate: '90.000000',
  network: 'TRON',
  destination: 'HDFC Bank •••• 8219',
  funding: { reference: 'a'.repeat(64), amount: '1000.000000', currency: 'USDT', confirmedAt: '2026-09-19T09:11:00.000Z' },
  payments: [
    { ref: 'LG-000001', amount: '50000.00', currency: 'INR', reference: 'HDFCR52026091617118', rail: 'IMPS', confirmedAt: '2026-09-19T09:20:00.000Z' },
    { ref: 'LG-000002', amount: '40000.00', currency: 'INR', reference: 'ICICR52026091614412', rail: 'IMPS', confirmedAt: '2026-09-19T10:05:00.000Z' },
  ],
  totalPaid: { amount: '90000.00', currency: 'INR' },
  acceptedAt: '2026-09-19T09:00:00.000Z',
  completedAt: '2026-09-19T10:05:00.000Z',
  issuer: { name: 'INRP2P Exchange' },
};

const renderer = CHROMIUM ? new ChromiumPdfRenderer({ executablePath: CHROMIUM }) : null;
afterAll(async () => renderer?.close());

describe('the PDF renderer port', () => {
  it('refuses loudly when nothing is configured, and says what is still available', async () => {
    const unconfigured = new UnconfiguredPdfRenderer();
    expect(isPdfRendererConfigured(unconfigured)).toBe(false);
    await expect(unconfigured.render({ html: '<p>x</p>', title: 't' })).rejects.toThrow(/PDF_RENDERER_NOT_CONFIGURED.*JSON, CSV/s);
  });
});

describe.skipIf(!available)('printing with Chromium', () => {
  it('prints the receipt document to a real PDF', async () => {
    const pdf = await renderer!.render({ html: receiptHtml(SNAPSHOT), title: `Receipt ${SNAPSHOT.tradeRef}` });
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(pdf.subarray(-6)).toString('latin1')).toContain('EOF');
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(isPdfRendererConfigured(renderer!)).toBe(true);
  }, 60_000);

  it('prints the same document twice without fetching anything', async () => {
    // Nothing in a receipt may depend on a request: a document whose look changes when a CDN does is not a
    // record of anything. The HTML carries no reference out, so this is a property of the document, not of luck.
    const html = receiptHtml(SNAPSHOT);
    expect(html).not.toMatch(/\b(src|href)\s*=/i);
    expect(html).not.toMatch(/@import|url\(/i);
    const a = await renderer!.render({ html, title: 'a' });
    const b = await renderer!.render({ html, title: 'a' });
    // PDF writers stamp a creation time, so the bytes differ; the page count and size do not.
    expect(Math.abs(a.byteLength - b.byteLength)).toBeLessThan(512);
  }, 60_000);

  it('survives a grayscale printer: every distinction is carried by text, weight or a rule', async () => {
    const html = receiptHtml(SNAPSHOT);
    // The document's whole palette. Each is near-black, a warm paper white, or a muted grey — nothing in it
    // distinguishes one fact from another by hue, so a monochrome print loses no information.
    const colours = [...html.matchAll(/#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]!.toLowerCase());
    expect(colours.length).toBeGreaterThan(0);
    for (const colour of new Set(colours)) expect(isNeutral(colour), `${colour} is not neutral`).toBe(true);
    // Status is a word in a box, not a colour.
    expect(html).toContain('SETTLED');
  });
});

/** True when a hex colour has no meaningful hue: the channels sit within a few points of each other. */
function isNeutral(hex: string): boolean {
  const body = hex.slice(1);
  const expand = body.length === 3 ? [...body].map((c) => c + c).join('') : body;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(expand.slice(i, i + 2), 16));
  if (r === undefined || g === undefined || b === undefined || Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
  // Warm paper (#FFF8EE) is not strictly neutral; the tolerance is the width of that warmth and no wider.
  return Math.max(r, g, b) - Math.min(r, g, b) <= 20;
}
