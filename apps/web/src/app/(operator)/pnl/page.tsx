import { notFound } from 'next/navigation';
import { istToday, pnlPage } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { PnlScreen } from './PnlScreen.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * P&L (UX_FLOWS §2 `/pnl`, FINANCIAL_INVARIANTS §4).
 *
 * Behind `pnl:view`, which a dealer has and a settlement operator does not. The page is not hidden from someone
 * without it — it is **not found**, because a page that says "you may not see this" has already told them the
 * desk makes money on their route.
 */
export default async function PnlPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'pnl:view')) notFound();

  const params = await searchParams;
  const today = await istToday(ctx.db);
  const from = params.from && DAY.test(params.from) ? params.from : today;
  const to = params.to && DAY.test(params.to) ? params.to : today;
  const view = await pnlPage(ctx.db, { from: from <= to ? from : to, to: from <= to ? to : from });

  return (
    <>
      <header className={styles.header}>
        <h1 className={styles.title}>P&amp;L</h1>
        <span className="ix-muted">{view.period.from === view.period.to ? `${view.period.from} IST` : `${view.period.from} → ${view.period.to} IST`}</span>
      </header>
      <div className={styles.content}>
        <PnlScreen view={view} today={today} canExport={can(ctx, 'ledger:export')} />
      </div>
    </>
  );
}
