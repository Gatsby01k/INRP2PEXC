import { describe, expect, it } from 'vitest';
import { draftFor } from '@inrp2p/notifications';
import { RECEIPT_SNAPSHOT_VERSION, type ReceiptSnapshot, receiptHtml } from '@inrp2p/reporting';
import type { NotificationKind } from '@inrp2p/db';
import { ACTIONS, FOOTER_NOTE, SITE_NAME, SITE_PAGES, SITE_PATHS, STEPS, TAGLINE } from '../src/content/site.ts';

/**
 * The copy review, as a test (D-07, PRODUCT §7.4, launch checklist).
 *
 * Two rules, and both of them exist because the alternative is a promise this business cannot keep.
 *
 * **No regulatory claim.** Until India counsel has confirmed what may be said (D-07), nothing client-facing
 * claims a registration, a licence, an approval or a compliance status. This is not a wording preference: an
 * unlicensed claim of a licence is the kind of sentence that ends a company. A human review catches it on the
 * day it is written and misses it the day someone edits a paragraph in a hurry, which is why it is a test.
 *
 * **No invented figure.** The public site has no data behind it, so any number in it would be one somebody made
 * up — volumes, rates, settlement times, customer counts, reviews. Describing a mechanism is allowed and is
 * most of what the site does; claiming a speed or a size is not. Receipts and notifications are exempt from
 * this second rule and only this second rule, because their numbers come from the trade they describe.
 */

/** Phrases that assert standing with an authority. `registered` alone is not one — destinations are registered. */
const REGULATORY = [
  /\bregulated\b/i,
  /\bregulator\b/i,
  /\blicen[sc]ed?\b/i,
  /\bregistered (with|as|under|by)\b/i,
  /\bauthoris?z?ed by\b/i,
  /\bapproved by\b/i,
  /\bgovernment[- ]approved\b/i,
  /\bcomplian(t|ce)\b/i,
  /\bFIU\b/,
  /\bPMLA\b/,
  /\bRBI\b/,
  /\bSEBI\b/,
  /\bVDA\b/,
  /\bKYC[- ]verified\b/i,
  /\bfully vetted\b/i,
  /\blegal tender\b/i,
];

/** Claims that need a number behind them, and claims that are a number. */
const FABRICATED = [
  /\b\d+(\.\d+)?\s*%/,
  /₹\s*\d/,
  /\$\s*\d/,
  /\b\d[\d,]*\s*(crore|lakh|million|billion|users?|clients?|trades?|customers?)\b/i,
  /\b(24\/7|24x7)\b/i,
  /\binstant(ly|aneous)?\b/i,
  /\bwithin (a few )?(seconds?|minutes?|hours?)\b/i,
  /\bsame[- ]day\b/i,
  /\bnext[- ]day\b/i,
  /\b(fastest|quickest|cheapest|lowest|best|highest)\s+(rate|rates|price|prices|fee|fees|spread|spreads)\b/i,
  /\bguarantee[sd]?\b/i,
  /\bno fees?\b/i,
  /\bzero fees?\b/i,
  /\b(thousands|millions|hundreds) of\b/i,
  /\btrusted by\b/i,
  /\b\d+\s*(star|stars|reviews?|ratings?)\b/i,
];

/** Digits that are part of a name rather than a claim. Everything else in site copy must be spelled out. */
const ALLOWED_DIGIT_TOKENS = [/TRC20/g, /INRP2P/g, /TRON/g];

/** Every sentence the public site says, in one string, with its source named for the failure message. */
const SITE_COPY: readonly { readonly where: string; readonly text: string }[] = [
  { where: 'SITE_NAME', text: SITE_NAME },
  { where: 'TAGLINE', text: TAGLINE },
  { where: 'FOOTER_NOTE', text: FOOTER_NOTE },
  ...ACTIONS.map((a) => ({ where: `ACTIONS ${a.label}`, text: a.label })),
  ...STEPS.flatMap((s) => [
    { where: `STEPS ${s.title}`, text: s.title },
    { where: `STEPS ${s.title} body`, text: s.body },
  ]),
  ...SITE_PAGES.flatMap((p) => [
    { where: `${p.path} title`, text: p.title },
    { where: `${p.path} description`, text: p.description },
    { where: `${p.path} h1`, text: p.h1 },
    { where: `${p.path} lede`, text: p.lede },
    ...p.sections.flatMap((s) => [
      { where: `${p.path} § ${s.heading}`, text: s.heading },
      ...s.body.map((b, i) => ({ where: `${p.path} § ${s.heading} ¶${i + 1}`, text: b })),
    ]),
  ]),
];

