import { headers } from 'next/headers';
import { FAQ, FOOTER_NOTE, SITE_NAME, SITE_PAGES, TAGLINE, TELEGRAM, plainTerms, telegramUrl } from '../../content/site.ts';
import { getRuntime } from '../../server/runtime.ts';
import { publicOrigin } from '../../server/site.ts';
import { surfaceForHost } from '../../server/surface.ts';

export const dynamic = 'force-dynamic';

/**
 * `llms.txt`: the public site as an assistant reads it — what INRP2P is, its guides with what each answers, the questions
 * a first client asks, and where to reach a person. People in India ask an assistant "how do I sell USDT safely" as often
 * as they ask a search engine; this is the page it can quote from.
 *
 * Generated from `src/content/site.ts`, the same words the pages render and the copy guard reads, so it can say nothing
 * the site does not. Only the public host answers; on the desk or the client app it would describe private pages.
 */
export async function GET() {
  const surface = surfaceForHost((await headers()).get('host'), getRuntime().hosts);
  if (surface !== 'PUBLIC') return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });

  const origin = await publicOrigin();
  const home = SITE_PAGES.find((p) => p.path === '/');
  const guides = SITE_PAGES.filter((p) => p.path !== '/').map((p) => `- [${plainTerms(p.h1)}](${origin}${p.path}): ${plainTerms(p.description)}`);
  const questions = FAQ.items.map((q) => `- ${q.question} ${plainTerms(q.answer)}`);
  const telegram = [...TELEGRAM.channels, TELEGRAM.ceo].map((t) => `- ${t.label}: ${telegramUrl(t.handle)} (${t.note})`);

  const body = [
    `# ${SITE_NAME}`,
    '',
    `> ${TAGLINE}`,
    '',
    home ? plainTerms(home.description) : '',
    '',
    FOOTER_NOTE,
    '',
    '## Guides',
    '',
    ...guides,
    '',
    '## Questions',
    '',
    ...questions,
    '',
    '## Telegram',
    '',
    ...telegram,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
