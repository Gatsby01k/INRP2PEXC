'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ExchangeView, HistoryRow } from '@inrp2p/portal';
import { useAssistantState } from '../_assistant/AssistantPanel.tsx';
import { exchangeAssistant, quoteLive, requestSteps } from '../_assistant/model.ts';
import { DealRail } from '../_workspace/DealRail.tsx';
import { legAmount } from './amounts.ts';
import { StateRing } from '../_workspace/StateRing.tsx';
import { Activity } from './ExchangeAside.tsx';
import { StagePanel } from './StagePanel.tsx';
import { LiveMarket } from './LiveMarket.tsx';
import { PricingCard } from './PricingCard.tsx';
import { QuoteCard } from './QuoteCard.tsx';
import { RequestForm, type Who } from './RequestForm.tsx';
import { SetupGuide } from './SetupGuide.tsx';
import { useServerClock } from './useServerClock.ts';
import { WaitingCard, type WaitingAlerts } from './WaitingCard.tsx';
import shell from '../shell.module.css';
import stage from './stage.module.css';

export type Direction = 'SELL_USDT' | 'BUY_USDT';

/** A request the client started somewhere else — the home page's quote module. */
export interface RequestDraft {
  readonly direction: Direction;
  readonly amount?: string;
  /** ADR 0033 "Keep looking": the same terms again — which currency was fixed, and the client's own price. */
  readonly fixedSide?: 'BASE' | 'QUOTE';
  readonly targetRate?: string;
}

/** What the page does, as the stage shows it before there is a request. */
const HOW = [
  { label: 'Ask for a price', status: 'current' },
  { label: 'Accept a firm quote', status: 'pending' },
  { label: 'Settle and get paid', status: 'pending' },
] as const;

/** How often the screen looks for the desk's quote while a request is being priced. */
const PRICING_POLL_MS = 8_000;
/** ADR 0032: while a request waits for a trader the exchange looks every minute, and the client is messaged: no need to ask more. */
const WAITING_POLL_MS = 30_000;
/** How long to wait before looking again at a quote whose time is up but which the expiry job has not yet closed. */
const EXPIRY_LAG_POLL_MS = 5_000;

/**
 * One screen, four states, and the screen decides which by looking at what the desk has said — never by
 * remembering what the client last clicked. A reloaded page therefore shows the truth, which for a countdown that
 * decides whether money moves is the only acceptable behaviour.
 *
 * - a live firm quote: accept it, or decline it;
 * - a request with the desk (or a quote that just ran out): wait, or withdraw it;
 * - otherwise: ask for a price — after, for a new client, the two steps that make that possible.
 *
 * Every state has the same shape — the request on its sheet, and beside it the stage the robot stands on — so the
 * page does not rearrange itself as the deal moves. The state is also what the robot rests in and what may make a
 * sound (`useAssistantState`), from the same data and the same clock.
 */
export function ExchangeScreen({
  view,
  canAccept,
  serverTime,
  draft,
  who,
  recent,
  alerts,
}: {
  view: ExchangeView;
  /** ADR 0032: where a waiting client hears of its price; read only while it waits. */
  alerts?: WaitingAlerts | undefined;
  canAccept: boolean;
  serverTime: string;
  draft?: RequestDraft;
  who: Who;
  recent: readonly HistoryRow[];
}) {
  const router = useRouter();
  const { quote, request } = view;
  const withDesk = request !== null && (request.status === 'OPEN' || request.status === 'QUOTED');
  const waiting = withDesk && request.waitingUntil !== null;
  // The clock runs for a countdown, and for a wait — its time is on the stage.
  const now = useServerClock(serverTime, quote?.status === 'SENT' || waiting);
  const live = quote !== null && quoteLive(quote, now);
  const firstRun = !withDesk && view.destinations.banks.length === 0 && view.destinations.wallets.filter((w) => w.purpose !== 'SOURCE').length === 0;
  useAssistantState(exchangeAssistant(view, { canAccept, now }));

  // The page has to notice what changes on the desk's side. A live quote runs out on its own: look again the
  // moment it does, so the accept button stops at the instant the server stops honouring it. A quote whose time is
  // up but which the expiry job has not closed yet is looked at again every few seconds — not in a loop. And while
  // the desk prices a request, the page checks for its quote, so it appears here without a reload.
  useEffect(() => {
    if (quote?.status === 'SENT' && quote.expiresAt) {
      const ms = Date.parse(quote.expiresAt) - Date.parse(serverTime);
      const timer = window.setTimeout(() => router.refresh(), ms > 0 ? ms + 500 : EXPIRY_LAG_POLL_MS);
      return () => window.clearTimeout(timer);
    }
    if (!withDesk) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, waiting ? WAITING_POLL_MS : PRICING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [quote, withDesk, waiting, serverTime, router]);

  return (
    <>
      <main className={shell.main}>
        {firstRun ? <SetupGuide who={who} /> : null}
        {quote && live ? (
          <>
            <QuoteCard quote={quote} canAccept={canAccept} now={now} request={view.request} destinations={view.destinations} />
            {/* What accepting starts, as the same picture the trade then carries to its receipt. */}
            <section className={`${shell.card} ${stage.ahead}`} aria-labelledby="ahead-title">
              <div className={shell.cardHead}>
                <h2 id="ahead-title" className={`${shell.cardTitle} ${stage.aheadTitle}`}>
                  <span className={shell.kbd}>01</span>
                  Accept, and the trade opens at this rate
                </h2>
                <span className={shell.idx}>The same picture follows the deal to its receipt</span>
              </div>
              <DealRail
                viewer={quote.direction === 'SELL_USDT' ? 'seller' : 'buyer'}
                step="AHEAD"
                usdt={`${legAmount(quote.base.amount, 'USDT')} USDT`}
                inr={`₹${legAmount(quote.inr.amount, 'INR')}`}
                destination={quote.destination.replace(' Bank', '')}
                label="After you accept: the USDT goes into INRP2P’s escrow, the rupees are paid bank to bank, and the escrow releases once they are confirmed."
              />
              <ol className={stage.aheadSteps}>
                <li>The rate and amounts are fixed from that moment.</li>
                <li>The USDT goes into INRP2P’s escrow — to an address that belongs to this trade alone.</li>
                <li>The rupees are paid bank to bank, with their reference.</li>
                <li>Once they are confirmed the escrow releases, and a receipt is issued.</li>
              </ol>
            </section>
            {recent.length > 0 ? <Activity recent={recent} /> : null}
          </>
        ) : withDesk && request.waitingUntil ? (
          <>
            <WaitingCard view={view} alerts={alerts ?? { telegram: { on: false, username: null }, email: null }} now={now} />
            {recent.length > 0 ? <Activity recent={recent} /> : null}
          </>
        ) : withDesk ? (
          <>
            <PricingCard view={view} steps={requestSteps(view, now) ?? undefined} />
            {recent.length > 0 ? <Activity recent={recent} /> : null}
          </>
        ) : (
          <>
            <div className={stage.deal} data-even="">
              <RequestForm view={view} who={who} {...(draft ? { draft } : {})} />
              <StagePanel
                mini={<LiveMarket />}
                mood="ready"
                chip={
                  <>
                    <StateRing state="live" />
                    <span>Ready for your request</span>
                  </>
                }
                title="One firm price for the whole amount"
                body="Ask for a price in either currency. It is held for a short time, and nothing is committed until you accept."
                steps={HOW}
              />
            </div>
            {recent.length > 0 ? <Activity recent={recent} /> : null}
          </>
        )}
      </main>
    </>
  );
}