/** Every notification a client can receive, drafted with facts that are deliberately unremarkable. */
const KINDS: readonly NotificationKind[] = [
  'QUOTE_SENT', 'QUOTE_EXPIRED', 'REQUEST_DECLINED', 'TRADE_OPENED', 'PAYOUT_CONFIRMED', 'TRADE_COMPLETED',
  'TRADE_CANCELLED', 'DESTINATION_ADDED', 'DESTINATION_ARCHIVED',
];

const NOTIFICATION_COPY = KINDS.map((kind) => {
  const draft = draftFor(kind, {
    quoteRef: 'QT-260920-0001', tradeRef: 'IX-260920-0001', inr: '10200000.00', base: '100000.000000',
    paid: '6000000.00', of: '10200000.00', reason: 'The route is unavailable today.', label: 'HDFC •••• 4321',
    expiresAt: new Date('2026-09-20T09:11:00.000Z'), direction: 'SELL_USDT',
  });
  return { where: `notification ${kind}`, text: `${draft.title} ${draft.body}` };
});

/** The words a receipt prints that do not come from the trade: headings, labels, the issuer's own name. */
const RECEIPT_SNAPSHOT: ReceiptSnapshot = {
  schema: `inrp2p.receipt.v${RECEIPT_SNAPSHOT_VERSION}`,
  tradeRef: 'IX-260920-0001',
  clientName: 'Acme Exports Pvt Ltd',
  direction: 'SELL_USDT',
  base: { amount: '100000.000000', currency: 'USDT' },
  inr: { amount: '10200000.00', currency: 'INR' },
  clientRate: '102.000000',
  network: 'TRON',
  destination: 'HDFC Bank •••• 4321',
  funding: null,
  payments: [{ ref: 'LEG-1', amount: '10200000.00', currency: 'INR', reference: 'HDFCR0001', rail: 'IMPS', confirmedAt: '2026-09-20T09:05:00.000Z' }],
  totalPaid: { amount: '10200000.00', currency: 'INR' },
  acceptedAt: '2026-09-20T08:55:00.000Z',
  completedAt: '2026-09-20T09:11:00.000Z',
  issuer: { name: 'INRP2P Exchange' },
};

const RECEIPT_TEXT = receiptHtml(RECEIPT_SNAPSHOT)
  .slice(receiptHtml(RECEIPT_SNAPSHOT).indexOf('<body'))
  .replace(/<[^>]+>/g, ' ');

/**
 * The guard, held against copy written to fail it.
 *
 * A rule that has only ever been run against text written to satisfy it proves nothing about the rule. These
 * are the sentences a well-meaning person actually writes when asked to make a landing page convincing.
 */
const VIOLATIONS: readonly { readonly text: string; readonly rule: 'regulatory' | 'figure' }[] = [
  { text: 'A fully regulated USDT desk.', rule: 'regulatory' },
  { text: 'We are licensed to operate in India.', rule: 'regulatory' },
  { text: 'Registered with FIU-IND under the PMLA.', rule: 'regulatory' },
  { text: 'Our processes are fully compliant.', rule: 'regulatory' },
  { text: 'Approved by the RBI.', rule: 'regulatory' },
  { text: 'Settlement within minutes, every time.', rule: 'figure' },
  { text: 'Over ₹500 crore settled to date.', rule: 'figure' },
  { text: 'Trusted by thousands of traders.', rule: 'figure' },
  { text: 'The best rates in India, guaranteed.', rule: 'figure' },
  { text: 'Desk open 24/7.', rule: 'figure' },
  { text: 'Instant INR payouts with zero fees.', rule: 'figure' },
  { text: 'Rated 4.9 stars by 1,200 clients.', rule: 'figure' },
];

