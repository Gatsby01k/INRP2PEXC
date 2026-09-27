import { clientHistory, historyCounts } from '@inrp2p/portal';
import { clientPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { HistoryScreen } from './HistoryScreen.tsx';

export const dynamic = 'force-dynamic';

/**
 * History (Validation/Client "History"): the client's own trades, newest first. Nothing is aggregated across
 * clients and nothing is recomputed — each row carries the figures its trade was written with. The robot reports
 * on what is still running whatever the filter shows, so it is given those trades separately.
 */
export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ filter?: string }> }) {
  const { filter } = await searchParams;
  const ctx = await clientPage();
  const selected = filter === 'open' || filter === 'completed' ? filter : undefined;
  const [rows, open, counts] = await Promise.all([
    clientHistory(ctx.db, ctx.access.clientId, { limit: 100, ...(selected ? { filter: selected } : {}) }),
    clientHistory(ctx.db, ctx.access.clientId, { limit: 200, filter: 'open' }),
    historyCounts(ctx.db, ctx.access.clientId),
  ]);

  return (
    <>
      <PageHead title="History" lede="Every trade you have made with the desk: its figures, how far it has got, and its receipt." />
      <HistoryScreen rows={rows} open={open} counts={counts} filter={selected ?? 'all'} />
    </>
  );
}
