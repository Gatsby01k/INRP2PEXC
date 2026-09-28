'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { TraderHome } from '@inrp2p/traders';
import { formatCountdown } from '@inrp2p/ui/format';
import { AssistantPanel } from '../_assistant/AssistantPanel.tsx';
import { traderHomeAssistant } from '../_assistant/traders.ts';
import { useServerClock } from '../exchange/useServerClock.ts';
import { ActiveOrders } from './_ui/ActiveOrders.tsx';
import { ApplicationStatus } from './_ui/ApplicationStatus.tsx';
import { AvailabilityCard } from './_ui/AvailabilityCard.tsx';
import { BlockCard } from './_ui/BlockCard.tsx';
import { EarningsCard } from './_ui/EarningsCard.tsx';
import { OfferCard } from './_ui/OfferCard.tsx';
import { Onboarding } from './_ui/Onboarding.tsx';
import { ReserveCard } from './_ui/ReserveCard.tsx';
import shell from '../shell.module.css';
import styles from './traders.module.css';

/** How often the working screen looks again: offers arrive, and orders move on the desk's side and the chain's. */
const LIVE_POLL_MS = 8_000;

/**
 * The Traders screen. What it shows is decided by the server's projection alone: not a trader yet, applied, or a
 * working trader. For a working trader, in the order a trader needs it (and the order a phone stacks it): am I
 * online and what can I provide; an order offered or in progress, with the next step; then the two sides, the
 * earnings and the reserve.
 */
export function TradersHome({ home }: { home: TraderHome }) {
  const router = useRouter();
  const working = home.state === 'APPROVED' || home.state === 'PAUSED';
  const now = useServerClock(home.now, home.offers.length > 0);

  // New offers and moving orders appear without a reload, while the page is being looked at.
  useEffect(() => {
    if (!working && home.state !== 'UNDER_REVIEW') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [working, home.state, router]);

  const state = traderHomeAssistant(home);
  const firstOffer = home.offers[0];

  return (
    <>
      <main className={shell.main}>
        {home.state === 'NONE' ? <Onboarding canApply={home.canApply} /> : null}
        {home.state === 'UNDER_REVIEW' || home.state === 'REJECTED' ? <ApplicationStatus home={home} /> : null}
        {working ? (
          <>
            <AvailabilityCard home={home} />
            {home.offers.map((o) => (
              <OfferCard
                key={o.ref}
                order={o}
                now={now}
                canAct={home.canAct}
                receiveAt={o.side === 'BUY_USDT' ? `Your registered wallet · TRC20 ${home.registered!.wallet}` : `Your registered account · ${home.registered!.bank}`}
              />
            ))}
            <ActiveOrders orders={home.active} />
            {home.blocks.length > 0 ? (
              <div className={styles.blocks} data-count={home.blocks.length}>
                {home.blocks.map((b) => (
                  <BlockCard key={`${b.side}:${b.version}`} block={b} canAct={home.canAct} />
                ))}
              </div>
            ) : null}
            <div className={styles.split}>
              {home.earnings ? <EarningsCard earnings={home.earnings} /> : null}
              {home.reserve ? <ReserveCard reserve={home.reserve} /> : null}
            </div>
            {home.registered ? (
              <section className={shell.card} aria-labelledby="registered-title">
                <h2 id="registered-title" className={shell.cardTitle}>
                  Registered settlement details
                </h2>
                <dl className={shell.facts}>
                  <div>
                    <dt>Bank account</dt>
                    <dd>{home.registered.bank}</dd>
                  </div>
                  <div>
                    <dt>TRC20 wallet</dt>
                    <dd title={home.registered.walletAddress}>{home.registered.wallet}</dd>
                  </div>
                </dl>
                <p className={styles.note}>You settle only through these. Changing them is reviewed by the desk — ask on your usual channel.</p>
              </section>
            ) : null}
          </>
        ) : null}
      </main>
      <AssistantPanel
        state={state}
        size={working ? 'large' : 'compact'}
        meta={firstOffer ? <span className={styles.countdown}>Offer open for {formatCountdown(Math.max(0, Date.parse(firstOffer.offerExpiresAt) - now))}</span> : null}
      >
        {working ? (
          <div className={styles.navRow}>
            <Link className={shell.textAction} href="/traders/orders">
              Orders
            </Link>
            <Link className={shell.textAction} href="/traders/reserve">
              Security Reserve
            </Link>
          </div>
        ) : null}
      </AssistantPanel>
    </>
  );
}
