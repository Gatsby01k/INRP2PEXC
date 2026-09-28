import Link from 'next/link';
import { notFound } from 'next/navigation';
import { deskTradeRecord, tradeIdByRef } from '@inrp2p/desk';
import { collectionAccounts } from '@inrp2p/traders';
import { operatorPage } from '../../../../server/operator.ts';
import { PanelSection } from '../../_desk/ContextPanel.tsx';
import { Icon } from '../../_desk/icons.tsx';
import { dateTime, money, share, sub } from '../../_desk/format.ts';
import { Columns, KeyValues, LifecycleChip, Meter, Notice, Page, PageBody, PageHeader, Section, Side, Stack, Timeline } from '../../_desk/ui.tsx';
import { Adjustments, Closeout, FlagException } from '../../_trade/Closeout.tsx';
import { tradePerms } from '../../_trade/perms.ts';
import { Economics, Headline, Stages } from '../../_trade/Summary.tsx';
import { TradeWorkspace } from '../../_trade/TradeWorkspace.tsx';
import d from '../../_desk/desk.module.css';
import o from '../orders.module.css';

export const dynamic = 'force-dynamic';

/**
 * The trade record: everything about one trade on one page, so nobody reconstructs it by hand (PRODUCT §2) — the
 * frozen terms and what they make, how far it has got, the client's funds and every payout with its reference,
 * the open cases, where it came from and where it pays, the route side, and every transition, leg, case and
 * adjustment in order. The ways a trade ends without settling — cancel, refund, adjust — live here, beside the
 * history that justifies them, rather than one click from the queue.
 */
