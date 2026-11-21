'use client';

import { useEffect, useRef, useState } from 'react';
import { Rate } from '@inrp2p/kernel';
import { formatRate } from '@inrp2p/ui/format';
import { Coin } from '../../../components/Coin.tsx';
import { Led } from './led/Led.tsx';
import { marketMid, useMarket } from './market.ts';
import styles from './ticker.module.css';

/** The day's line, scaled into a 48 × 18 box with a point of air above and below. */
function line(trail: readonly string[]): string | null {
  const v = trail.map(Number).filter((n) => Number.isFinite(n));
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || 1;
  return v.map((n, i) => `${i === 0 ? 'M' : 'L'}${((i / (v.length - 1)) * 46 + 1).toFixed(1)} ${(16 - ((n - lo) / span) * 14).toFixed(1)}`).join('');
}

/**
 * The market's USDT/INR rate in the masthead, on a piece of the robot's black glass in its LEDs: the pair, the rate now
 * with a live node, and the last day as a line — green when the day rose, red when it fell. It is the market's rate
 * (ADR 0025's reference), never a price of ours; a firm price comes from a quote. Read after the page is shown, so the
 * page waits for nothing; while there is no fresh reference nothing is drawn, and the masthead closes up around it.
 */
export function Ticker() {
  const market = useMarket();
  const [moved, setMoved] = useState<'up' | 'down' | null>(null);
  const last = useRef<number | null>(null);
  const mid = marketMid(market);

  useEffect(() => {
    if (mid === null) return;
    if (last.current !== null && mid !== last.current) setMoved(mid > last.current ? 'up' : 'down');
    last.current = mid;
  }, [mid]);

  if (mid === null) return null;
  const shown = formatRate(Rate.parse(mid.toFixed(6), 'REFERENCE'));
  const trail = market?.trail ?? [];
  const d = line(trail);
  const rose = trail.length > 1 ? Number(trail.at(-1)) >= Number(trail[0]) : true;
  return (
    <span className={styles.ticker} title="USDT/INR market rate now, and its last day. Your firm price comes with your quote." data-trend={rose ? 'up' : 'down'}>
      <span className={styles.pair} aria-hidden="true">
        <Coin currency="USDT" size={24} />
        <Coin currency="INR" size={13} className={styles.badge} />
      </span>
      <span className={styles.label} aria-hidden="true">
        USDT/INR
      </span>
      <span key={shown} className={styles.figure} data-moved={moved ?? undefined}>
        <Led text={shown} fit pitch={3} rows={9} label={`USDT/INR market rate ${shown}`} />
      </span>
      {d ? (
        <svg className={styles.spark} viewBox="0 0 48 18" aria-hidden="true" focusable="false">
          <path d={d} />
        </svg>
      ) : null}
      <span className={styles.live} aria-hidden="true" />
    </span>
  );
}
