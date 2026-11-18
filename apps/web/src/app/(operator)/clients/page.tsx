import Link from 'next/link';
import { Money } from '@inrp2p/kernel';
import { type ClientBookRow, type ClientBookSort, clientBook } from '@inrp2p/desk';
import { pendingUpiIds } from '@inrp2p/clients';
import { UpiMark } from '../../../components/PayMarks.tsx';
import { can, operatorPage } from '../../../server/operator.ts';
import { Icon } from '../_desk/icons.tsx';
import { signedUsdt, usdt } from '../_desk/format.ts';
import { KpiBand, LinkTabs, Page, PageBody, PageHeader, Segmented } from '../_desk/ui.tsx';
import { bookStyles as b } from '../_book/parts.tsx';
import { ClientBook } from './ClientBook.tsx';
import o from '../orders/orders.module.css';

export const dynamic = 'force-dynamic';

type View = 'all' | 'trading' | 'idle' | 'suspended';
const VIEWS: Record<View, { label: string; keep: (c: ClientBookRow) => boolean }> = {
  all: { label: 'All', keep: () => true },
  trading: { label: 'Trading now', keep: (c) => c.openTrades > 0 },
  idle: { label: 'Never traded', keep: (c) => c.lastActivityAt === null },
  suspended: { label: 'Suspended', keep: (c) => c.status !== 'ACTIVE' },
};

const SORTS: Record<string, { sort: ClientBookSort; label: string }> = {
  newest: { sort: 'NEWEST', label: 'Newest' },
  active: { sort: 'ACTIVE', label: 'Last trade' },
  name: { sort: 'NAME', label: 'A–Z' },
};

const sum = (values: readonly (string | null | undefined)[]): Money<'USDT'> => values.reduce((t, v) => (v ? t.add(Money.parse(v, 'USDT')) : t), Money.zero('USDT'));

/**
 * The dealer's book: how many clients the desk has and how much of its attention they hold now, what waits for a person
 * (a UPI ID a payer's app paused), then one row per client — who, what they usually do, what is in flight, what they have
 * traded and made — one click to their page.
 */
export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q.trim() : '';
  const view: View = typeof params.view === 'string' && params.view in VIEWS ? (params.view as View) : 'all';
  // Newest first by default: a client who just signed up is the one the desk has not looked at yet.
  const order = typeof params.sort === 'string' && params.sort in SORTS ? params.sort : 'newest';
  const [all, upiToCheck] = await Promise.all([clientBook(ctx.db, { ...(search ? { search } : {}), access: ctx.access, limit: 300, sort: SORTS[order]!.sort }), pendingUpiIds(ctx.db)]);
  const rows = all.filter(VIEWS[view].keep);
  const open = all.reduce((n, c) => n + c.openTrades, 0);
  const trading = all.filter((c) => c.openTrades > 0).length;
  const active = all.filter((c) => c.status === 'ACTIVE').length;
  const volume = sum(all.map((c) => c.completedVolume));
  const margin = ctx.access.economics ? sum(all.map((c) => c.marginGeneratedUsdt)) : null;
  const href = (v: View, o: string = order) => {
    const q = new URLSearchParams();
    if (search) q.set('q', search);
    if (v !== 'all') q.set('view', v);
    if (o !== 'newest') q.set('sort', o);
    const s = q.toString();
    return s ? `/clients?${s}` : '/clients';
  };

  return (
    <Page>
      <PageHeader
        title="Clients"
        meta={`${all.length} client${all.length === 1 ? '' : 's'}${search ? ` matching “${search}”` : ''} · ${open} open trade${open === 1 ? '' : 's'}`}
        actions={
          <form action="/clients" method="get" className={o.search} role="search">
            <Icon name="search" size={14} className={o.searchIcon} />
            <input className={o.searchInput} name="q" defaultValue={search} placeholder="Client name" aria-label="Search clients by name" />
            {view !== 'all' ? <input type="hidden" name="view" value={view} /> : null}
            {order !== 'newest' ? <input type="hidden" name="sort" value={order} /> : null}
            {search ? (
              <Link href={view === 'all' ? '/clients' : `/clients?view=${view}`} className={o.clear} aria-label="Clear search">
                <Icon name="close" size={12} />
              </Link>
            ) : null}
          </form>
        }
        tabs={
          <div className={b.tabsRow}>
            <LinkTabs
              label="Which clients"
              items={(Object.keys(VIEWS) as View[])
                .filter((v) => v !== 'suspended' || all.some(VIEWS.suspended.keep))
                .map((v) => ({ href: href(v), label: VIEWS[v].label, count: all.filter(VIEWS[v].keep).length, current: v === view }))}
            />
            <Segmented label="Order clients by" items={Object.entries(SORTS).map(([key, x]) => ({ href: href(view, key), label: x.label, current: key === order }))} />
          </div>
        }
      />
      <PageBody>
        <KpiBand
          label="The book"
          items={[
            { key: 'c', label: 'Clients', value: String(all.length), sub: active === all.length ? 'all active' : `${active} active · ${all.length - active} suspended` },
            { key: 't', label: 'Trading now', value: String(trading), sub: `${open} open trade${open === 1 ? '' : 's'}`, ...(trading === 0 ? { tone: 'muted' as const } : {}) },
            { key: 'v', label: 'Completed volume', value: usdt(volume.toDecimalString()), sub: 'every client, lifetime' },
            ...(margin ? [{ key: 'm', label: 'Margin made', value: signedUsdt(margin.toDecimalString()), sub: 'completed deals, USDT', ...(margin.isPositive() ? { tone: 'success' as const } : margin.isZero() ? { tone: 'muted' as const } : { tone: 'danger' as const }) }] : []),
          ]}
        />

        {/* ADR 0030: a UPI ID is live when added; one a payer's app showed another name for is paused here for a person. */}
        {upiToCheck.length > 0 ? (
          <section className={b.attention} aria-label="UPI IDs paused by a payer">
            <div className={b.attentionHead}>
              <span className={b.upiTile}>
                <UpiMark />
              </span>
              <strong>
                {upiToCheck.length} UPI ID{upiToCheck.length === 1 ? '' : 's'} paused by a payer
              </strong>
              <span>A payer’s app showed another name. Open the client, look the address up in a UPI app, put it back or reject it.</span>
            </div>
            <ul className={b.rows} style={{ padding: 'var(--space-2) var(--space-5)' }}>
              {upiToCheck.map((u) => (
                <li key={u.id} className={b.row}>
                  <span className={b.glyph} data-tone="brand">
                    <Icon name="flag" size={14} />
                  </span>
                  <span className={b.rowMain}>
                    <span className={b.rowTitle}>
                      <span className={b.addr} style={{ color: 'var(--text-primary)' }}>
                        {u.vpa}
                      </span>
                      <span className={b.whoSub}>{u.clientName}</span>
                    </span>
                    <span className={b.rowSub}>
                      {u.reportedName ? `app showed ${u.reportedName}, expected ${u.holderName}` : `expected ${u.holderName}`}
                      {u.tradeRef ? ` · ${u.tradeRef}` : ''} ·{' '}
                      {new Date(u.reportedAt ?? u.submittedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </span>
                  <span className={b.rowEnd}>
                    <Link href={`/clients/${u.clientId}#upi`} className={b.rowAction}>
                      Review <Icon name="arrowRight" size={12} />
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className={`${b.sheet} ${b.bookTable}`} aria-label="Client book">
          <ClientBook rows={rows} economics={ctx.access.economics} canRequest={can(ctx, 'request:create')} filtered={view !== 'all' || search !== ''} />
        </section>
      </PageBody>
    </Page>
  );
}
