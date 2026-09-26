import type { Metadata } from 'next';
import { HERO, SITE_NAME, TAGLINE, type SitePage } from '../../content/site.ts';
import { publicOrigin } from '../../server/site.ts';
import card from './_landing/og/card.jpg';

/**
 * One public page's metadata: its title and description, its one canonical URL, and the card a link to it shows.
 *
 * Written once for all six pages. A page's `openGraph` replaces the layout's rather than merging with it, so the
 * site name and locale are said here, beside the page's own title, or a shared link would lose them.
 *
 * The card (`_landing/og/card.jpg`, drawn by `pnpm --filter @inrp2p/web og:card`) is the hero reduced to a
 * picture — the mark, the headline, the tagline and the robot — so a preview never says more than the page does.
 */
export async function pageMetadata(page: SitePage): Promise<Metadata> {
  const origin = await publicOrigin();
  const url = `${origin}${page.path === '/' ? '' : page.path}`;
  // The card's alt text is its own words, in the order it shows them.
  const { lead, accent, tail } = HERO.headline;
  const image = { url: card.src, width: card.width, height: card.height, alt: `${SITE_NAME}. ${lead} ${accent} ${tail} ${TAGLINE}` };
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: url },
    openGraph: {
      title: page.title,
      description: page.description,
      url,
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en_IN',
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: page.title, description: page.description, images: [image] },
  };
}
