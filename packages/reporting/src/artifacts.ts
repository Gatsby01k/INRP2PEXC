import { Money, Rate } from '@inrp2p/kernel';
import { formatInr, formatIstDateTime, formatRate, formatUsdt } from '@inrp2p/ui/format';
import { canonicalJson, sha256 } from './canonical.ts';
import { csvDocument } from './csv.ts';
import type { ReceiptSnapshot } from './snapshot.ts';

/**
 * The three documents a receipt is, all derived from the snapshot and from nothing else.
 *
 * That constraint is the feature. Because none of them reads a row, a receipt regenerated next year is the same
 * bytes as the one issued today, and the recorded hash is what says so. It also means there is exactly one place
 * a figure can come from: if a number on the PDF disagrees with the CSV, one of these functions is wrong — the
 * data cannot be.
 *
 * JSON and CSV carry ungrouped decimals, for machines (D-11). The HTML is for a person, and groups them.
 */
export interface ReceiptArtifacts {
  readonly json: string;
  readonly csv: string;
  readonly html: string;
  readonly hashes: { readonly json: string; readonly csv: string; readonly html: string };
}

export function receiptArtifacts(snapshot: ReceiptSnapshot): ReceiptArtifacts {
  const json = receiptJson(snapshot);
  const csv = receiptCsv(snapshot);
  const html = receiptHtml(snapshot);
  return { json, csv, html, hashes: { json: sha256(json), csv: sha256(csv), html: sha256(html) } };
}

/** The snapshot itself, canonically serialized: what the sha256 in the `receipt` row is taken over. */
export const receiptJson = (snapshot: ReceiptSnapshot): string => canonicalJson(snapshot as never);

// ---------------------------------------------------------------------------------------------------------
// CSV. One row per payment, trade columns repeated, so the file opens as a table in any spreadsheet without a
// person having to reshape it first. The writer itself lives in `csv.ts` and is shared with the finance exports.
// ---------------------------------------------------------------------------------------------------------

const CSV_COLUMNS = [
  'trade_ref', 'client', 'direction', 'usdt', 'inr', 'rate', 'network', 'destination', 'accepted_at', 'completed_at',
  'payment_ref', 'payment_amount', 'payment_currency', 'payment_reference', 'payment_rail', 'payment_confirmed_at',
] as const;

export function receiptCsv(snapshot: ReceiptSnapshot): string {
  const trade = [
    snapshot.tradeRef, snapshot.clientName, snapshot.direction, snapshot.base.amount, snapshot.inr.amount,
    snapshot.clientRate, snapshot.network, snapshot.destination, snapshot.acceptedAt, snapshot.completedAt,
  ];
  const rows = snapshot.payments.map((p) => [...trade, p.ref, p.amount, p.currency, p.reference, p.rail ?? '', p.confirmedAt]);
  // A completed trade always has at least one payment; the empty row exists so the file is still a table if the
  // impossible ever happens, rather than a header with nothing under it.
  return csvDocument(CSV_COLUMNS, rows.length > 0 ? rows : [[...trade, '', '', '', '', '', '']]);
}

// ---------------------------------------------------------------------------------------------------------
// HTML — a standalone print document, not an app page.
//
// Everything is inline: no stylesheet to fetch, no font to load, no script. A receipt has to render the same in
// a browser, in a print preview and in whatever headless Chromium a PDF is made with, on a machine that has
// never heard of this application. It is also grayscale-safe: every distinction is carried by text, weight or a
// rule, never by colour alone, because the first thing anyone does with a receipt is print it.
// ---------------------------------------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

