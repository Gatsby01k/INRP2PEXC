import type { Metadata } from 'next';
import { HERO, SITE_NAME, TAGLINE, type SitePage, withTerms } from '../../content/site.ts';
import { publicOrigin } from '../../server/site.ts';
import card from './_landing/og/card.jpg';
import cardBuy from './_landing/og/card-buy-usdt-in-india.jpg';
import cardFreeze from './_landing/og/card-p2p-bank-account-freeze.jpg';
import cardInrToUsdt from './_landing/og/card-inr-to-usdt.jpg';
import cardMerchant from './_landing/og/card-p2p-merchant-india.jpg';
import cardSafe from './_landing/og/card-is-inrp2p-safe.jpg';
import cardScams from './_landing/og/card-usdt-p2p-scams.jpg';
import cardSell from './_landing/og/card-sell-usdt-in-india.jpg';
import cardOtc from './_landing/og/card-usdt-otc-india.jpg';
import cardUsdtToInr from './_landing/og/card-usdt-to-inr.jpg';
import cardPremium from './_landing/og/card-usdt-premium-india.jpg';

/** Each page's own card (`pnpm --filter @inrp2p/web og:card`); a page without one shows the home page's. */
const CARDS: Record<string, typeof card> = {
  '/': card,
  '/usdt-to-inr': cardUsdtToInr,
  '/usdt-premium-india': cardPremium,
  '/inr-to-usdt': cardInrToUsdt,
  '/sell-usdt-in-india': cardSell,
  '/buy-usdt-in-india': cardBuy,
  '/usdt-otc-india': cardOtc,
  '/p2p-bank-account-freeze': cardFreeze,
  '/usdt-p2p-scams': cardScams,
  '/is-inrp2p-safe': cardSafe,
  '/p2p-merchant-india': cardMerchant,
};

/**
 * One public page's metadata: its title and description, its one canonical URL, and the card a link to it shows.
 *
 * Written once for every public page. A page's `openGraph` replaces the layout's rather than merging with it, so the
 * site name and locale are said here, beside the page's own title, or a shared link would lose them.
 *
 * The card (`_landing/og/`, drawn by `pnpm --filter @inrp2p/web og:card`) is the page reduced to a picture — the
 * mark, the page's headline and lede, the robot saying the page's word on its visor — so a preview never says more
 * than the page does.
 */
export async function pageMetadata(page: SitePage): Promise<Metadata> {
  const origin = await publicOrigin();
  const url = `${origin}${page.path === '/' ? '' : page.path}`;
  // The card's alt text is its own words, in the order it shows them.
  const { lead, accent, tail } = HERO.headline;
  const own = CARDS[page.path] ?? card;
  const words = page.path === '/' ? `${lead} ${accent} ${tail}` : withTerms(page.h1);
  const image = { url: own.src, width: own.width, height: own.height, alt: `${SITE_NAME}. ${words} ${page.path === '/' ? TAGLINE : withTerms(page.lede)}` };
  // A page's words may name the trader programme's terms (`{margin}`, `{fee}`); a search result shows them filled in.
  const title = withTerms(page.title);
  const description = withTerms(page.description);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en_IN',
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}
