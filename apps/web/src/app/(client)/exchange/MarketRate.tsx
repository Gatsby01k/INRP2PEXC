'use client';

import { useEffect, useRef, useState } from 'react';
import { Rate } from '@inrp2p/kernel';
import { formatRate } from '@inrp2p/ui/format';
import { MARKET_RATE_PATH } from '../../../server/surface.ts';
import { StateRing } from '../_workspace/StateRing.tsx';
import styles from './stage.module.css';

/** How often the rate is asked for again while the page is looked at; the edge keeps it for a minute. */
const POLL_MS = 60_000;

type Side = 'SELL_USDT' | 'BUY_USDT';
type Rates = Record<Side, string | null>;

const shown = (rate: string | null): string | null => {
  if (!rate) return null;
  try {
    return formatRate(Rate.parse(rate, 'REFERENCE'));
  } catch {
    return null;
  }
};

/**
 * The market's USDT/INR rate (ADR 0025's reference, the same the home page's converter estimates with), beside the
 * Exchange's heading: what selling and buying is going at now, before the desk gives its firm price. Read after the
 * page has drawn and then once a minute while it is looked at, so the page itself waits for nothing; a rate the
 * pricing policy no longer trusts is not given, and then nothing is drawn. A figure that moved arrives from the side it
 * moved to, in the buy or sell colour, once.
 */
export function MarketRate() {
  const [rates, setRates] = useState<Rates | null>(null);
  const last = useRef<Rates | null>(null);
  const [moved, setMoved] = useState<Record<Side, 'up' | 'down' | null>>({ SELL_USDT: null, BUY_USDT: null });

  useEffect(() => {
    let alive = true;
    const read = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(MARKET_RATE_PATH, { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const next = (await res.json()) as Rates;
        if (!alive) return;
        const before = last.current;
        const dir = (side: Side) => {
          const a = before?.[side];
          const b = next[side];
          if (!a || !b || a === b) return null;
          return Number(b) > Number(a) ? 'up' : 'down';
        };
        setMoved({ SELL_USDT: dir('SELL_USDT'), BUY_USDT: dir('BUY_USDT') });
        last.current = next;
        setRates(next);
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

  const sell = shown(rates?.SELL_USDT ?? null);
  const buy = shown(rates?.BUY_USDT ?? null);
  if (!sell && !buy) return null;
  return (
    <p className={styles.market} title="The market’s rate now. Your firm price comes from the desk.">
      <StateRing state="live" className={styles.marketRing} />
      <span className={styles.marketLabel}>USDT/INR market</span>
      {sell ? (
        <span className={styles.marketSide}>
          <span className={styles.marketWord}>Sell</span>
          <b key={sell} className={styles.marketFigure} data-moved={moved.SELL_USDT ?? undefined}>
            {sell}
          </b>
        </span>
      ) : null}
      {buy ? (
        <span className={styles.marketSide}>
          <span className={styles.marketWord}>Buy</span>
          <b key={buy} className={styles.marketFigure} data-moved={moved.BUY_USDT ?? undefined}>
            {buy}
          </b>
        </span>
      ) : null}
    </p>
  );
}
