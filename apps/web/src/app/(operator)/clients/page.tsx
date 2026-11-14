import Link from 'next/link';
import { clientBook } from '@inrp2p/desk';
import { pendingUpiIds } from '@inrp2p/clients';
import { can, operatorPage } from '../../../server/operator.ts';
import { Icon } from '../_desk/icons.tsx';
import { KeyValues, Page, PageBody, PageHeader, Section } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import { ClientBook } from './ClientBook.tsx';
import o from '../orders/orders.module.css';

export const dynamic = 'force-dynamic';

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const params = await searchParams;
  const search = typeof params.q === 'string' ? params.q.trim() : '';
  const [rows, upiToCheck] = await Promise.all([clientBook(ctx.db, { ...(search ? { search } : {}), access: ctx.access, limit: 300 }), pendingUpiIds(ctx.db)]);
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
        {/* ADR 0030: a UPI ID is live when added; one a payer's app showed another name for is paused here for a person. */}
        {upiToCheck.length > 0 ? (
          <Section title="UPI IDs paused by a payer" count={upiToCheck.length} hint="A payer’s UPI app showed another name. Oldest first: open the client, look the address up in a UPI app, and put it back or reject it.">
            <KeyValues
              items={upiToCheck.map((u) => ({
                key: u.id,
                label: <Link href={`/clients/${u.clientId}#upi`}>{u.clientName}</Link>,
                value: (
                  <span className={d.row}>
                    <span className={d.mono}>{u.vpa}</span>
                    <span className={d.secondary}>
                      {u.reportedName ? `app showed ${u.reportedName}, expected ${u.holderName}` : `expected ${u.holderName}`}
                      {u.tradeRef ? ` · ${u.tradeRef}` : ''} ·{' '}
                      {new Date(u.reportedAt ?? u.submittedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </span>
                ),
              }))}
            />
          </Section>
        ) : null}
        <Section flush>
          <ClientBook rows={rows} economics={ctx.access.economics} canRequest={can(ctx, 'request:create')} />
        </Section>
      </PageBody>
    </Page>
  );
}
