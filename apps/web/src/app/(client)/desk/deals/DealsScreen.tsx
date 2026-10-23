'use client';

import Link from 'next/link';
import type { DeskDeal, DeskPeriod } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { revokeDeskDealLinkAction } from '../../../../server/actions/desks.ts';
import { EmptyState } from '../../_workspace/EmptyState.tsx';
import { LinkIcon, SwapIcon } from '../../_workspace/icons.tsx';
import { useServerClock } from '../../exchange/useServerClock.ts';
import { DealStatus } from '../_ui/DeskStatus.tsx';
import { DealList } from '../_ui/DealList.tsx';
import { initial, inr, rate, relative, sentence, usdt } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../desk.module.css';

interface LinkRow {
  readonly linkId: string;
  readonly ref: string;
  readonly direction: 'SELL_USDT' | 'BUY_USDT';
  readonly amount: string;
  readonly rate: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: 'OPEN' | 'TAKEN' | 'DONE' | 'EXPIRED' | 'REVOKED';
  readonly clientName: string | null;
  readonly tradeRef: string | null;
}

const LINK_STATE: Record<LinkRow['state'], { label: string; tone: string }> = {
  OPEN: { label: 'Waiting', tone: 'live' },
  TAKEN: { label: 'Taken', tone: 'action' },
  DONE: { label: 'Became a deal', tone: 'done' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  REVOKED: { label: 'Revoked', tone: 'neutral' },
};

/** "1500.000000 USDT" / "100000.00 INR" as a person reads it. */
const linkAmount = (text: string) => {
  const [value = '0', unit] = text.split(' ');
  return unit === 'INR' ? inr(value) : usdt(value);
};

function Tabs({ tab }: { tab: string }) {
  const items = [
    { key: 'open', label: 'Open' },
    { key: 'done', label: 'Completed' },
    { key: 'links', label: 'Links' },
  ];
  return (
    <div className={styles.periods} role="tablist" aria-label="Deals">
      {items.map((i) => (
        <Link key={i.key} role="tab" aria-selected={tab === i.key} href={i.key === 'open' ? '/desk/deals' : `/desk/deals?tab=${i.key}`} className={`${styles.period} ${styles.periodLink}`} aria-pressed={tab === i.key}>
          {i.label}
        </Link>
      ))}
    </div>
  );
}

function Totals({ periods }: { periods: { today: DeskPeriod; week: DeskPeriod; month: DeskPeriod } }) {
  return (
    <p className={styles.summary}>
      <span>
        Today <strong>{periods.today.deals}</strong> · <strong>{usdt(periods.today.usdt)}</strong>
      </span>
      <span>
        30 days <strong>{periods.month.deals}</strong> deals · <strong>{usdt(periods.month.usdt)}</strong>
      </span>
      <span>
        INRP2P fees, 30 days <strong>{usdt(periods.month.fees)}</strong>
      </span>
    </p>
  );
}

function DealTable({ deals }: { deals: readonly DeskDeal[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Client</th>
          <th className={styles.num}>USDT</th>
          <th className={styles.num}>Rupees</th>
          <th className={styles.num}>Rate</th>
          <th className={styles.num}>Fee</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {deals.map((d) => (
          <tr key={d.ref}>
            <td>
              <span className={styles.who}>
                <span className={styles.avatar} data-tone={d.direction === 'BUY_USDT' ? 'buy' : undefined} aria-hidden="true">
                  {initial(d.clientName)}
                </span>
                <span className={styles.whoText}>
                  <Link className={`${styles.rowLink} ${styles.whoName}`} href={`/desk/deals/${encodeURIComponent(d.ref)}`}>
                    {d.clientName}
                  </Link>
                  <span className={styles.whoMeta}>
                    {d.direction === 'SELL_USDT' ? 'Sold to you' : 'Bought from you'} · {formatIstDateTime(new Date(d.completedAt ?? d.at))}
                  </span>
                </span>
              </span>
            </td>
            <td className={styles.num}>{usdt(d.usdt, false)}</td>
            <td className={styles.num} data-col="hide">
              {inr(d.inr)}
            </td>
            <td className={styles.num} data-col="hide">
              {rate(d.rate)}
            </td>
            <td className={styles.num} data-col="hide">
              {usdt(d.fee, false)}
            </td>
            <td>
              <DealStatus state={d.state} yourMove={d.yourMove} inReview={d.stage === 'REVIEW'} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Links({ links, now, canCommit }: { links: readonly LinkRow[]; now: number; canCommit: boolean }) {
  const { run, busy, error } = useCommand();
  if (links.length === 0) {
    return <EmptyState icon={<LinkIcon />} title="No links yet" body="A deal link carries one deal at your rate. Make one with New deal and send it in the chat your client is already in." />;
  }
  return (
    <>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Link</th>
            <th className={styles.num}>Amount</th>
            <th className={styles.num}>Rate</th>
            <th>Status</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {links.map((l) => {
            const s = LINK_STATE[l.state];
            const revocable = canCommit && (l.state === 'OPEN' || l.state === 'TAKEN');
            return (
              <tr key={l.linkId}>
                <td>
                  <span className={styles.whoText}>
                    <span className={styles.whoName}>{l.note ?? l.ref}</span>
                    <span className={styles.whoMeta}>
                      {l.direction === 'SELL_USDT' ? 'Client sells' : 'Client buys'}
                      {l.clientName ? ` · ${l.clientName}` : ''}
                      {l.state === 'OPEN' || l.state === 'TAKEN' ? ` · expires ${relative(Date.parse(l.expiresAt), now)}` : ` · ${formatIstDateTime(new Date(l.createdAt))}`}
                    </span>
                  </span>
                </td>
                <td className={styles.num}>{linkAmount(l.amount)}</td>
                <td className={styles.num} data-col="hide">
                  {rate(l.rate)}
                </td>
                <td>
                  <span className={styles.status} data-tone={s.tone}>
                    <span className={styles.statusDot} aria-hidden="true" />
                    {s.label}
                  </span>
                </td>
                <td className={styles.num}>
                  {revocable ? (
                    <button type="button" className={shell.textAction} disabled={busy} onClick={() => void run(`Revoke ${l.ref}`, (key) => revokeDeskDealLinkAction({ linkId: l.linkId, reason: 'revoked from the desk workspace' }, key))}>
                      Revoke
                    </button>
                  ) : l.tradeRef ? (
                    <span className={shell.muted}>{l.tradeRef}</span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error ? (
        <p className={shell.error} role="alert">
          {sentence(error)}
        </p>
      ) : null}
    </>
  );
}

export function DealsScreen({
  tab,
  deals,
  periods,
  links,
  now: serverNow,
  canCommit,
}: {
  tab: 'open' | 'done' | 'links';
  deals: readonly DeskDeal[];
  periods: { today: DeskPeriod; week: DeskPeriod; month: DeskPeriod };
  links: readonly LinkRow[] | null;
  now: string;
  canCommit: boolean;
}) {
  const now = useServerClock(serverNow, false);
  return (
    <main className={shell.main}>
      <section className={shell.card} aria-label="Deals">
        <div className={styles.filters}>
          <Tabs tab={tab} />
          <Totals periods={periods} />
        </div>
        {tab === 'links' ? (
          <Links links={links ?? []} now={now} canCommit={canCommit} />
        ) : deals.length === 0 ? (
          <EmptyState
            icon={<SwapIcon />}
            title={tab === 'open' ? 'Nothing open' : 'No completed deals yet'}
            body={tab === 'open' ? 'A deal appears here the moment a client takes your price — from your page or a link you sent.' : 'Deals your clients complete with you are listed here, with what you received and the fee.'}
          />
        ) : tab === 'open' ? (
          <DealList deals={deals} now={serverNow} showNext />
        ) : (
          <DealTable deals={deals} />
        )}
      </section>
    </main>
  );
}
