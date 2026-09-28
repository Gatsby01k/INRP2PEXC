import Link from 'next/link';
import { isDomainError } from '@inrp2p/kernel';
import { type OrderFilter, type OrderRow, deskTrade, listOrders, orderCounts, searchOrders } from '@inrp2p/desk';
import { collectionAccounts } from '@inrp2p/traders';
import { operatorPage } from '../../../server/operator.ts';
import { ContextPanel } from '../_desk/ContextPanel.tsx';
import { Icon } from '../_desk/icons.tsx';
import { dateTime } from '../_desk/format.ts';
import { LifecycleChip, LinkTabs, Page, PageHeader, Segmented, Side } from '../_desk/ui.tsx';
import { tradePerms } from '../_trade/perms.ts';
import { TradeWorkspace } from '../_trade/TradeWorkspace.tsx';
import { OrdersTable } from './OrdersTable.tsx';
import q from '../queue.module.css';
import o from './orders.module.css';

export const dynamic = 'force-dynamic';

type Tab = 'OPEN' | 'HOLD' | 'COMPLETED' | 'CANCELLED' | 'ALL';
const TABS: readonly { key: Tab; label: string }[] = [
  { key: 'OPEN', label: 'Open' },
  { key: 'HOLD', label: 'On hold' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'CANCELLED', label: 'Cancelled' },
  { key: 'ALL', label: 'All' },
];

/**
 * Orders (UX_FLOWS §2): every trade, by state and direction, with search by reference, UTR, transaction hash or
 * client. The selected trade opens beside the list in the same workspace the desk uses.
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const tab: Tab = typeof params.state === 'string' && TABS.some((t) => t.key === params.state) ? (params.state as Tab) : 'OPEN';
  const direction = params.dir === 'SELL_USDT' || params.dir === 'BUY_USDT' ? params.dir : null;
  const search = typeof params.q === 'string' ? params.q.trim() : '';
  const tradeId = typeof params.trade === 'string' ? params.trade : null;

  const state: OrderFilter['state'] = tab === 'HOLD' ? 'OPEN' : tab;
  const [listed, counts] = await Promise.all([
    search.length >= 2 ? searchOrders(ctx.db, ctx.access, search, { limit: 100 }) : listOrders(ctx.db, ctx.access, { state, ...(direction ? { direction } : {}), limit: 300 }),
    orderCounts(ctx.db),
  ]);
  const rows: readonly OrderRow[] = search.length >= 2 ? listed : tab === 'HOLD' ? listed.filter((r) => r.hold) : listed;

  let trade = null;
  if (tradeId) {
    try {
      trade = await deskTrade(ctx.db, tradeId, ctx.access);
    } catch (e) {
      if (!(isDomainError(e) && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGUMENT'))) throw e;
    }
  }
  const collection = trade && trade.direction === 'BUY_USDT' ? await collectionAccounts(ctx.db) : [];

  const href = (next: Record<string, string | null>) => {
    const p = new URLSearchParams();
    const merged = { state: tab === 'OPEN' ? null : tab, dir: direction, q: search || null, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/orders?${s}` : '/orders';
  };

  return (
    <Page fixed>
      <PageHeader
        title="Orders"
        meta={`${counts.OPEN} open · ${counts.HOLD} on hold · ${counts.ALL} in all`}
        actions={
          <>
            <Segmented
              label="Direction"
              items={[
                { href: href({ dir: null, trade: null }), label: 'Both sides', current: direction === null },
                { href: href({ dir: 'SELL_USDT', trade: null }), label: 'Client sells', current: direction === 'SELL_USDT' },
                { href: href({ dir: 'BUY_USDT', trade: null }), label: 'Client buys', current: direction === 'BUY_USDT' },
              ]}
            />
            <form action="/orders" method="get" className={o.search} role="search">
              {tab !== 'OPEN' ? <input type="hidden" name="state" value={tab} /> : null}
              {direction ? <input type="hidden" name="dir" value={direction} /> : null}
              <Icon name="search" size={14} className={o.searchIcon} />
              <input className={o.searchInput} name="q" defaultValue={search} placeholder="Ref, UTR, tx hash or client" aria-label="Search trades by reference, UTR, transaction hash or client" />
              {search ? (
                <Link href={href({ q: null, trade: null })} className={o.clear} aria-label="Clear search">
                  <Icon name="close" size={12} />
                </Link>
              ) : null}
            </form>
          </>
        }
        tabs={
          <LinkTabs
            label="Trade state"
            items={TABS.map((t) => ({
              href: href({ state: t.key === 'OPEN' ? null : t.key, q: null, trade: null }),
              label: t.label,
              count: counts[t.key],
              ...(t.key === 'HOLD' ? { tone: 'danger' as const } : {}),
              current: !search && tab === t.key,
            }))}
          />
        }
      />
      {search ? (
        <p className={o.searchNote}>
          {rows.length} match{rows.length === 1 ? '' : 'es'} for <strong>{search}</strong> across every state · references, UTRs and hashes match exactly, client names from the start.
        </p>
      ) : null}
      <div className={q.split} {...(trade ? { 'data-panel': '' } : {})}>
        <div className={q.list}>
          <OrdersTable rows={rows} economics={ctx.access.economics} selected={trade?.tradeId ?? null} />
        </div>
        {trade ? (
          <div className={q.panelCol}>
            <ContextPanel
              refLabel={trade.ref}
              title={trade.clientName}
              subtitle={`Opened ${dateTime(trade.openedAt)}`}
              badges={
                <>
                  <Side direction={trade.direction} />
                  <LifecycleChip state={trade.lifecycle} hold={trade.hold} />
                </>
              }
              closeHref={href({ trade: null })}
              recordHref={`/orders/${encodeURIComponent(trade.ref)}`}
              testId="trade-panel"
              label={`Trade ${trade.ref}`}
            >
              <TradeWorkspace trade={trade} perms={tradePerms(ctx)} collectionAccounts={collection} />
            </ContextPanel>
          </div>
        ) : null}
      </div>
    </Page>
  );
}