describe('the guard itself catches what it is for', () => {
  it.each(VIOLATIONS)('refuses "$text"', ({ text, rule }) => {
    const patterns = rule === 'regulatory' ? REGULATORY : FABRICATED;
    expect(patterns.some((p) => p.test(text)), `no rule matched "${text}"`).toBe(true);
  });

  it('lets the mechanism sentences the site is actually made of through', () => {
    const allowed = [
      'INR is paid to an Indian bank account registered against your client record.',
      'Each sell trade is issued its own TRC20 deposit address.',
      'The quote carries its expiry in it.',
      'Destinations are registered before a trade, not typed during one.',
    ];
    for (const text of allowed) {
      expect([...REGULATORY, ...FABRICATED].some((p) => p.test(text)), `a rule wrongly matched "${text}"`).toBe(false);
    }
  });
});

describe('the public site says nothing it cannot stand behind', () => {
  it.each(SITE_COPY)('$where carries no regulatory claim', ({ text }) => {
    for (const pattern of REGULATORY) expect(text, `matched ${pattern}`).not.toMatch(pattern);
  });

  it.each(SITE_COPY)('$where carries no invented figure', ({ text }) => {
    for (const pattern of FABRICATED) expect(text, `matched ${pattern}`).not.toMatch(pattern);
  });

  it.each(SITE_COPY)('$where contains no bare number at all', ({ where, text }) => {
    // Stronger than the pattern list and much harder to work around: on a site with no data behind it, a digit
    // is either part of a protocol's name or a figure somebody invented.
    let stripped = text;
    for (const token of ALLOWED_DIGIT_TOKENS) stripped = stripped.replaceAll(token, '');
    expect(stripped, `${where} contains a digit`).not.toMatch(/\d/);
  });
});

describe('what a client is told', () => {
  it.each(NOTIFICATION_COPY)('$where carries no regulatory claim', ({ text }) => {
    for (const pattern of REGULATORY) expect(text, `matched ${pattern}`).not.toMatch(pattern);
  });

  it('does carry the figures of the trade it describes, which is the point', () => {
    // The exemption is deliberate and narrow: a notification's numbers come from the client's own trade. This
    // asserts the exemption is real, so nobody "fixes" the guard by stripping figures from notifications.
    const completed = NOTIFICATION_COPY.find((c) => c.where.endsWith('TRADE_COMPLETED'));
    expect(completed?.text).toMatch(/\d/);
  });
});

describe('the receipt a client keeps', () => {
  it('claims no standing with any authority', () => {
    for (const pattern of REGULATORY) expect(RECEIPT_TEXT, `matched ${pattern}`).not.toMatch(pattern);
  });

  it('carries the trade\u2019s own figures, which is what a receipt is', () => {
    expect(RECEIPT_TEXT).toContain('HDFCR0001');
    expect(RECEIPT_TEXT).toMatch(/\d/);
  });
});

describe('the pages themselves', () => {
  it('are the six PRODUCT §7.4 routes, each published once', () => {
    expect(SITE_PATHS).toEqual(['/', '/usdt-to-inr', '/inr-to-usdt', '/sell-usdt-in-india', '/buy-usdt-in-india', '/usdt-otc-india']);
    expect(new Set(SITE_PATHS).size).toBe(SITE_PATHS.length);
  });

  it('each say something different from the others', () => {
    // Six near-identical pages is what a search engine calls doorway pages, and what a reader calls padding.
    expect(new Set(SITE_PAGES.map((p) => p.title)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.map((p) => p.description)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.map((p) => p.h1)).size).toBe(SITE_PAGES.length);
    expect(new Set(SITE_PAGES.flatMap((p) => p.sections.map((s) => s.body.join(' ')))).size).toBe(SITE_PAGES.flatMap((p) => p.sections).length);
  });

  it('carry a title and description a search result can actually show', () => {
    for (const page of SITE_PAGES) {
      expect(page.title.length, `${page.path} title`).toBeLessThanOrEqual(70);
      expect(page.description.length, `${page.path} description`).toBeGreaterThanOrEqual(70);
      expect(page.description.length, `${page.path} description`).toBeLessThanOrEqual(200);
      expect(page.sections.length, `${page.path} sections`).toBeGreaterThanOrEqual(2);
      expect(page.h1.length).toBeGreaterThan(3);
    }
  });

  it('send every call to action into the client app rather than to a form that cannot work', () => {
    expect(ACTIONS).toHaveLength(3);
    for (const action of ACTIONS) expect(action.appPath.startsWith('/exchange')).toBe(true);
  });
});
