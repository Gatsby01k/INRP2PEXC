import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { SITE_NAME, plainTerms, telegramUrl } from '../../../../content/site.ts';
import { TRADERS_PAGE, TRADERS_TELEGRAM } from '../../../../content/traders.ts';
import { TOUCH_HEADER, decodeAttribution, traderEntryHref } from '../../../../server/acquisition.ts';
import { getRuntime } from '../../../../server/runtime.ts';
import { appOrigin, publicOrigin, requestNonce } from '../../../../server/site.ts';
import { TRADERS_PATH, TRADER_ENTRY_PATH, surfaceForHost } from '../../../../server/surface.ts';
import card from '../../../(public)/_landing/og/card-traders.jpg';
import { Hero } from '../../_traders/Hero.tsx';
import { Closing, Compare, Faq, Money, Product, Proof, Start } from '../../_traders/Sections.tsx';
import { TradersShell } from '../../_traders/TradersShell.tsx';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const origin = await publicOrigin();
  const url = `${origin}${TRADERS_PATH}`;
  const { meta } = TRADERS_PAGE;
  const title = plainTerms(meta.title);
  const description = plainTerms(meta.description);
  const image = { url: card.src, width: card.width, height: card.height, alt: `${SITE_NAME}. ${meta.ogTitle}` };
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title: meta.ogTitle, description, url, type: 'website', siteName: SITE_NAME, locale: 'en_IN', images: [image] },
    twitter: { card: 'summary_large_image', title: meta.ogTitle, description, images: [image] },
  };
}

/** The page's questions, marked up as an FAQ for search — the same words the page shows. */
function structuredData(origin: string): string {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    url: `${origin}${TRADERS_PATH}`,
    mainEntity: TRADERS_PAGE.faq.items.map((q) => ({ '@type': 'Question', name: q.question, acceptedAnswer: { '@type': 'Answer', text: plainTerms(q.answer) } })),
  };
  return JSON.stringify(data).replaceAll('<', '\\u003c');
}

/**
 * `inrp2p.com/traders` — the trader acquisition page (served from here by the proxy's rewrite; see `TRADERS_PAGE_PATH`).
 *
 * Every call to action leads to the trader sign-in on the app's host with the visitor's attribution in its address — the
 * random id and campaign touches the proxy put in the page's own cookie (migration 0053) — and the side they chose, so the
 * application starts on it. The rest of the page is server markup in the site's room; three islands make the rate board,
 * the side switch and the count.
 */
export default async function TradersPage() {
  const h = await headers();
  if (surfaceForHost(h.get('host'), getRuntime().hosts) !== 'PUBLIC') notFound();
  const encoded = h.get(TOUCH_HEADER);
  const attribution = decodeAttribution(encoded);
  const segment = attribution?.segment ?? 'usdt';
  const app = appOrigin();
  const origin = await publicOrigin();
  const host = origin.replace(/^https?:\/\//, '');
  // The side goes into the application only when the visitor chose one, or the campaign's link named it.
  const entryHref = traderEntryHref(app, TRADER_ENTRY_PATH, attribution ? encoded : null, attribution?.segment ?? null);
  // A trader who already has an exchange: their Traders screen, where this address used to send everyone.
  const signInHref = `${app}${TRADERS_PATH}`;
  const ceoHref = telegramUrl(TRADERS_TELEGRAM.ceo.handle);
  const channelHref = telegramUrl(TRADERS_TELEGRAM.traders.handle);
  const nonce = await requestNonce();
  return (
    <TradersShell segment={segment} chosen={Boolean(attribution?.segment)} entryHref={entryHref} signInHref={signInHref}>
      <script type="application/ld+json" {...(nonce ? { nonce } : {})} dangerouslySetInnerHTML={{ __html: structuredData(origin) }} />
      <Hero segment={segment} entryHref={entryHref} ceoHref={ceoHref} />
      <Proof ceoHref={ceoHref} ceoHandle={TRADERS_TELEGRAM.ceo.handle} />
      <Money />
      <Compare />
      <Start entryHref={entryHref} />
      <Product host={host} entryHref={entryHref} signInHref={signInHref} />
      <Faq ceoHref={ceoHref} />
      <Closing entryHref={entryHref} signInHref={signInHref} channelHref={channelHref} />
    </TradersShell>
  );
}
