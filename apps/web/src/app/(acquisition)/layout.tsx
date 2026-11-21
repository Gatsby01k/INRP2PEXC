import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SITE_NAME } from '../../content/site.ts';
import { publicOrigin } from '../../server/site.ts';

export const dynamic = 'force-dynamic';

/**
 * Campaign pages on the public host (migration 0053) — today one: `inrp2p.com/traders`, served from `/lp/traders`.
 *
 * They are the public site's in everything a crawler and a link preview see (indexed, the same origin, the same card
 * metadata), but not in its frame: a campaign's visitor gets a funnel, not the site's navigation, so each page draws its
 * own shell (`_traders/TradersShell.tsx`) in the site's room.
 */
export async function generateMetadata(): Promise<Metadata> {
  const origin = await publicOrigin();
  return {
    metadataBase: new URL(origin),
    robots: { index: true, follow: true },
    openGraph: { siteName: SITE_NAME, type: 'website', locale: 'en_IN' },
  };
}

export default function AcquisitionLayout({ children }: { children: ReactNode }) {
  return children;
}
