import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import geistMedium from '../../../../../packages/ui/fonts/Geist-Medium-Latin.woff2';
import geistRegular from '../../../../../packages/ui/fonts/Geist-Regular-Latin.woff2';
import geistSemiBold from '../../../../../packages/ui/fonts/Geist-SemiBold-Latin.woff2';
import soraLatin from '../../../../../packages/ui/fonts/Sora-Variable-Latin.woff2';
import { SITE_NAME, TAGLINE } from '../../content/site.ts';
import { publicOrigin } from '../../server/site.ts';
import { PublicShell } from './PublicShell.tsx';

export const dynamic = 'force-dynamic';

/**
 * The public site (PRODUCT §7.4).
 *
 * It is the one surface with no session, no client data and nothing behind a permission — which is exactly why
 * it needs its own rules rather than the app's. It is indexed (the rest of this build never is), it is rendered
 * on the server — only the home page hydrates, as a few small islands — and everything it says is generated
 * from `src/content/site.ts`, which a test holds to D-07.
 */
export async function generateMetadata(): Promise<Metadata> {
  const origin = await publicOrigin();
  return {
    metadataBase: new URL(origin),
    // No template: every page in `src/content/site.ts` writes its own complete title, so a template would
    // append the product's name to a title that already ends with it.
    title: `${SITE_NAME} — buy and sell USDT in India`,
    description: TAGLINE,
    // The public site is the only part of this build that may be indexed.
    robots: { index: true, follow: true },
    // A page's own `openGraph` replaces this one; every page sets its own, with the share card (metadata.ts).
    openGraph: { siteName: SITE_NAME, type: 'website', locale: 'en_IN' },
  };
}

/**
 * The faces every public page's first screen is set in: Sora for the headline, Geist at the three weights of the
 * masthead, the words and the buttons. A stylesheet's fonts are only asked for once the stylesheet has arrived and the
 * page has been laid out; named here, they are asked for with the page itself, beside its styles, so the first screen
 * is drawn in its own type sooner on a slow connection. The same files the stylesheet names (`*-Latin`, fonts.css), so
 * nothing is fetched twice.
 */
const FIRST_SCREEN_FONTS: readonly string[] = [soraLatin, geistRegular, geistMedium, geistSemiBold];

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-inrp2p-nonce') ?? undefined;
  return (
    <>
      {/* Links, not `preload()`: React lifts these into the document's head, where the browser reads them first. */}
      {FIRST_SCREEN_FONTS.map((href) => (
        <link key={href} rel="preload" href={href} as="font" type="font/woff2" crossOrigin="anonymous" />
      ))}
      <PublicShell nonce={nonce}>{children}</PublicShell>
    </>
  );
}
