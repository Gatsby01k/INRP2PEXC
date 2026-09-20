import { headers } from 'next/headers';
import { getRuntime } from '../../server/runtime.ts';
import { publicOrigin } from '../../server/site.ts';
import { surfaceForHost } from '../../server/surface.ts';

export const dynamic = 'force-dynamic';

/**
 * `robots.txt`, answered per surface.
 *
 * Three hosts share one build, so this file cannot be a static asset: what it must say depends entirely on
 * which host asked. The desk and the client app are private and say so; the public site invites crawling and
 * names its sitemap. Getting this backwards is how a private app ends up in a search index, so the answer is
 * computed from the host rather than from a file somebody has to remember to change.
 *
 * `Disallow: /` is a request, not a control. The desk host refuses every path without an operator session and
 * the client host without a client session; this only stops a well-behaved crawler wasting its time and ours.
 */
export async function GET() {
  const surface = surfaceForHost((await headers()).get('host'), getRuntime().hosts);
  if (surface !== 'PUBLIC') {
    return new Response('User-agent: *\nDisallow: /\n', {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const origin = await publicOrigin();
  const body = [
    'User-agent: *',
    'Allow: /',
    // A quote link is private to whoever was sent it. It is already `noindex`, and it is also asked for here,
    // because the two mechanisms fail in different ways and a private price is worth both.
    'Disallow: /q/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