const STYLE = `
*{box-sizing:border-box}
body{margin:0;padding:32px;background:#fff;color:#141210;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.paper{max-width:680px;margin:0 auto;background:#FFF8EE;border:1px solid #1412101f;padding:32px}
.head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1px solid #14121026;padding-bottom:16px;margin-bottom:24px}
.brand{margin:0;font-weight:600;letter-spacing:-0.01em}
.doc{margin:2px 0 0;color:#5c554e}
.settled{margin:0;font-weight:600;letter-spacing:0.08em;font-size:12px;border:1px solid #141210;padding:4px 10px}
dl.facts{display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;margin:0 0 24px}
dl.facts div{margin:0}
dt{margin:0;font-size:12px;color:#5c554e}
dd{margin:2px 0 0;font-weight:500}
.num{font-variant-numeric:tabular-nums}
h2{font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:#5c554e;margin:24px 0 8px;font-weight:600}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 0;border-bottom:1px solid #14121014;font-size:13px}
th{font-size:12px;color:#5c554e;font-weight:500}
td.r,th.r{text-align:right}
tfoot td{font-weight:600;border-bottom:none;border-top:1px solid #141210}
.foot{margin-top:24px;padding-top:16px;border-top:1px solid #14121026;font-size:12px;color:#5c554e}
.foot p{margin:0 0 4px}
@media print{body{padding:0}.paper{border:none;background:#fff}}
`.trim();

export function receiptHtml(snapshot: ReceiptSnapshot): string {
  const sell = snapshot.direction === 'SELL_USDT';
  const usdt = formatUsdt(Money.parse(snapshot.base.amount, 'USDT'), { precision: 'exact' });
  const inr = formatInr(Money.parse(snapshot.inr.amount, 'INR'), { fraction: 'always' });
  const rate = formatRate(Rate.parse(snapshot.clientRate, 'CLIENT'));
  const paid = snapshot.totalPaid;

  /** A payout is INR on a SELL and USDT on a BUY; the document formats whichever it actually was. */
  const amount = (value: string, currency: 'INR' | 'USDT'): string =>
    currency === 'INR' ? formatInr(Money.parse(value, 'INR'), { fraction: 'always' }) : formatUsdt(Money.parse(value, 'USDT'), { precision: 'exact' });

  const fact = (term: string, value: string, numeric = false): string =>
    `<div><dt>${escapeHtml(term)}</dt><dd${numeric ? ' class="num"' : ''}>${escapeHtml(value)}</dd></div>`;

  const rows = snapshot.payments
    .map(
      (p) =>
        `<tr><td class="num">${escapeHtml(p.ref)}</td>` +
        `<td class="num">${escapeHtml(formatIstDateTime(new Date(p.confirmedAt)))}</td>` +
        `<td class="num">${escapeHtml(p.reference)}</td>` +
        `<td class="num r">${escapeHtml(amount(p.amount, p.currency))}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Settlement receipt ${escapeHtml(snapshot.tradeRef)}</title>
<meta name="robots" content="noindex, nofollow"><style>${STYLE}</style></head>
<body><article class="paper">
<header class="head"><div><p class="brand">${escapeHtml(snapshot.issuer.name)}</p><p class="doc">Settlement receipt</p></div><p class="settled">SETTLED</p></header>
<dl class="facts">
${fact('Trade', snapshot.tradeRef, true)}
${fact('Client', snapshot.clientName)}
${fact('Accepted', formatIstDateTime(new Date(snapshot.acceptedAt)), true)}
${fact('Completed', formatIstDateTime(new Date(snapshot.completedAt)), true)}
${fact('Direction', sell ? 'Sell USDT · receive INR' : 'Buy USDT · pay INR')}
${fact('Network', `TRC20 · ${snapshot.network}`)}
${fact(sell ? 'USDT sold' : 'USDT bought', usdt, true)}
${fact(sell ? 'INR received' : 'INR paid', inr, true)}
${fact('Rate', `${rate} / USDT`, true)}
${fact(sell ? 'Paid to' : 'Delivered to', snapshot.destination)}
</dl>
${snapshot.funding ? `<h2>Funds received</h2><dl class="facts">${fact('Reference', snapshot.funding.reference, true)}${fact('Amount', amount(snapshot.funding.amount, snapshot.funding.currency), true)}${fact('Confirmed', formatIstDateTime(new Date(snapshot.funding.confirmedAt)), true)}</dl>` : ''}
<h2>Payments</h2>
<table><thead><tr><th>Payment</th><th>Confirmed</th><th>Bank reference</th><th class="r">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="3">Total paid</td><td class="num r">${escapeHtml(amount(paid.amount, paid.currency))}</td></tr></tfoot></table>
<div class="foot"><p>This receipt is generated from an immutable record of the settled trade and does not change.</p>
<p class="num">Document ${escapeHtml(snapshot.schema)}</p></div>
</article></body></html>
`;
}
