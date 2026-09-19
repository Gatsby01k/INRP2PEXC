import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type QuoteLinkView, viewQuoteLink } from '@inrp2p/quotes';
import { getRuntime } from '../../../server/runtime.ts';
import { quoteDepsForWeb } from '../../../server/quotes.ts';
import { callerIpHash } from '../../../server/link.ts';
import { QuoteLinkScreen } from './QuoteLinkScreen.tsx';
import styles from './link.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your quote',
  // A private quote must never be indexed, previewed or summarised by anything that follows the link.
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The shareable quote link (D-01, W3b).
 *
 * This page is public because it has to be: the person holding the link may have no account at all. So it is
 * built on the premise that opening it authorizes nothing. It reads the quote through the client projection,
 * which cannot carry a route, a margin or a provider, and the only thing it writes is that the link was opened.
 *
 * Accepting is a separate act that needs a code sent to a verified address of someone the client already
 * authorized to decide. Holding the link is not authority, and this page never treats it as such.
 */
export default async function QuoteLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  let view: QuoteLinkView;
  try {
    view = await viewQuoteLink(getRuntime().appDb, quoteDepsForWeb(), { token, ipHash: await callerIpHash() });
  } catch (e) {
    // An unknown, revoked or malformed token is indistinguishable from one that never existed, so a link cannot
    // be used to find out which quotes are live.
    if (isDomainError(e) && (e.code === 'LINK_NOT_FOUND' || e.code === 'INVALID_ARGUMENT')) notFound();
    throw e;
  }

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <p className={styles.brand}>INRP2P Exchange · Private quote {view.quote.ref}</p>
        <QuoteLinkScreen view={view} token={token} />
      </div>
    </main>
  );
}
