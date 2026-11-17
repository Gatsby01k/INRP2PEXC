'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { TraderHome, TraderNetworkView } from '@inrp2p/traders';
import { formatCountdown } from '@inrp2p/ui/format';
import { AssistantPanel } from '../_assistant/AssistantPanel.tsx';
import { traderHomeAssistant } from '../_assistant/traders.ts';
import { useServerClock } from '../exchange/useServerClock.ts';
import { ActiveOrders } from './_ui/ActiveOrders.tsx';
import { ApplicationStatus } from './_ui/ApplicationStatus.tsx';
import { Issue } from './_ui/AvailabilityCard.tsx';
import { Balances, MoveField, ReserveTile, SettleTile } from './_ui/HomeParts.tsx';
import { NetworkCard } from './_ui/NetworkCard.tsx';
import { PricesCard } from './_ui/PricesCard.tsx';
import { OfferCard } from './_ui/OfferCard.tsx';
import { PriceAskCard } from './_ui/PriceAskCard.tsx';
import { Onboarding } from './_ui/Onboarding.tsx';
import { StartChecklist, showStartChecklist } from './_ui/StartChecklist.tsx';
import { ReserveCard } from './_ui/ReserveCard.tsx';
import shell from '../shell.module.css';
import styles from './traders.module.css';
import home$ from './_ui/home.module.css';

/** How often the working screen looks again: offers arrive, and orders move on the desk's side and the chain's. */
const LIVE_POLL_MS = 8_000;

/**
 * The Traders screen. What it shows is decided by the server's projection alone: not a trader yet, applied, or a
 * working trader. For a working trader, in the order a trader needs it (and the order a phone stacks it): am I
 * online and what can I provide; an order offered or in progress, with the next step; then the two sides, the
 * earnings and the reserve.
 */
export function TradersHome({ home, network }: { home: TraderHome; network: TraderNetworkView | null }) {
  const router = useRouter();
  const working = home.state === 'APPROVED' || home.state === 'PAUSED';
  const now = useServerClock(home.now, home.offers.length > 0 || home.priceAsks.length > 0 || home.active.some((o) => o.dueBy !== null));

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

  // The working screen, as the mock-up lays it: what to answer first (offers, price asks, anything that stops orders),
  // then the move beside the balances, the queue in lanes, and along the foot the prices, the reserve and settlement.
  if (working) {
    return (
      <main className={shell.main}>
        <div className={home$.grid}>
        {showStartChecklist(home) ? <StartChecklist home={home} /> : null}
        <Issue home={home} />
        {network?.short ? <NetworkCard network={network} /> : null}
        {home.offers.map((o) => (
          <OfferCard
            key={o.ref}
            order={o}
            now={now}
            canAct={home.canAct}
            receiveAt={o.side === 'BUY_USDT' ? `Your registered wallet · TRC20 ${home.registered!.wallet}` : `Your registered account · ${home.registered!.bank}`}
          />
        ))}
        {home.priceAsks.map((a) => (
          <PriceAskCard key={a.ref} ask={a} now={now} canAct={home.canAct} />
        ))}
        <MoveField home={home} now={now} calm={{ title: state.title, body: state.body }} />
        <Balances home={home} />
        <ActiveOrders orders={home.active} now={now} />
        {home.blocks.length > 0 ? <PricesCard home={home} /> : null}
        {home.reserve ? <ReserveTile home={home} /> : null}
        {home.registered ? <SettleTile home={home} network={network} /> : null}
        </div>
      </main>
    );
  }

  return (
    <>
      <main className={shell.main}>
        {home.state === 'NONE' ? <Onboarding canApply={home.canApply} reserve={home.programmeReserve} /> : null}
        {/* The way to a first order comes first, until the trader takes orders: it is the next thing to do. */}
        {showStartChecklist(home) ? <StartChecklist home={home} /> : null}
        {home.state === 'UNDER_REVIEW' || home.state === 'REJECTED' ? <ApplicationStatus home={home} /> : null}
        {/* Topping up is not admission (D-17): the reserve is there from the day of the application. */}
        {!working && home.reserve ? <ReserveCard reserve={home.reserve} /> : null}
        {!working && network ? <NetworkCard network={network} /> : null}
      </main>
      <AssistantPanel
        state={state}
        size="compact"
        meta={firstOffer ? <span className={styles.countdown}>Offer open for {formatCountdown(Math.max(0, Date.parse(firstOffer.offerExpiresAt) - now))}</span> : null}
      >
        {home.reserve ? (
          <div className={styles.navRow}>
            <Link className={shell.textAction} href="/traders/reserve">
              Security Reserve
            </Link>
          </div>
        ) : null}
      </AssistantPanel>
    </>
  );
}