export default async function TradeRecordPage({ params }: { params: Promise<{ ref: string }> }) {
  const ctx = await operatorPage();
  const { ref } = await params;
  const tradeId = await tradeIdByRef(ctx.db, decodeURIComponent(ref));
  if (!tradeId) notFound();
  const record = await deskTradeRecord(ctx.db, tradeId, ctx.access);
  const trade = record.trade;
  const perms = tradePerms(ctx);
  const collection = await collectionAccounts(ctx.db);
  const completed = trade.lifecycle === 'COMPLETED';

  return (
    <Page>
      <PageHeader
        crumbs={[{ href: '/orders', label: 'Orders' }]}
        title={<span className={d.num}>{trade.ref}</span>}
        badge={
          <span className={d.row}>
            <Side direction={trade.direction} />
            <LifecycleChip state={trade.lifecycle} hold={trade.hold} />
          </span>
        }
        meta={
          <>
            <Link href={`/clients/${trade.clientId}`} className={d.link}>
              {trade.clientName}
            </Link>{' '}
            · opened {dateTime(trade.openedAt)}
            {record.completedAt ? ` · completed ${dateTime(record.completedAt)}` : ''}
            {record.cancelledAt ? ` · cancelled ${dateTime(record.cancelledAt)}` : ''}
          </>
        }
        actions={
          <>
            {trade.receipt && perms.receipt ? (
              <a className={d.linkButton} href={`/api/receipts/${encodeURIComponent(trade.ref)}`} target="_blank" rel="noreferrer">
                <Icon name="external" size={12} />
                Settlement receipt
              </a>
            ) : null}
            {!completed && trade.lifecycle !== 'CANCELLED' ? (
              <Link className={d.linkButton} href={`/?row=trade:${trade.tradeId}`}>
                <Icon name="desk" size={12} />
                Work it on the desk
              </Link>
            ) : null}
          </>
        }
      />
      <PageBody>
        <div className={o.hero}>
          <Headline trade={trade} large />
          <div className={o.heroSide}>
            <Stages trade={trade} />
            {perms.economics ? <Economics trade={trade} realized={completed} /> : null}
          </div>
        </div>

        <Columns>
          <Stack>
            <Section>
              <TradeWorkspace trade={trade} perms={perms} collectionAccounts={collection} record />
            </Section>
            <Section title="History" count={record.timeline.length} hint="Every transition, leg, case and adjustment, newest first.">
              <Timeline
                events={record.timeline.map((e, i) => ({
                  key: `${e.at}:${i}`,
                  title: (
                    <>
                      {e.title}
                      {e.amount ? <span className={d.num}> · {money(e.amount.amount, e.amount.currency, { exact: e.amount.currency === 'USDT' })}</span> : null}
                    </>
                  ),
                  meta: [e.ref, e.actor ? `by ${e.actor}` : null, e.note].filter(Boolean).join(' · ') || undefined,
                  time: dateTime(e.at),
                  tone: e.tone,
                }))}
              />
            </Section>
          </Stack>

          <Stack>
            <Section title="Details">
              <KeyValues
                items={[
                  { label: 'Client', value: <Link href={`/clients/${trade.clientId}`} className={d.link}>{trade.clientName}</Link> },
                  { label: 'Request', value: record.requestRef },
                  { label: 'Quote', value: `${record.quoteRef}${record.acceptedAt ? ` · accepted ${dateTime(record.acceptedAt)}` : ''}` },
                  ...(record.destination
                    ? [
                        {
                          label: record.destination.kind === 'BANK' ? 'Pays INR to' : 'Sends USDT to',
                          value: (
                            <span className={d.stackTight} style={{ gap: 2 }}>
                              <span>{record.destination.label}</span>
                              <span className={d.secondary}>{record.destination.detail}</span>
                              {record.destination.active ? null : <span className={d.negative}>archived since acceptance</span>}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(trade.deposit ? [{ label: 'Deposit address', value: <span className={d.mono}>{trade.deposit.address}</span> }] : []),
                  { label: 'Network', value: 'TRON · TRC20' },
                ]}
              />
            </Section>

            {trade.route ? (
              <Section title="Route side" hint={`${trade.route.routeName} · ${trade.route.executionMode === 'DIRECT_TO_CLIENT' ? 'pays the client directly' : 'settles with the exchange'}`} actions={<Link href="/rates#positions" className={d.linkButton}>Route positions</Link>}>
                <RouteSide route={trade.route} />
              </Section>
            ) : null}

            <Section>
              <Closeout trade={trade} perms={perms} refundAccounts={collection} />
              {perms.openException && trade.lifecycle !== 'COMPLETED' && trade.lifecycle !== 'CANCELLED' ? <FlagException trade={trade} /> : null}
              <Adjustments adjustments={record.adjustments} perms={perms} />
              {trade.lifecycle === 'COMPLETED' || trade.lifecycle === 'CANCELLED' ? (
                <PanelSection title="Closed">
                  <Notice icon={completed ? 'check' : 'close'}>
                    {completed
                      ? 'Settled with the client. Any correction from here is a financial adjustment, approved by a second person.'
                      : 'Cancelled. Nothing further moves on this trade.'}
                  </Notice>
                </PanelSection>
              ) : null}
            </Section>
          </Stack>
        </Columns>
      </PageBody>
    </Page>
  );
}

function RouteSide({ route }: { route: NonNullable<Awaited<ReturnType<typeof deskTradeRecord>>['trade']['route']> }) {
  const sides = [
    { title: 'Route delivers', total: route.routeDelivers, remaining: route.routeDeliversRemaining },
    { title: 'Exchange delivers', total: route.exchangeDelivers, remaining: route.exchangeDeliversRemaining },
  ];
  return (
    <div className={d.stackTight}>
      {sides.map((s) => {
        const settled = share(sub(s.total.amount, s.remaining.amount, s.total.currency), s.total.amount, s.total.currency);
        return (
          <div key={s.title} className={d.stackTight} style={{ gap: 4 }}>
            <KeyValues
              split
              items={[
                { label: s.title, value: money(s.total.amount, s.total.currency), strong: true },
                { label: 'Still to settle', value: money(s.remaining.amount, s.remaining.currency) },
              ]}
            />
            <Meter size="sm" label={`${s.title}: ${money(s.remaining.amount, s.remaining.currency)} remaining`} parts={[{ value: settled, tone: 'success' }]} />
          </div>
        );
      })}
      <p className={d.fieldHint}>The client trade never waits for the route; this side settles separately on Rates.</p>
    </div>
  );
}
