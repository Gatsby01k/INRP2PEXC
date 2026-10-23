'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DeskToday } from '@inrp2p/traders';
import type { TelegramLinkView } from '@inrp2p/clients';
import { TelegramConnect } from '../_workspace/TelegramConnect.tsx';
import { CopyButton } from '@inrp2p/ui';
import { BankIcon, BoltIcon, ChartIcon, CheckIcon, DealsIcon, GaugeIcon, InfoIcon, TagIcon, TrendIcon, VaultIcon, WalletIcon } from '../_workspace/icons.tsx';
import { useServerClock } from '../exchange/useServerClock.ts';
import { DeskHead } from './_ui/DeskHead.tsx';
import { DeskNotice } from './_ui/DeskNotice.tsx';
import { DeskStatus } from './_ui/DeskStatus.tsx';
import { DealList } from './_ui/DealList.tsx';
import { NewDealSheet } from './_ui/NewDealSheet.tsx';
import { DESK_SIDE, inr, percent, rate, rateGap, relative, usdt, usdtShort } from './_ui/format.ts';
import shell from '../shell.module.css';
import styles from './desk.module.css';

/** Deals move on the client's side and the chain's: the screen looks again while it is being looked at. */
const LIVE_POLL_MS = 8_000;

type Readiness = DeskToday['readiness'];
const CHECKS: readonly { key: keyof Readiness; title: string; detail: string; href: string; fix: string }[] = [
  { key: 'approved', title: 'Approved as a trader', detail: 'INRP2P reviews your application once.', href: '/traders', fix: 'Traders' },
  { key: 'reserve', title: 'Security Reserve funded', detail: 'USDT from your registered wallet stands behind every deal.', href: '/traders/reserve', fix: 'Top up' },
  { key: 'destinations', title: 'Bank account and wallet verified', detail: 'Where your rupees and USDT come from and go to.', href: '/traders/settlement', fix: 'Check' },
  { key: 'liquidity', title: 'Liquidity to fill deals', detail: 'Rupees to buy USDT, USDT to sell — set on Traders.', href: '/traders', fix: 'Set capacity' },
  { key: 'network', title: 'TRX for the network', detail: 'Your network deposit pays each deal’s transfers.', href: '/traders/network', fix: 'Add TRX' },
  { key: 'prices', title: 'Prices live', detail: 'What you pay for USDT and what you ask for it.', href: '/desk/prices', fix: 'Set prices' },
  { key: 'live', title: 'Desk live', detail: 'Your page takes deals and your links work.', href: '/desk/settings', fix: 'Go live' },
];

type PeriodKey = 'today' | 'week' | 'month';
const PERIODS: readonly { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
];

/**
 * The desk's "Today", in the order a desk works: can clients get a price; what waits on me; how am I doing; my prices
 * and what I can fill; what else is open. Everything comes from the desk projection, read again every few seconds.
 */
