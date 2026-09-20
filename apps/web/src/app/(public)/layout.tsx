import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { SITE_NAME, TAGLINE } from '../../content/site.ts';
import { publicOrigin } from '../../server/site.ts';
import { PublicShell } from './PublicShell.tsx';

export const dynamic = 'force-dynamic';

/**
 * The public site (PRODUCT §7.4).
 *
 * It is the one surface with no session, no client data and nothing behind a permission — which is exactly why
 * it needs its own rules rather than the app's. It is indexed (the rest of this build never is), it is rendered
 * on the server with no client JavaScript of its own, and everything it says is generated from
 * `src/content/site.ts`, which a test holds to D-07.
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
    openGraph: { siteName: SITE_NAME, type: 'website', locale: 'en_IN' },
    // No images are declared: an OG card we have not drawn would be a broken preview, and a stock one would be
    // a picture of nothing. Text previews are correct until there is a real card to serve.
  };
}

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const nonce = (await headers()).get('x-inrp2p-nonce') ?? undefined;
  return <PublicShell nonce={nonce}>{children}</PublicShell>;
}
