'use client';

import { useEffect, useState } from 'react';
import { MARKET_RATE_PATH } from '../../../server/surface.ts';

/** How often the rate is asked for again while the page is looked at; the edge keeps it for a minute. */
const POLL_MS = 60_000;

/** The market's USDT/INR reference as `/api/market-rate` gives it (ADR 0025), with the last day's line. */
export interface Market {
  readonly SELL_USDT: string | null;
  readonly BUY_USDT: string | null;
  readonly trail?: readonly string[];
}

/**
 * The market's rate on a page that wants it: read after the page has drawn, again once a minute while it is looked at
 * and when it comes back into view. Null until the first answer, and while the reference is too old to show.
 */
export function useMarket(): Market | null {
  const [market, setMarket] = useState<Market | null>(null);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(MARKET_RATE_PATH, { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const next = (await res.json()) as Market;
        if (alive) setMarket(next.SELL_USDT || next.BUY_USDT ? next : null);
      } catch {
        // A missed read keeps what is shown; the next one tries again.
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), POLL_MS);
    document.addEventListener('visibilitychange', read);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, []);
  return market;
}

/** The market's mid — the two directions averaged — or the one there is. */
export function marketMid(m: Market | null): number | null {
  if (!m) return null;
  const s = m.SELL_USDT ? Number(m.SELL_USDT) : null;
  const b = m.BUY_USDT ? Number(m.BUY_USDT) : null;
  return s !== null && b !== null ? (s + b) / 2 : (s ?? b);
}
