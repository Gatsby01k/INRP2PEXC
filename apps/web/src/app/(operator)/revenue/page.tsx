import { notFound } from 'next/navigation';
import { earningsByAddress, istToday, revenueReport } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { Page, PageBody, PageHeader, Segmented } from '../_desk/ui.tsx';
import { RevenueScreen } from './RevenueScreen.tsx';

export const dynamic = 'force-dynamic';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const shift = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/**
 * Revenue (ADR 0020 §2.16): INRP2P's earnings in USDT — platform fees on desks' own deals and its own margins — where
 * they are (at deal addresses or swept to the revenue wallet), what sweeping costs in TRX, and which desks they come
 * from. Behind `pnl:view`, like P&L, and not found without it.
 */
export default async function RevenueRoute({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'pnl:view')) notFound();
  const params = await searchParams;
  const today = await istToday(ctx.db);
  const from = params.from && DAY.test(params.from) ? params.from : shift(today, 29);
  const to = params.to && DAY.test(params.to) ? params.to : today;
  const period = { from: from <= to ? from : to, to: from <= to ? to : from };
  const [report, addresses] = await Promise.all([revenueReport(ctx.db, period), earningsByAddress(ctx.db)]);
  const presets = [
    { label: 'Today', from: today, to: today },
    { label: 'Last 7 days', from: shift(today, 6), to: today },
    { label: 'Last 30 days', from: shift(today, 29), to: today },
  ];
  return (
    <Page>
      <PageHeader
        title="Revenue"
        meta={period.from === period.to ? `${period.from} IST · USDT` : `${period.from} → ${period.to} IST · USDT`}
        actions={<Segmented label="Period" items={presets.map((p) => ({ href: `/revenue?from=${p.from}&to=${p.to}`, label: p.label, current: p.from === period.from && p.to === period.to }))} />}
      />
      <PageBody>
        <RevenueScreen
          report={report}
          addresses={addresses}
          perms={{ sweep: can(ctx, 'network:manage'), policy: can(ctx, 'settings:network_fees'), wallet: can(ctx, 'treasury:manage_wallets') }}
        />
      </PageBody>
    </Page>
  );
}
