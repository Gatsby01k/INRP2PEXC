'use client';

import { useEffect, useRef, useState } from 'react';
import { Rate } from '@inrp2p/kernel';
import { formatRate } from '@inrp2p/ui/format';
import { MARKET_RATE_PATH } from '../../../server/surface.ts';
import { PairCoin } from './PairCoin.tsx';
import styles from './ticker.module.css';

/** How often the rate is asked for again while the page is looked at; the edge keeps it for a minute. */
const POLL_MS = 60_000;

interface Market {
  readonly SELL_USDT: string | null;
  readonly BUY_USDT: string | null;
  readonly trail?: readonly string[];
}

/** The market's mid — the two directions averaged — or the one there is. */
const midOf = (m: Market): number | null => {
  const s = m.SELL_USDT ? Number(m.SELL_USDT) : null;
  const b = m.BUY_USDT ? Number(m.BUY_USDT) : null;
  return s !== null && b !== null ? (s + b) / 2 : (s ?? b);
};

/** The day's line, scaled into a 44 × 18 box with a point of air above and below. */
function line(trail: readonly string[]): string | null {
  const v = trail.map(Number).filter((n) => Number.isFinite(n));
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || 1;
  return v.map((n, i) => `${i === 0 ? 'M' : 'L'}${((i / (v.length - 1)) * 42 + 1).toFixed(1)} ${(16 - ((n - lo) / span) * 14).toFixed(1)}`).join('');
}

/**
 * The market's USDT/INR rate in the bar, on every page (mock-up v3): the pair, the rate now, and the last day as a
 * line — green when the day rose, red when it fell. It is the market's rate (ADR 0025's reference), not a price; a
 * firm price still comes from the desk. Read after the page has drawn, so the page waits for nothing; while the
 * reference is too old to price on, nothing is drawn. A new figure arrives from the side it moved to, once.
 */
export function Ticker() {
  const [market, setMarket] = useState<Market | null>(null);
  const [moved, setMoved] = useState<'up' | 'down' | null>(null);
  const last = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(MARKET_RATE_PATH, { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const next = (await res.json()) as Market;
        if (!alive) return;
        const mid = midOf(next);
        if (mid !== null && last.current !== null && mid !== last.current) setMoved(mid > last.current ? 'up' : 'down');
        last.current = mid;
        setMarket(next);
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

  const mid = market ? midOf(market) : null;
  if (mid === null) return null;
  const shown = formatRate(Rate.parse(mid.toFixed(6), 'REFERENCE'));
  const trail = market?.trail ?? [];
  const d = line(trail);
  const rose = trail.length > 1 ? Number(trail.at(-1)) >= Number(trail[0]) : true;
  return (
    <span className={styles.ticker} title="USDT/INR market rate now, and its last 24 hours. Your firm price comes from the desk." data-trend={rose ? 'up' : 'down'}>
      <PairCoin side="SELL_USDT" size={24} />
      <b key={shown} className={styles.figure} data-moved={moved ?? undefined}>
        <span className="ix-visually-hidden">USDT/INR market </span>
        {shown}
      </b>
      {d ? (
        <svg className={styles.spark} viewBox="0 0 44 18" aria-hidden="true" focusable="false">
          <path d={d} />
        </svg>
      ) : null}
    </span>
  );
}
