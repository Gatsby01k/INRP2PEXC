import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type PortalTrade, portalTrade } from '@inrp2p/portal';
import { clientPage } from '../../../../server/client.ts';
import { TradeScreen } from './TradeScreen.tsx';
import styles from '../../shell.module.css';

export const dynamic = 'force-dynamic';

/**
 * One trade, as its client sees it (UX_FLOWS F1 step 6).
 *
 * The trade is found by the reference the client already has, and only within their own client — another
 * client's reference is "not found", never "forbidden", so this page tells nobody what else exists.
 */
export default async function TradePage({ params }: { params: Promise<{ tradeRef: string }> }) {
  const { tradeRef } = await params;
  const ctx = await clientPage();
  let view: PortalTrade;
  try {
    view = await portalTrade(ctx.db, ctx.access.clientId, decodeURIComponent(tradeRef));
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }

  return (
    <main className={`${styles.content} ${styles.wide}`}>
      <TradeScreen view={view} />
    </main>
  );
}
