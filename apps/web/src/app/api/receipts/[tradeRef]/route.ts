import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { isDomainError } from '@inrp2p/kernel';
import { type ReceiptFormat, getReceipt, regenerateReceipt } from '@inrp2p/reporting';
import { isPdfRendererConfigured } from '@inrp2p/adapters';
import { clientContext } from '../../../../server/client.ts';
import { can, operatorContext } from '../../../../server/operator.ts';
import { getRuntime } from '../../../../server/runtime.ts';
import { surfaceForHost } from '../../../../server/surface.ts';
import { pdfForWeb } from '../../../../server/pdf.ts';
import { authErrorResponse } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';

const FORMATS = new Set(['json', 'csv', 'html', 'pdf']);

/**
 * A settlement receipt, in whichever form the reader asked for.
 *
 * The same route serves both products, because it is the same document — but not the same authority. An
 * operator with `receipt:view` may fetch any trade's receipt; a client's session resolves to their own client
 * and the lookup is scoped to it, so another client's reference is simply not found.
 *
 * Every form is regenerated from the stored snapshot and checked against the hash recorded when the receipt was
 * issued. A mismatch is a 500, not a download: handing someone a document that differs from the one we issued,
 * without saying so, is the one failure a receipt cannot survive.
 */
export async function GET(request: Request, { params }: { params: Promise<{ tradeRef: string }> }) {
  const { tradeRef } = await params;
  const url = new URL(request.url);
  const format = (url.searchParams.get('format') ?? 'html').toLowerCase();
  if (!FORMATS.has(format)) return NextResponse.json({ error: 'INVALID_ARGUMENT', message: 'format must be json, csv, html or pdf' }, { status: 400, headers: { 'cache-control': 'no-store' } });

  const rt = getRuntime();
  const surface = surfaceForHost((await headers()).get('host'), rt.hosts);

  let scope: { clientId?: string };
  try {
    if (surface === 'OPERATOR') {
      const ctx = await operatorContext();
      if (!can(ctx, 'receipt:view')) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403, headers: { 'cache-control': 'no-store' } });
      scope = {};
    } else {
      const ctx = await clientContext();
      scope = { clientId: ctx.access.clientId };
    }
  } catch (err) {
    return authErrorResponse(err);
  }

  const receipt = await getReceipt(rt.appDb, decodeURIComponent(tradeRef), scope);
  // No receipt is "not found" rather than "not yet": a trade that has not completed has no document, and saying
  // which of the two it is would tell a client about a trade that may not be theirs.
  if (!receipt) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: { 'cache-control': 'no-store' } });

  try {
    if (format === 'pdf') {
      const renderer = pdfForWeb();
      if (!isPdfRendererConfigured(renderer)) {
        return NextResponse.json(
          { error: 'PDF_RENDERER_NOT_CONFIGURED', message: 'This deployment cannot print PDFs. The receipt is available as json, csv or html.' },
          { status: 503, headers: { 'cache-control': 'no-store' } },
        );
      }
      const html = regenerateReceipt(receipt, 'html');
      const pdf = await renderer.render({ html: html.body, title: `Settlement receipt ${receipt.tradeRef}` });
      return new NextResponse(Buffer.from(pdf), {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="receipt-${receipt.tradeRef}.pdf"`,
          // The hash of the document the PDF was printed from, not of the PDF: PDF writers stamp a creation
          // time, so their bytes differ while the receipt does not.
          'x-inrp2p-source-sha256': html.sha256,
          'cache-control': 'no-store',
        },
      });
    }

    const out = regenerateReceipt(receipt, format as Exclude<ReceiptFormat, never>);
    return new NextResponse(out.body, {
      headers: {
        'content-type': `${out.contentType}; charset=utf-8`,
        // HTML is meant to be read in the browser and printed from there; the machine formats download.
        ...(format === 'html' ? {} : { 'content-disposition': `attachment; filename="${out.filename}"` }),
        'x-inrp2p-sha256': out.sha256,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (isDomainError(err) && err.code === 'RECEIPT_HASH_MISMATCH') {
      return NextResponse.json({ error: err.code, message: 'This receipt could not be reproduced from its record. It has not been served.' }, { status: 500, headers: { 'cache-control': 'no-store' } });
    }
    return authErrorResponse(err);
  }
}
