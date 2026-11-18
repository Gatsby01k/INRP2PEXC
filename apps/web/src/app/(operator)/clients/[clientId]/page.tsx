import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type ClientAccess, type ClientDetail, clientDetail, clientSignIns } from '@inrp2p/desk';
import { listUpiIds } from '@inrp2p/clients';
import { CopyButton } from '@inrp2p/ui';
import { UsdtOnTron } from '../../../../components/PayMarks.tsx';
import { can, operatorPage } from '../../../../server/operator.ts';
import { Ago } from '../../_desk/clock.tsx';
import { Icon } from '../../_desk/icons.tsx';
import { date, dateTime, marginNegative, marginText, rate, titleCase, usdt, usdtCompact } from '../../_desk/format.ts';
import { Chip, Page, PageBody, PageHeader } from '../../_desk/ui.tsx';
import { Facts, Group, Hero, Monogram, Sheet, Stats, Steps, bankParts, bookStyles as b, deviceOf, flagOf, placeText, shortAddress } from '../../_book/parts.tsx';
import { BankAccounts } from './BankAccounts.tsx';
import { NewRequest } from './NewRequest.tsx';
import { RecentTrades } from './RecentTrades.tsx';
import { UpiIds } from './UpiIds.tsx';
import d from '../../_desk/desk.module.css';

export const dynamic = 'force-dynamic';

const usually = (c: Pick<ClientDetail, 'typicalDirection' | 'typicalSize'>): string | null =>
  c.typicalDirection ? `${c.typicalDirection === 'SELL_USDT' ? 'Sells' : 'Buys'} USDT${c.typicalSize ? ` · ~${usdtCompact(c.typicalSize)}` : ''}` : null;

