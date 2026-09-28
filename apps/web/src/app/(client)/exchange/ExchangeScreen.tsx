'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ExchangeView } from '@inrp2p/portal';
import { AssistantPanel } from '../_assistant/AssistantPanel.tsx';
import { exchangeAssistant, quoteLive, requestSteps } from '../_assistant/model.ts';
import { PricingCard } from './PricingCard.tsx';
import { HeldFor } from './HeldFor.tsx';
import { QuoteCard } from './QuoteCard.tsx';
import { RequestForm } from './RequestForm.tsx';
import { useServerClock } from './useServerClock.ts';
import shell from '../shell.module.css';

export type Direction = 'SELL_USDT' | 'BUY_USDT';

/** A request the client started somewhere else — the home page's quote module. */
export interface RequestDraft {
  readonly direction: Direction;
  readonly amount?: string;
}

/** How often the screen looks for the desk's quote while a request is being priced. */
const PRICING_POLL_MS = 8_000;
/** How long to wait before looking again at a quote whose time is up but which the expiry job has not yet closed. */
const EXPIRY_LAG_POLL_MS = 5_000;

/**
 * One screen, four states, and the screen decides which by looking at what the desk has said — never by
 * remembering what the client last clicked. A reloaded page therefore shows the truth, which for a countdown that
 * decides whether money moves is the only acceptable behaviour.
 *
 * - a live firm quote: accept it, or decline it;
 * - a request with the desk (or a quote that just ran out): wait, or withdraw it;
 * - otherwise: ask for a price.
 *
 * The robot beside it reports the same state (`exchangeAssistant`), from the same data and the same clock.
 */
export function ExchangeScreen({ view, canAccept, serverTime, draft }: { view: ExchangeView; canAccept: boolean; serverTime: string; draft?: RequestDraft }) {
  const router = useRouter();
  const { quote, request } = view;
  const now = useServerClock(serverTime, quote?.status === 'SENT');
  const live = quote !== null && quoteLive(quote, now);
  const withDesk = request !== null && (request.status === 'OPEN' || request.status === 'QUOTED');

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
    }, PRICING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [quote, withDesk, serverTime, router]);

  return (
    <>
      <main className={`${shell.main} ${shell.centred}`}>
        {quote && live ? (
          <QuoteCard quote={quote} canAccept={canAccept} now={now} />
        ) : withDesk ? (
          <PricingCard view={view} />
        ) : (
          <RequestForm view={view} {...(draft ? { draft } : {})} />
        )}
      </main>
      <AssistantPanel
        state={exchangeAssistant(view, { canAccept, now })}
        steps={withDesk ? requestSteps(view, now) : null}
        meta={quote && live && quote.expiresAt ? <HeldFor expiresAt={new Date(quote.expiresAt)} now={now} /> : null}
      />
    </>
  );
}
