import { cookies, headers } from 'next/headers';
import { after } from 'next/server';
import type { AcquisitionEventKind } from '@inrp2p/db';
import { TOUCH_COOKIE, decodeAttribution, segmentOf } from '../../../server/acquisition.ts';
import { recordAcquisitionEvent, visitContext } from '../../../server/acquisition-record.ts';
import { getRuntime } from '../../../server/runtime.ts';
import { surfaceForHost } from '../../../server/surface.ts';

export const dynamic = 'force-dynamic';

/** What the acquisition page's browser may report. `ENTRY` is the server's own word, written on the app's host. */
const KINDS: ReadonlySet<AcquisitionEventKind> = new Set(['VIEW', 'SEGMENT', 'ESTIMATE', 'CTA', 'CONTACT', 'SIGN_IN', 'FAQ']);

const done = (status = 204) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });

/**
 * What a visitor did on `inrp2p.com/traders` (migration 0053): saw the page, chose a side, tried the example, pressed a
 * call to action, opened a question. The browser says only which: the visitor and the campaign they came with are read
 * from the page's own cookie, never from the request's body, so a request from anywhere else — which carries no such
 * cookie — records nothing. The example's figures are never sent. The answer is always the same empty one, and the
 * write happens after it, so the page never waits on the database and never learns whether anything was kept.
 */
export async function POST(request: Request) {
  const h = await headers();
  const rt = getRuntime();
  if (surfaceForHost(h.get('host'), rt.hosts) !== 'PUBLIC') return done(404);
  const site = h.get('sec-fetch-site');
  if (site && site !== 'same-origin') return done(403);
  const attribution = decodeAttribution((await cookies()).get(TOUCH_COOKIE)?.value);
  if (!attribution) return done();
  const text = await request.text().catch(() => '');
  if (text.length === 0 || text.length > 256) return done(text.length > 256 ? 413 : 400);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return done(400);
    body = parsed as Record<string, unknown>;
  } catch {
    return done(400);
  }
  const kind = typeof body.kind === 'string' && KINDS.has(body.kind as AcquisitionEventKind) ? (body.kind as AcquisitionEventKind) : null;
  if (!kind) return done(400);
  const placement = typeof body.placement === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(body.placement) ? body.placement : null;
  const ctx = visitContext(h);
  after(() => recordAcquisitionEvent(rt.appDb, attribution, { kind, page: 'TRADERS', segment: segmentOf(body.segment), placement }, ctx));
  return done();
}
