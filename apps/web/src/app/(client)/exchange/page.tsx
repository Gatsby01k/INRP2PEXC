import { exchangeView } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { ExchangeScreen } from './ExchangeScreen.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

/**
 * Exchange (UX_FLOWS F1) — the one screen a client spends time on.
 *
 * A client has at most one live conversation with the desk: a request being priced, or a quote counting down.
 * The server decides which of those it is; the screen only draws it. Everything shown comes from the domain's
 * own client projections, so there is no figure here the desk did not already commit to.
 */
export default async function ExchangePage() {
  const ctx = await clientPage();
  const view = await exchangeView(ctx.db, ctx.access.clientId);
  const serverTime = new Date().toISOString();

  return (
    <main className={styles.content}>
      <h1 className={styles.pageTitle}>Exchange</h1>
      <ExchangeScreen view={view} canAccept={ctx.access.canAcceptQuotes} serverTime={serverTime} />
    </main>
  );
}
