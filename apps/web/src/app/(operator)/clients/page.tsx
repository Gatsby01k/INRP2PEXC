import Link from 'next/link';
import { clientBook } from '@inrp2p/desk';
import { can, operatorPage } from '../../../server/operator.ts';
import { Icon } from '../_desk/icons.tsx';
import { Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import { ClientBook } from './ClientBook.tsx';
import o from '../orders/orders.module.css';

export const dynamic = 'force-dynamic';

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q.trim() : '';
  const rows = await clientBook(ctx.db, { ...(search ? { search } : {}), access: ctx.access, limit: 300 });
  const open = rows.reduce((n, c) => n + c.openTrades, 0);

  return (
    <Page>
      <PageHeader
        title="Clients"
        meta={`${rows.length} client${rows.length === 1 ? '' : 's'}${search ? ` matching “${search}”` : ''} · ${open} open trade${open === 1 ? '' : 's'}`}
        actions={
          <form action="/clients" method="get" className={o.search} role="search">
            <Icon name="search" size={14} className={o.searchIcon} />
            <input className={o.searchInput} name="q" defaultValue={search} placeholder="Client name" aria-label="Search clients by name" />
            {search ? (
              <Link href="/clients" className={o.clear} aria-label="Clear search">
                <Icon name="close" size={12} />
              </Link>
            ) : null}
          </form>
        }
      />
      <PageBody>
        <Section flush>
          <ClientBook rows={rows} economics={ctx.access.economics} canRequest={can(ctx, 'request:create')} />
        </Section>
      </PageBody>
    </Page>
  );
}
