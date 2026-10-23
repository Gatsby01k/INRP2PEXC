import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type OpsDesk, opsDesk } from '@inrp2p/traders';
import { can, operatorPage } from '../../../../server/operator.ts';
import { dateTime, rate, titleCase, usdt } from '../../_desk/format.ts';
import { Chip, Columns, KpiBand, Page, PageBody, PageHeader, Section, Stack, Timeline } from '../../_desk/ui.tsx';
import { DeskStateChips } from '../DeskOpsList.tsx';
import { DeskControls } from './DeskControls.tsx';
import d from '../../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

const HISTORY: Record<string, string> = {
  'desk.opened': 'Opened', 'desk.status_changed': 'Status changed by the desk', 'desk.updated': 'Name or words changed by the desk',
  'desk.suspended': 'Suspended by INRP2P', 'desk.resumed': 'Suspension lifted', 'desk.page_hidden': 'Page hidden by INRP2P',
  'desk.page_shown': 'Page shown again', 'desk.renamed': 'Renamed by INRP2P',
};

const STATE: Record<string, string> = { AWAITING_FIRST_LEG: 'waiting for the first leg', FIRST_LEG_DETECTED: 'first leg seen', FIRST_LEG_CONFIRMED: 'first leg in', SETTLING: 'settling', COMPLETED: 'completed', CANCELLED: 'cancelled' };

/** One desk, for INRP2P: what it is and does, the decisions INRP2P can take on it, and every one taken with its reason. */
export default async function DeskOpsDeskPage({ params }: { params: Promise<{ deskId: string }> }) {
  const ctx = await operatorPage();
  if (!can(ctx, 'desks:view')) notFound();
  const { deskId } = await params;
  let desk: OpsDesk | null;
  try {
    desk = await opsDesk(ctx.db, deskId);
  } catch (e) {
    if (isDomainError(e) && e.code === 'INVALID_ARGUMENT') notFound();
    throw e;
  }
  if (!desk) notFound();
  const price = (dir: 'SELL_USDT' | 'BUY_USDT') => {
    const p = desk.prices[dir];
    return p ? `${rate(p.rate)} · ${usdt(p.min, { unit: false })}–${usdt(p.max)}${p.offered ? '' : ' · off'}` : 'not set';
  };

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: '/desk-ops', label: 'Desks' }]}
        title={desk.name}
        badge={<DeskStateChips desk={desk} />}
        meta={`/${desk.handle} · since ${dateTime(desk.createdAt)}`}
      />
      <PageBody>
        <KpiBand
          label="Desk figures"
          items={[
            { key: 'c', label: 'Clients', value: String(desk.clients), sub: `${desk.team} on its team` },
            { key: 'o', label: 'Open deals', value: String(desk.openDeals) },
            { key: 'v', label: 'Volume · 30 days', value: usdt(desk.volume30d), sub: `${desk.completed30d} completed` },
            { key: 'f', label: 'Fees · 30 days', value: usdt(desk.fees30d) },
            { key: 'd', label: 'Open disputes', value: String(desk.openDisputes), ...(desk.openDisputes > 0 ? { tone: 'danger' as const } : {}) },
          ]}
        />
        <Columns>
          <Stack>
            <Section title="Desk">
              <dl className={d.kv}>
                <div style={{ display: 'contents' }}><dt>Name</dt><dd>{desk.name}</dd></div>
                <div style={{ display: 'contents' }}><dt>Address</dt><dd className={d.mono}>inrp2p.com/{desk.handle}</dd></div>
                <div style={{ display: 'contents' }}><dt>About</dt><dd>{desk.about ?? <span className={d.muted}>—</span>}</dd></div>
                <div style={{ display: 'contents' }}>
                  <dt>Trader</dt>
                  <dd>
                    <Link href={`/trader-desk/${desk.trader.id}`} className={d.link}>{desk.trader.name}</Link>{' '}
                    <span className={d.muted}>· {desk.trader.status.toLowerCase().replace('_', ' ')}</span>
                  </dd>
                </div>
                <div style={{ display: 'contents' }}><dt>Client sells USDT</dt><dd className={d.num}>{price('SELL_USDT')}</dd></div>
                <div style={{ display: 'contents' }}><dt>Client buys USDT</dt><dd className={d.num}>{price('BUY_USDT')}</dd></div>
                <div style={{ display: 'contents' }}><dt>Last deal</dt><dd>{desk.lastDealAt ? dateTime(desk.lastDealAt) : <span className={d.muted}>none yet</span>}</dd></div>
              </dl>
            </Section>
            <Section title="Latest deals" count={desk.deals.length}>
              {desk.deals.length === 0 ? (
                <p className={d.fieldHint}>No deal yet.</p>
              ) : (
                <Timeline
                  events={desk.deals.map((x) => ({
                    key: x.tradeRef,
                    title: (
                      <span className={d.row} style={{ gap: 6 }}>
                        <Link href={`/orders/${encodeURIComponent(x.tradeRef)}`} className={d.link}>{x.tradeRef}</Link>
                        <span>{x.clientName} {x.direction === 'SELL_USDT' ? 'sells' : 'buys'} {usdt(x.usdt)}</span>
                        {x.disputed ? <Chip tone="danger">disputed</Chip> : null}
                      </span>
                    ),
                    meta: `${STATE[x.state] ?? titleCase(x.state)} · fee ${usdt(x.fee)}`,
                    time: dateTime(x.at),
                    tone: x.state === 'COMPLETED' ? ('success' as const) : x.state === 'CANCELLED' ? ('neutral' as const) : x.disputed ? ('danger' as const) : ('warning' as const),
                  }))}
                />
              )}
            </Section>
          </Stack>
          <Stack>
            <Section title="INRP2P’s decisions" hint="Its people are told each one, with the reason you give.">
              <DeskControls desk={desk} canModerate={can(ctx, 'desks:moderate')} />
            </Section>
            <Section title="Record" count={desk.history.length}>
              {desk.history.length === 0 ? (
                <p className={d.fieldHint}>Nothing recorded yet.</p>
              ) : (
                <Timeline events={desk.history.map((h, i) => ({ key: `${h.at}:${i}`, title: HISTORY[h.action] ?? titleCase(h.action.replace(/^desk\./, '')), meta: [h.by, h.note].filter(Boolean).join(' · ') || undefined, time: dateTime(h.at) }))} />
              )}
            </Section>
          </Stack>
        </Columns>
      </PageBody>
    </Page>
  );
}
