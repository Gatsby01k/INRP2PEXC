import { NextResponse } from 'next/server';
import { isDomainError } from '@inrp2p/kernel';
import { type ExportKind, generateExport } from '@inrp2p/reporting';
import { can, operatorContext } from '../../../../server/operator.ts';
import { authErrorResponse } from '../../../../server/http.ts';

export const dynamic = 'force-dynamic';

const KINDS = new Set<ExportKind>(['trades', 'ledger', 'receipts']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Finance exports (`ledger:export`).
 *
 * A download rather than a page, because the answer is a file. The period is required and explicit: "everything"
 * is not a period, and a finance file nobody can bound is a file nobody can reconcile. Every generation is
 * audited with its row count and the hash of the bytes (SECURITY §8 `export.generated`), so two people holding
 * files that disagree can find out which one this system produced.
 */
export async function GET(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  let ctx;
  try {
    ctx = await operatorContext();
  } catch (err) {
    return authErrorResponse(err);
  }
  if (!can(ctx, 'ledger:export')) return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403, headers: { 'cache-control': 'no-store' } });

  const { kind } = await params;
  if (!KINDS.has(kind as ExportKind)) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404, headers: { 'cache-control': 'no-store' } });

  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? '';
  const to = url.searchParams.get('to') ?? '';
  if (!DAY.test(from) || !DAY.test(to)) {
    return NextResponse.json({ error: 'INVALID_ARGUMENT', message: 'from and to are required IST days (YYYY-MM-DD)' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }

  try {
    const out = await generateExport(ctx.db, { type: 'USER', id: ctx.actor.userId, surface: 'OPERATOR', sessionId: ctx.actor.sessionId }, { kind: kind as ExportKind, period: { from, to } });
    return new NextResponse(out.body, {
      headers: {
        'content-type': `${out.contentType}; charset=utf-8`,
        'content-disposition': `attachment; filename="${out.filename}"`,
        // The hash the audit trail recorded, so a recipient can check the file they hold is the file we made.
        'x-inrp2p-sha256': out.sha256,
        'cache-control': 'no-store',
      },
    });
  } catch (err) {
    if (isDomainError(err) && err.code === 'INVALID_ARGUMENT') {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 400, headers: { 'cache-control': 'no-store' } });
    }
    return authErrorResponse(err);
  }
}
