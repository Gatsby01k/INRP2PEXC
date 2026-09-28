import { notFound } from 'next/navigation';
import { istToday, pnlPage } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { Page, PageBody, PageHeader, Segmented } from '../_desk/ui.tsx';
import { PnlScreen } from './PnlScreen.tsx';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const shift = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/**
 * P&L (UX_FLOWS §2 `/pnl`, FINANCIAL_INVARIANTS §4).
 *
 * Behind `pnl:view`, which a dealer has and a settlement operator does not. The page is not hidden from someone
 * without it — it is **not found**, because a page that says "you may not see this" has already told them the
 * desk makes money on their route.
 */
export default async function PnlRoute({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'pnl:view')) notFound();

  const params = await searchParams;
  const today = await istToday(ctx.db);
  const from = params.from && DAY.test(params.from) ? params.from : today;
  const to = params.to && DAY.test(params.to) ? params.to : today;
  const period = { from: from <= to ? from : to, to: from <= to ? to : from };
  const view = await pnlPage(ctx.db, period);
  const presets = [
    { label: 'Today', from: today, to: today },
    { label: 'Last 7 days', from: shift(today, 6), to: today },
    { label: 'Last 30 days', from: shift(today, 29), to: today },
  ];

  return (
    <Page>
      <PageHeader
        title="P&L"
        meta={view.period.from === view.period.to ? `${view.period.from} IST` : `${view.period.from} → ${view.period.to} IST`}
        actions={<Segmented label="Period" items={presets.map((p) => ({ href: `/pnl?from=${p.from}&to=${p.to}`, label: p.label, current: p.from === period.from && p.to === period.to }))} />}
      />
      <PageBody>
        <PnlScreen view={view} canExport={can(ctx, 'ledger:export')} />
      </PageBody>
    </Page>
  );
}