export function TodayScreen({
  today,
  host,
  canAdmin,
  canCommit,
  telegram,
}: {
  today: DeskToday;
  host: string;
  canAdmin: boolean;
  canCommit: boolean;
  telegram: { view: TelegramLinkView; botConfigured: boolean };
}) {
  const router = useRouter();
  const now = useServerClock(today.now, false);
  const [period, setPeriod] = useState<PeriodKey>('today');
  const { desk, readiness, prices } = today;

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  const done = CHECKS.filter((c) => readiness[c.key]).length;
  const next = CHECKS.find((c) => !readiness[c.key]);
  const dealing = done === CHECKS.length;
  // A suspended desk is told why above; its own steps do not bring it back, so the checklist (and its “Go live”) waits.
  const suspended = desk.status === 'SUSPENDED';
  const p = today.periods[period];
  const address = `${host}/${desk.handle}`;
  const spread = prices.SELL_USDT && prices.BUY_USDT ? rateGap(prices.BUY_USDT.rate, prices.SELL_USDT.rate) : null;

  return (
    <>
      <DeskHead
        icon={<GaugeIcon />}
        title={desk.displayName}
        status={<DeskStatus status={desk.status} />}
        lede={
          <span className={styles.address}>
            <span className={styles.addressText}>{address}</span>
            <CopyButton value={`https://${address}`} label="your desk’s address" />
          </span>
        }
        aside={<NewDealSheet deskName={desk.displayName} feeBps={today.feeBps} prices={prices} status={desk.status} canCommit={canCommit} />}
        waiting={today.yourMove.length}
      />
      <main className={shell.main}>
        <DeskNotice desk={desk} />
        {!dealing && !suspended ? (
          <section className={shell.card} aria-labelledby="ready-title">
            <div className={shell.cardHead}>
              <h2 id="ready-title" className={shell.cardTitle}>
                {desk.status === 'LIVE' ? 'Clients cannot get a price right now' : done === CHECKS.length - 1 ? 'Ready to go live' : 'Getting your desk ready'}
              </h2>
              <span className={shell.muted}>
                {done} of {CHECKS.length}
              </span>
            </div>
            <div className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={CHECKS.length} aria-valuenow={done} aria-label="Steps done">
              <span className={styles.progressBar} style={{ width: `${(done / CHECKS.length) * 100}%` }} />
            </div>
            <ol className={styles.checklist}>
              {CHECKS.map((c) => {
                const ok = readiness[c.key];
                const isNext = c === next;
                const canFix = c.key === 'live' ? canAdmin : c.key === 'prices' ? canCommit : true;
                return (
                  <li key={c.key} className={styles.check} {...(ok ? { 'data-done': '' } : {})} {...(isNext ? { 'data-next': '' } : {})}>
                    <span className={styles.checkMark} aria-hidden="true">
                      <CheckIcon />
                    </span>
                    <span className={styles.checkText}>
                      <span className={styles.checkTitle}>
                        {c.title}
                        <span className="ix-visually-hidden">{ok ? ' — done' : ' — to do'}</span>
                      </span>
                      {ok ? null : <span className={styles.checkDetail}>{c.detail}</span>}
                    </span>
                    {!ok && canFix ? (
                      isNext ? (
                        <Link className={shell.action} data-size="sm" data-tone="ink" href={c.href}>
                          {c.fix}
                        </Link>
                      ) : (
                        <Link className={shell.textAction} href={c.href}>
                          {c.fix}
                        </Link>
                      )
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {today.yourMove.length > 0 ? (
          <section className={`${shell.card} ${styles.urgent}`} aria-labelledby="move-title">
            <div className={shell.cardHead}>
              <span className={shell.cardTitleRow}>
                <span className={shell.cardGlyph} data-tone="brand" aria-hidden="true">
                  <BoltIcon />
                </span>
                <h2 id="move-title" className={shell.cardTitle}>
                  Waiting on you
                </h2>
              </span>
              <span className={shell.muted}>{today.yourMove.length === 1 ? '1 deal' : `${today.yourMove.length} deals`}</span>
            </div>
            <DealList deals={today.yourMove} now={today.now} showNext />
          </section>
        ) : null}

        <section className={shell.card} aria-labelledby="numbers-title">
          <div className={shell.cardHead}>
            <span className={shell.cardTitleRow}>
              <span className={shell.cardGlyph} aria-hidden="true">
                <ChartIcon />
              </span>
              <h2 id="numbers-title" className={shell.cardTitle}>
                Turnover
              </h2>
            </span>
            <div className={styles.periods} role="group" aria-label="Period">
              {PERIODS.map((x) => (
                <button key={x.key} type="button" className={styles.period} aria-pressed={period === x.key} onClick={() => setPeriod(x.key)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>
          <div className={`${styles.kpis} ${styles.kpisInCard}`}>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>
                <span className={styles.kpiIcon} aria-hidden="true">
                  <DealsIcon />
                </span>
                Deals completed
              </span>
              <span className={styles.kpiValue}>{p.deals}</span>
              <span className={styles.kpiSub}>{today.clients.total === 1 ? '1 client' : `${today.clients.total} clients`}{today.clients.newThisWeek > 0 ? ` · ${today.clients.newThisWeek} new this week` : ''}</span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>
                <span className={styles.kpiIcon} aria-hidden="true">
                  <TrendIcon />
                </span>
                Volume
              </span>
              <span className={styles.kpiValue}>
                {usdt(p.usdt, false)}
                <span className={styles.kpiUnit}>USDT</span>
              </span>
              <span className={styles.kpiSub}>Through your desk</span>
            </div>
            <div className={styles.kpi}>
              <span className={styles.kpiLabel}>
                <span className={styles.kpiIcon} aria-hidden="true">
                  <ChartIcon />
                </span>
                INRP2P fees
              </span>
              <span className={styles.kpiValue}>
                {usdt(p.fees, false)}
                <span className={styles.kpiUnit}>USDT</span>
              </span>
              <span className={styles.kpiSub}>{percent(today.feeBps)} of each deal’s USDT</span>
            </div>
          </div>
        </section>

        <div className={styles.grid2}>
          <section className={shell.card} aria-labelledby="prices-title">
            <div className={shell.cardHead}>
              <span className={shell.cardTitleRow}>
                <span className={shell.cardGlyph} aria-hidden="true">
                  <TagIcon />
                </span>
                <h2 id="prices-title" className={shell.cardTitle}>
                  Your prices
                </h2>
              </span>
              {canCommit ? (
                <Link className={shell.textAction} href="/desk/prices">
                  Edit
                </Link>
              ) : null}
            </div>
            <div className={styles.priceTiles}>
              {(['SELL_USDT', 'BUY_USDT'] as const).map((d) => {
                const price = prices[d];
                const on = price?.offered ?? false;
                return (
                  <div key={d} className={styles.priceTile} {...(on ? {} : { 'data-off': '' })}>
                    <span className={styles.priceCaption}>
                      {DESK_SIDE[d].you}
                      <span className={styles.liveDot} {...(on ? {} : { 'data-off': '' })}>
                        {on ? 'Live' : 'Off'}
                      </span>
                    </span>
                    <span className={styles.priceValue}>{price ? rate(price.rate) : '—'}</span>
                    <span className={styles.priceMeta}>
                      {price ? `${usdt(price.min, false)}–${usdt(price.max)}` : 'No price yet'}
                      {price && on ? ` · ${relative(Date.parse(price.validUntil), now).replace('in ', '')} left` : ''}
                    </span>
                  </div>
                );
              })}
            </div>
            {spread !== null ? (
              <p className={styles.spread}>
                <span>Your spread</span>
                <strong>{spread} per USDT</strong>
              </p>
            ) : null}
          </section>

          <section className={shell.card} aria-labelledby="fill-title">
            <div className={shell.cardHead}>
              <span className={shell.cardTitleRow}>
                <span className={shell.cardGlyph} aria-hidden="true">
                  <VaultIcon />
                </span>
                <h2 id="fill-title" className={shell.cardTitle}>
                  What you can fill
                </h2>
              </span>
              <Link className={shell.textAction} href="/traders">
                Capacity
              </Link>
            </div>
            <div className={styles.stack}>
              <div className={styles.figure}>
                <span className={styles.figureLabel}>
                  <span className={styles.figureIcon} aria-hidden="true">
                    <BankIcon />
                  </span>
                  Rupees to buy USDT
                </span>
                <span className={styles.figureValue}>{today.capacity.SELL_USDT ? inr(today.capacity.SELL_USDT.available) : 'Not offered'}</span>
              </div>
              <div className={styles.figure}>
                <span className={styles.figureLabel}>
                  <span className={styles.figureIcon} aria-hidden="true">
                    <WalletIcon />
                  </span>
                  USDT to sell
                </span>
                <span className={styles.figureValue}>{today.capacity.BUY_USDT ? usdtShort(today.capacity.BUY_USDT.available) : 'Not offered'}</span>
              </div>
              <div className={styles.figure}>
                <span className={styles.figureLabel}>
                  <span className={styles.figureIcon} aria-hidden="true">
                    <BoltIcon />
                  </span>
                  Network deposit
                </span>
                <span className={styles.figureValue}>
                  {today.network.dealsCovered === null ? '—' : today.network.dealsCovered === 1 ? 'Covers 1 more deal' : `Covers ${today.network.dealsCovered} more deals`}
                </span>
              </div>
            </div>
            {today.network.short ? (
              <p className={shell.info} data-tone="warning">
                <InfoIcon className={shell.infoIcon} />
                <span>
                  Not enough TRX for the next deal’s transfers. <Link className={shell.textAction} href="/traders/network">Add TRX</Link>
                </span>
              </p>
            ) : null}
          </section>
        </div>

        <TelegramConnect view={telegram.view} botConfigured={telegram.botConfigured} title="Deal alerts in Telegram" />

        <section className={shell.card} aria-labelledby="open-title">
          <div className={shell.cardHead}>
            <span className={shell.cardTitleRow}>
              <span className={shell.cardGlyph} aria-hidden="true">
                <DealsIcon />
              </span>
              <h2 id="open-title" className={shell.cardTitle}>
                Open deals
              </h2>
            </span>
            <Link className={shell.textAction} href="/desk/deals">
              All deals
            </Link>
          </div>
          {today.open.length > 0 ? (
            <DealList deals={today.open} now={today.now} />
          ) : (
            <p className={shell.muted}>
              {desk.status === 'LIVE' ? 'Nothing else open. Send a client a deal link, or share your page.' : suspended ? 'No deal open.' : 'Deals appear here once your desk is live.'}
              {today.openLinks > 0 ? ` ${today.openLinks === 1 ? 'One link is' : `${today.openLinks} links are`} waiting to be taken.` : ''}
            </p>
          )}
        </section>
      </main>
    </>
  );
}
