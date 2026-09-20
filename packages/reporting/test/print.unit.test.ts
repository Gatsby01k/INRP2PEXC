import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@inrp2p/ui/contrast';
import { RECEIPT_SNAPSHOT_VERSION, type ReceiptSnapshot, receiptCsv, receiptHtml } from '../src/index.ts';

/**
 * The grayscale print check (IMPLEMENTATION_PLAN Phase 8).
 *
 * A receipt's working life is on paper, and most of that paper comes out of a black-and-white printer. So the
 * document may not depend on hue for anything: every colour it uses has to survive being flattened to its
 * luminance and still separate from what sits behind it. That is testable, so it is tested rather than
 * asserted in a comment — the check reads the colours out of the document itself, which means a future edit
 * that introduces a red "overdue" or a green "paid" fails here instead of at a client's printer.
 */
const SNAPSHOT: ReceiptSnapshot = {
  schema: `inrp2p.receipt.v${RECEIPT_SNAPSHOT_VERSION}`,
  tradeRef: 'IX-260919-0001',
  clientName: 'Acme Exports Pvt Ltd',
  direction: 'SELL_USDT',
  base: { amount: '100000.000000', currency: 'USDT' },
  inr: { amount: '10200000.00', currency: 'INR' },
  clientRate: '102.000000',
  network: 'TRON',
  destination: 'HDFC Bank •••• 4321',
  funding: { reference: '0x'.padEnd(66, 'a'), amount: '100000.000000', currency: 'USDT', confirmedAt: '2026-09-19T09:00:00.000Z' },
  payments: [
    { ref: 'LEG-1', amount: '6000000.00', currency: 'INR', reference: 'IXVIS6000000', rail: 'IMPS', confirmedAt: '2026-09-19T09:05:00.000Z' },
    { ref: 'LEG-2', amount: '4200000.00', currency: 'INR', reference: 'IXVIS4200000', rail: 'IMPS', confirmedAt: '2026-09-19T09:10:00.000Z' },
  ],
  totalPaid: { amount: '10200000.00', currency: 'INR' },
  acceptedAt: '2026-09-19T08:55:00.000Z',
  completedAt: '2026-09-19T09:11:00.000Z',
  issuer: { name: 'INRP2P Exchange' },
};

/** `#rgb`, `#rrggbb` and `#rrggbbaa` — the last composited onto white, which is what a printed page is. */
function rgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const channel = (i: number) => Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);
  const [r, g, b] = [channel(0), channel(1), channel(2)];
  if (full.length !== 8) return { r: r!, g: g!, b: b! };
  const a = channel(3) / 255;
  const over = (c: number) => Math.round(c * a + 255 * (1 - a));
  return { r: over(r!), g: over(g!), b: over(b!) };
}

const toHex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
const chroma = (c: { r: number; g: number; b: number }) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);

const HTML = receiptHtml(SNAPSHOT);
const COLOURS = [...HTML.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);

describe('the printed receipt', () => {
  it('uses colour nowhere that hue carries the meaning', () => {
    expect(COLOURS.length).toBeGreaterThan(4);
    for (const hex of COLOURS) {
      // Near-neutral: flattening to grayscale moves every one of these by a few points at most, so nothing on
      // the page is distinguished by being redder or greener than its neighbour.
      expect(chroma(rgb(hex)), `${hex} is too saturated for a document that prints in grayscale`).toBeLessThanOrEqual(24);
    }
  });

  it('keeps its text readable against the paper it is printed on', () => {
    // The document's two backgrounds: the page, and the paper panel the receipt is drawn on.
    const ink = '#141210';
    const secondary = '#5c554e';
    for (const paper of ['#ffffff', '#fff8ee']) {
      expect(contrastRatio(ink, paper)).toBeGreaterThanOrEqual(4.5);
      // Labels and footnotes are small text and get the same bar, not the large-text exemption.
      expect(contrastRatio(secondary, paper)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('carries no image, font or stylesheet it would have to fetch to print correctly', () => {
    expect(HTML).not.toMatch(/\bsrc=/);
    expect(HTML).not.toMatch(/<link\b/);
    expect(HTML).not.toMatch(/@import/);
    expect(HTML).not.toMatch(/url\(/);
    // Offline is the normal case for a saved receipt; a document that degrades without the network is not one.
    expect(HTML).toContain('<style>');
  });

  it('drops the screen’s framing when it goes to paper', () => {
    expect(HTML).toContain('@media print');
    expect(HTML).toMatch(/@media print\{body\{padding:0\}\.paper\{border:none;background:#fff\}\}/);
  });

  it('says in words what a colour might otherwise have said', () => {
    expect(HTML).toContain('SETTLED');
    expect(receiptCsv(SNAPSHOT)).toContain('IXVIS6000000');
  });

  it('uses only colours the style sheet declares, not ones the content smuggles in', () => {
    const style = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
    for (const hex of COLOURS) expect(style).toContain(hex);
    // The opaque palette is small on purpose: paper, ink and a quieter ink for labels. The rest are the same
    // ink at low alpha, drawing rules — which is why they all flatten to grays of that one ink.
    const opaque = COLOURS.filter((h) => h.length !== 9);
    expect(new Set(opaque.map((h) => toHex(rgb(h)))).size).toBeLessThanOrEqual(4);
    for (const hex of COLOURS.filter((h) => h.length === 9)) expect(hex.toLowerCase().startsWith('#141210')).toBe(true);
  });
});
