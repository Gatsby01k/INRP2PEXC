import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type ClientDetail, clientDetail } from '@inrp2p/desk';
import { can, operatorPage } from '../../../../server/operator.ts';
import { inr, titleCase, usdt, usdtCompact } from '../../_desk/format.ts';
import { Chip, Columns, KeyValues, KpiBand, Notice, Page, PageBody, PageHeader, Section, Stack } from '../../_desk/ui.tsx';
import { NewRequest } from './NewRequest.tsx';
import { RecentTrades } from './RecentTrades.tsx';
import d from '../../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

/**
 * One client, as the desk needs them before quoting (brief "Clients"): what they trade and have made the desk, a
 * request builder, their recent trades with "Repeat", and — beside it — where money may go, who may accept a quote,
 * and the desk's own notes on how they are priced.
 */
export default async function ClientPage({ params, searchParams }: { params: Promise<{ clientId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await operatorPage();
  const { clientId } = await params;
  const query = await searchParams;
  let client: ClientDetail;
  try {
    client = await clientDetail(ctx.db, clientId, ctx.access, { contacts: can(ctx, 'client:manage') });
  } catch (e) {
    if (isDomainError(e) && (e.code === 'NOT_FOUND' || e.code === 'INVALID_ARGUMENT')) notFound();
    throw e;
  }
  const canRequest = can(ctx, 'request:create');
  // "Repeat trade" prefills the builder from a previous trade of this client — nothing is created until the dealer
  // presses the button, so a repeat is still a fresh request with its own terms.
  const repeatOf = typeof query.repeat === 'string' ? client.recentTrades.find((t) => t.tradeId === query.repeat) : undefined;

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: '/clients', label: 'Clients' }]}
        title={client.name}
        badge={
          <span className={d.row}>
            <Chip tone={client.status === 'ACTIVE' ? 'success' : 'danger'}>{client.status.toLowerCase()}</Chip>
            <Chip tone={client.kycStatus === 'VERIFIED' ? 'success' : 'muted'}>KYC {titleCase(client.kycStatus).toLowerCase()}</Chip>
          </span>
        }
        meta={`${client.ref} · ${client.legalName} · ${client.type.toLowerCase()}`}
      />
      <PageBody>
        <KpiBand
          label="Client figures"
          items={[
            { key: 'v', label: 'Completed volume', value: usdt(client.stats.completedVolume), sub: `${client.stats.completedTrades} completed trade${client.stats.completedTrades === 1 ? '' : 's'}` },
            { key: 'o', label: 'Open trades', value: String(client.stats.openTrades), sub: client.stats.openTrades > 0 ? 'in flight now' : 'nothing in flight' },
            ...(client.stats.marginGenerated !== undefined ? [{ key: 'm', label: 'Margin made', value: inr(client.stats.marginGenerated, { sign: true }), sub: 'realized, completed trades', tone: 'success' as const }] : []),
            {
              key: 't',
              label: 'Typical',
              value: client.typicalDirection ? (client.typicalDirection === 'SELL_USDT' ? 'Sells USDT' : 'Buys USDT') : '—',
              sub: client.typicalSize ? `around ${usdtCompact(client.typicalSize)}` : 'no size recorded',
            },
          ]}
        />
        <Columns>
          <Stack>
            {canRequest ? (
              <Section id="new-request" title={repeatOf ? `Repeat ${repeatOf.ref}` : 'New request'} hint="Opens the request, then takes you to the desk’s quote builder for it.">
                <NewRequest client={client} {...(repeatOf ? { prefill: { direction: repeatOf.direction, amount: repeatOf.base } } : {})} />
              </Section>
            ) : null}
            <Section
              title="Recent trades"
              count={client.recentTrades.length}
              actions={
                <Link href={`/orders?q=${encodeURIComponent(client.name)}&state=ALL`} className={d.linkButton}>
                  Every trade
                </Link>
              }
              flush
            >
              <RecentTrades trades={client.recentTrades} canRepeat={canRequest} />
            </Section>
          </Stack>
          <Stack>
            <Section title="Profile">
              <KeyValues
                items={[
                  { label: 'Legal name', value: client.legalName },
                  { label: 'Reference', value: client.ref },
                  { label: 'Pricing notes', value: client.pricingNotes ?? <span className={d.muted}>none</span> },
                ]}
              />
            </Section>
            {client.contacts ? (
              <Section title="Contacts" count={client.contacts.length} hint="CRM only — never an authentication channel.">
                {client.contacts.length === 0 ? (
                  <p className={d.fieldHint}>No contacts recorded.</p>
                ) : (
                  <div className={d.stackTight}>
                    {client.contacts.map((c) => (
                      <KeyValues
                        key={c.id}
                        items={[
                          { label: c.primary ? 'Primary' : 'Contact', value: <strong>{c.name}</strong> },
                          ...(c.email ? [{ label: 'Email', value: c.email }] : []),
                          ...(c.telegram ? [{ label: 'Telegram', value: c.telegram }] : []),
                          ...(c.phoneLast4 ? [{ label: 'Phone', value: `••••${c.phoneLast4}` }] : []),
                          ...(c.whatsappLast4 ? [{ label: 'WhatsApp', value: `••••${c.whatsappLast4}` }] : []),
                        ]}
                      />
                    ))}
                  </div>
                )}
              </Section>
            ) : null}
            <Section title="Bank accounts" count={client.bankAccounts.length} hint="Where INR is paid. Added and archived by the desk, with step-up.">
              {client.bankAccounts.length === 0 ? (
                <Notice tone="warning">None on file — a SELL request cannot be opened.</Notice>
              ) : (
                <KeyValues items={client.bankAccounts.map((b) => ({ key: b.id, label: b.label, value: <span className={d.secondary}>{b.detail.replace(/ ••••/, ' · ••••')}</span> }))} />
              )}
            </Section>
            <Section title="Wallets · TRC20" count={client.wallets.length} hint="Where USDT is sent.">
              {client.wallets.length === 0 ? (
                <Notice tone="warning">None on file — a BUY request cannot be opened.</Notice>
              ) : (
                <KeyValues items={client.wallets.map((w) => ({ key: w.id, label: w.label, value: <span className={d.mono}>{w.detail.replace(/^TRON · /, '')}</span> }))} />
              )}
            </Section>
            <Section title="Who may accept a quote" count={client.acceptors.length}>
              {client.acceptors.length === 0 ? (
                <Notice tone="warning">Nobody yet — a quote link cannot be accepted until someone at the client is authorized.</Notice>
              ) : (
                <ul className={d.stackTight} style={{ margin: 0, padding: 0, listStyle: 'none', gap: 4 }}>
                  {client.acceptors.map((a) => (
                    <li key={a.clientUserId} className={d.row}>
                      <Chip tone="success" glyph="done">
                        verified
                      </Chip>
                      {a.maskedEmail}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </Stack>
        </Columns>
      </PageBody>
    </Page>
  );
}
