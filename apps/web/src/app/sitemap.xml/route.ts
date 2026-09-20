import { headers } from 'next/headers';
import { SITE_PAGES } from '../../content/site.ts';
import { getRuntime } from '../../server/runtime.ts';
import { publicOrigin } from '../../server/site.ts';
import { surfaceForHost } from '../../server/surface.ts';

export const dynamic = 'force-dynamic';

const escapeXml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/**
 * The sitemap, generated from the same list that renders the pages.
 *
 * Nothing here is maintained by hand, so a route cannot be published without being listed or listed without
 * existing. There is no `lastmod`: a date we cannot derive from anything would be a number we invented, which
 * is the one thing this site does not do — and a `lastmod` that is always "today" teaches a crawler to ignore
 * the field.
 *
 * Only the public host answers. On the desk or the client app a sitemap would be an index of private pages.
 */
export async function GET() {
  const surface = surfaceForHost((await headers()).get('host'), getRuntime().hosts);
  if (surface !== 'PUBLIC') return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const origin = await publicOrigin();
  const urls = SITE_PAGES.map((page) => {
    const loc = escapeXml(`${origin}${page.path === '/' ? '/' : page.path}`);
    return `  <url>\n    <loc>${loc}</loc>\n    <priority>${page.priority.toFixed(1)}</priority>\n  </url>`;
  }).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
