import Link from 'next/link';
import { clientDesks } from '@inrp2p/quotes';
import { formatIstDate } from '@inrp2p/ui/format';
import { memberPage } from '../../../server/client.ts';
import { EmptyState } from '../_workspace/EmptyState.tsx';
import { PageHead } from '../_workspace/PageHead.tsx';
import { ArrowIcon, StoreIcon } from '../_workspace/icons.tsx';
import { MarkArt } from '../../../components/MarkArt.tsx';
import { DeskStatus } from '../desk/_ui/DeskStatus.tsx';
import { rate, usdt } from '../desk/_ui/format.ts';
import shell from '../shell.module.css';
import { Amount } from '../../../components/Amount.tsx';
import styles from './desks.module.css';

export const dynamic = 'force-dynamic';

/**
 * "My desks" (ADR 0020): the independent desks this client has asked for a price or taken a link from — each with its
 * live prices and the client's own dealings with it — the most recently used first. A desk is opened from here to deal.
 */
export default async function MyDesksPage() {
  const ctx = await memberPage();
  const desks = await clientDesks(ctx.db, ctx.member.clientId);
  return (
    <>
      <PageHead icon={<StoreIcon />} title="Desks" lede="Independent desks you deal with on INRP2P. Their prices are their own; every deal settles through INRP2P’s escrow." />
      <main className={shell.main}>
        {desks.length === 0 ? (
          <section className={shell.card}>
            <EmptyState icon={<StoreIcon />} title="No desks yet" body="A desk appears here the first time you ask its page for a price or take a deal link it sent you." />
          </section>
        ) : (
          <ul className={styles.deskGrid}>
            {desks.map((d) => (
              <li key={d.handle}>
                <Link className={styles.deskCard} href={`/desks/${d.handle}`}>
                  <MarkArt className={styles.deskCardArt} hub={false} />
                  <span className={styles.deskCardHead}>
                    <span className={styles.monogram} aria-hidden="true">
                      {d.displayName.trim().charAt(0).toUpperCase()}
                    </span>
                    <span className={styles.rowText}>
                      <span className={styles.rowName}>
                        {d.displayName} {d.deskStatus !== 'LIVE' ? <DeskStatus status={d.deskStatus} /> : null}
                      </span>
                      <span className={styles.rowMeta}>
                        {d.relation === 'BLOCKED'
                          ? 'Not dealing with your account'
                          : d.completedDeals > 0
                            ? `${d.completedDeals} ${d.completedDeals === 1 ? 'deal' : 'deals'} · ${usdt(d.completedUsdt)}${d.lastDealAt ? ` · last ${formatIstDate(new Date(d.lastDealAt))}` : ''}`
                            : `Since ${formatIstDate(new Date(d.since))}`}
                        {d.openDeals > 0 ? ` · ${d.openDeals} open` : ''}
                      </span>
                    </span>
                  </span>
                  <span className={styles.deskCardRates}>
                    <span className={styles.deskCardRate}>
                      <span>Sell USDT</span>
                      <strong>{d.prices.SELL_USDT ? <Amount value={rate(d.prices.SELL_USDT)} /> : '—'}</strong>
                    </span>
                    <span className={styles.deskCardRate}>
                      <span>Buy USDT</span>
                      <strong>{d.prices.BUY_USDT ? <Amount value={rate(d.prices.BUY_USDT)} /> : '—'}</strong>
                    </span>
                  </span>
                  <span className={styles.deskCardGo}>
                    Get a firm price
                    <ArrowIcon className={styles.deskCardGoIcon} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