/**
 * One client, as the desk needs them before quoting (brief "Clients"). The orange field says what they are to INRP2P —
 * what they have traded — and beside it whether they can trade at all: INR has somewhere to go, USDT has somewhere to
 * go, someone may accept. Then the work (a request, their trades) on the left, and on one sheet beside it where money
 * may go and who may say yes.
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
  const canManage = can(ctx, 'client:manage');
  // Where the client's people sign in from is for whoever manages the client — the same people who see its contacts.
  const [upiIds, signIns] = await Promise.all([listUpiIds(ctx.db, clientId), canManage ? clientSignIns(ctx.db, clientId) : Promise.resolve(null as ClientAccess | null)]);
  const canRequest = can(ctx, 'request:create');
  const canManageMoney = can(ctx, 'client_bank:add');
  // "Repeat trade" prefills the builder from a previous trade of this client — nothing is created until the dealer
  // presses the button, so a repeat is still a fresh request with its own terms.
  const repeatOf = typeof query.repeat === 'string' ? client.recentTrades.find((t) => t.tradeId === query.repeat) : undefined;

  const suspended = client.status !== 'ACTIVE';
  const bank = client.bankAccounts[0];
  const wallet = client.wallets[0];
  const liveUpi = upiIds.filter((u) => u.status === 'ACTIVE');
  const pausedUpi = upiIds.filter((u) => u.status === 'PENDING_REVIEW');
  const ready = [client.bankAccounts.length > 0, client.wallets.length > 0, client.acceptors.length > 0];
  const last = client.recentTrades[0];
  const margin = client.stats.marginGenerated;
  const madeSome = margin !== undefined && /[1-9]/.test(`${margin}${client.stats.marginGeneratedUsdt ?? ''}`);
  const typical = usually(client);

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: '/clients', label: 'Clients' }]}
        title={
          <span className={b.who} style={{ gap: 'var(--space-3)' }}>
            <Monogram name={client.name} size={40} {...(suspended ? { tone: 'quiet' as const } : {})} />
            {client.name}
          </span>
        }
        badge={
          <span className={d.row}>
            {suspended ? <Chip tone="danger" glyph="closed">Suspended</Chip> : <Chip tone="success" glyph="done">Active</Chip>}
            <Chip tone={client.kycStatus === 'VERIFIED' ? 'success' : client.kycStatus === 'REJECTED' || client.kycStatus === 'EXPIRED' ? 'danger' : 'neutral'}>KYC {titleCase(client.kycStatus).toLowerCase()}</Chip>
          </span>
        }
        meta={`${client.ref} · ${client.legalName} · ${client.type === 'COMPANY' ? 'company' : 'individual'} · joined ${date(client.joinedAt)}`}
      />
      <PageBody>
        <Hero
          label="Client at a glance"
          eyebrow={suspended ? 'Suspended · no new requests' : 'Traded through INRP2P'}
          figure={
            <>
              {usdt(client.stats.completedVolume, { unit: false })}
              <small>USDT</small>
            </>
          }
          sub={
            <>
              {client.stats.completedTrades === 0 ? 'No completed trade yet' : `${client.stats.completedTrades} completed trade${client.stats.completedTrades === 1 ? '' : 's'}`}
              {margin !== undefined && madeSome ? ` · ${marginText(margin, /[1-9]/.test(client.stats.marginGeneratedUsdt ?? '') ? client.stats.marginGeneratedUsdt : null)} ${marginNegative(margin, client.stats.marginGeneratedUsdt) ? 'lost' : 'made'}` : ''}
            </>
          }
          stages={ready.filter(Boolean).length as 0 | 1 | 2 | 3}
          stopped={suspended}
          side={
            <>
              <Steps
                label="What this client can do"
                items={[
                  {
                    key: 'sell',
                    name: 'Sells USDT',
                    sub: bank ? `INR to ${bankParts(bank.detail).bank} ••••${bankParts(bank.detail).last4}` : 'no bank account for INR',
                    state: bank ? 'done' : 'blocked',
                  },
                  {
                    key: 'buy',
                    name: 'Buys USDT',
                    sub: wallet ? `USDT to ${shortAddress(wallet.detail.replace(/^TRON · /, ''))}` : 'no wallet for USDT',
                    state: wallet ? 'done' : 'blocked',
                  },
                  {
                    key: 'accept',
                    name: 'Accepts quotes',
                    sub: client.acceptors.length > 0 ? `${client.acceptors.length} ${client.acceptors.length === 1 ? 'person' : 'people'} verified` : 'nobody authorized yet',
                    state: client.acceptors.length > 0 ? 'done' : 'blocked',
                  },
                ]}
              />
              <Stats
                label="Client figures"
                items={[
                  { key: 'open', label: 'Open trades', value: String(client.stats.openTrades), sub: client.stats.openTrades > 0 ? 'in flight now' : 'nothing in flight', ...(client.stats.openTrades === 0 ? { tone: 'muted' as const } : {}) },
                  { key: 'last', label: 'Last trade', value: last ? <Ago at={last.openedAt} /> : 'never', sub: last ? last.ref : 'no trade yet', ...(last ? {} : { tone: 'muted' as const }) },
                  ...(ctx.access.economics ? [{ key: 'rate', label: 'Last rate', value: last?.clientRate ? rate(last.clientRate) : '—', sub: last?.clientRate ? 'client rate, per USDT' : 'no priced trade', ...(last?.clientRate ? {} : { tone: 'muted' as const }) }] : []),
                  { key: 'usually', label: 'Usually', value: typical ? typical.split(' · ')[0]! : '—', sub: typical?.split(' · ')[1] ?? 'no size recorded', ...(typical ? {} : { tone: 'muted' as const }) },
                ]}
              />
            </>
          }
        />

        <div className={b.columns}>
          <div className={b.main}>
            {canRequest ? (
              <Sheet id="new-request" title={repeatOf ? `Repeat ${repeatOf.ref}` : 'New request'} hint="Opens the request, then the desk’s quote builder for it.">
                <NewRequest client={client} {...(repeatOf ? { prefill: { direction: repeatOf.direction, amount: repeatOf.base } } : {})} />
              </Sheet>
            ) : null}
            <Sheet
              title="Trades"
              count={client.recentTrades.length}
              hint="The latest, newest first. Repeat prefills a new request."
              actions={
                <Link href={`/orders?q=${encodeURIComponent(client.name)}&state=ALL`} className={b.rowAction}>
                  Every trade <Icon name="arrowUpRight" size={12} />
                </Link>
              }
              flush
            >
              <div className={b.bookTable}>
                <RecentTrades trades={client.recentTrades} canRepeat={canRequest} />
              </div>
            </Sheet>
          </div>

          <div className={b.aside}>
            <Sheet title="Money and people" hint="Where INRP2P pays this client, and who may say yes." flush label="Money and people">
              <Group title="Pays INR to" count={client.bankAccounts.length} hint="bank accounts" label="Bank accounts">
                <BankAccounts accounts={client.bankAccounts} canArchive={canManageMoney} />
              </Group>
              <Group id="upi" title="UPI IDs" count={liveUpi.length} hint={pausedUpi.length > 0 ? `${pausedUpi.length} paused by a payer` : 'checked by a person first'} label="UPI IDs">
                <UpiIds upiIds={upiIds} canReview={canManageMoney} />
              </Group>
              <Group title="Sends USDT to" count={client.wallets.length} hint="TRC20 wallets" label="Wallets">
                {client.wallets.length === 0 ? (
                  <p className={b.gap}>
                    <Icon name="flag" size={12} />
                    None on file — a BUY request cannot be opened.
                  </p>
                ) : (
                  <ul className={b.rows}>
                    {client.wallets.map((w) => {
                      const address = w.detail.replace(/^TRON · /, '');
                      return (
                        <li key={w.id} className={b.row}>
                          <UsdtOnTron size={32} />
                          <span className={b.rowMain}>
                            <span className={b.rowTitle}>
                              <span>{w.label}</span>
                            </span>
                            <span className={`${b.rowSub} ${b.addr}`} title={address}>
                              {shortAddress(address)}
                            </span>
                          </span>
                          <span className={b.rowEnd}>
                            <CopyButton value={address} label="wallet address" />
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Group>
              <Group title="May accept a quote" count={client.acceptors.length} hint="verified people" label="Who may accept a quote">
                {client.acceptors.length === 0 ? (
                  <p className={b.gap}>
                    <Icon name="flag" size={12} />
                    Nobody yet — a quote link cannot be accepted until someone at the client is authorized.
                  </p>
                ) : (
                  <ul className={b.rows}>
                    {client.acceptors.map((a) => (
                      <li key={a.clientUserId} className={b.row}>
                        <span className={b.glyph}>
                          <Icon name="user" size={14} />
                        </span>
                        <span className={b.rowMain}>
                          <span className={b.rowTitle}>
                            <span>{a.maskedEmail}</span>
                          </span>
                          <span className={b.rowSub}>may accept this client’s quotes</span>
                        </span>
                        <span className={b.rowEnd}>
                          <Chip tone="success" glyph="done">
                            verified
                          </Chip>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Group>
            </Sheet>

            <Sheet title="About" flush label="About the client">
              <Group title="Record" label="Record">
                <Facts
                  items={[
                    { label: 'Legal name', value: client.legalName },
                    { label: 'Type', value: client.type === 'COMPANY' ? 'Company' : 'Individual' },
                    { label: 'Reference', value: <span className={d.mono}>{client.ref}</span> },
                    { label: 'Joined', value: <>{dateTime(client.joinedAt)} · <Ago at={client.joinedAt} /></> },
                    ...(signIns
                      ? [
                          {
                            label: 'First sign-in',
                            value: signIns.first ? (
                              <>
                                {flagOf(signIns.first.place?.country)} {placeText(signIns.first.place) ?? 'place not recorded'}
                                <span className={b.whoSub} style={{ display: 'block', whiteSpace: 'normal' }}>
                                  <span className={b.addr}>{signIns.first.ip ?? 'no address'}</span> · {deviceOf(signIns.first.userAgent)} · {dateTime(signIns.first.at)}
                                </span>
                              </>
                            ) : (
                              <span className={d.muted}>not recorded yet</span>
                            ),
                          },
                        ]
                      : []),
                    { label: 'KYC', value: titleCase(client.kycStatus) },
                    { label: 'Pricing notes', value: client.pricingNotes ?? <span className={d.muted}>none</span> },
                  ]}
                />
              </Group>
              {signIns ? (
                <Group title="Sign-ins" count={signIns.latest.length} hint="latest: place, address, device" label="Sign-ins">
                  {signIns.latest.length === 0 ? (
                    <p className={b.quiet}>No sign-in on record yet.</p>
                  ) : (
                    <ul className={b.rows}>
                      {signIns.latest.map((x) => (
                        <li key={x.key} className={b.row}>
                          <span className={b.glyph} aria-hidden="true" style={{ fontSize: 16 }}>
                            {flagOf(x.place?.country) || <Icon name={x.method === 'TELEGRAM' ? 'link' : 'user'} size={14} />}
                          </span>
                          <span className={b.rowMain}>
                            <span className={b.rowTitle}>
                              <span>{placeText(x.place) ?? deviceOf(x.userAgent)}</span>
                            </span>
                            <span className={b.rowSub} data-wrap="">
                              <span className={b.addr}>{x.ip ?? 'address not recorded'}</span>
                              {x.place ? ` · ${deviceOf(x.userAgent)}` : ''} · {x.who} · {dateTime(x.at)}
                              {x.method ? ` · ${x.method === 'TELEGRAM' ? 'Telegram' : 'email code'}` : ''}
                            </span>
                          </span>
                          <span className={b.rowEnd}>{x.live ? <Chip tone="success" glyph="done">live</Chip> : <Chip>ended</Chip>}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Group>
              ) : null}
              {client.contacts ? (
                <Group title="Contacts" count={client.contacts.length} hint="CRM only — never a way to sign in" label="Contacts">
                  {client.contacts.length === 0 ? (
                    <p className={b.quiet}>No contacts recorded.</p>
                  ) : (
                    <ul className={b.rows}>
                      {client.contacts.map((c) => (
                        <li key={c.id} className={b.row}>
                          <Monogram name={c.name} size={32} tone="quiet" />
                          <span className={b.rowMain}>
                            <span className={b.rowTitle}>
                              <span>{c.name}</span>
                              {c.primary ? <Chip tone="brand">primary</Chip> : null}
                            </span>
                            <span className={b.rowSub} data-wrap="">
                              {[c.email, c.telegram, c.phoneLast4 ? `phone ••••${c.phoneLast4}` : null, c.whatsappLast4 ? `WhatsApp ••••${c.whatsappLast4}` : null].filter(Boolean).join(' · ') || 'no way to reach recorded'}
                            </span>
                          </span>
                          <span />
                        </li>
                      ))}
                    </ul>
                  )}
                </Group>
              ) : null}
            </Sheet>
          </div>
        </div>
      </PageBody>
    </Page>
  );
}

