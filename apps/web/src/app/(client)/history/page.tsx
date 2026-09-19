import { clientHistory } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { HistoryTable } from './HistoryTable.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

/**
 * History (Validation/Client "History"): the client's own trades, newest first. Nothing is aggregated across
 * clients and nothing is recomputed — each row carries the figures its trade was written with.
 */
export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams;
  const ctx = await clientPage();
  const selected = filter === 'open' || filter === 'completed' ? filter : undefined;
  const rows = await clientHistory(ctx.db, ctx.access.clientId, { limit: 100, ...(selected ? { filter: selected } : {}) });

  return (
    <main className={`${styles.content} ${styles.wide}`}>
      <h1 className={styles.pageTitle}>History</h1>
      <HistoryTable rows={rows} filter={selected ?? 'all'} />
    </main>
  );
}
