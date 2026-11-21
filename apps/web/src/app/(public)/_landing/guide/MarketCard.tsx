'use client';

import { Rate } from '@inrp2p/kernel';
import { formatRate } from '@inrp2p/ui/format';
import { GUIDES } from '../../../../content/site.ts';
import { Coin } from '../../../../components/Coin.tsx';
import { useMarket } from '../market.ts';
import styles from './guide.module.css';

/** The day's line, scaled into a 120 × 36 box. */
function line(trail: readonly string[]): string | null {
  const v = trail.map(Number).filter((n) => Number.isFinite(n));
  if (v.length < 2) return null;
  const lo = Math.min(...v);
  const span = Math.max(...v) - lo || 1;
  return v.map((n, i) => `${i === 0 ? 'M' : 'L'}${((i / (v.length - 1)) * 118 + 1).toFixed(1)} ${(32 - ((n - lo) / span) * 28).toFixed(1)}`).join('');
}

/**
 * The market's USDT/INR rate on a rate guide: both sides as a client would meet them, and the last day as a line. It is
 * the market's reference (ADR 0025), never a price of ours — the card says so. Read after the page is shown; while there
 * is no fresh reference the card is simply not drawn, so the page never shows an empty box.
 */
export function MarketCard() {
  const market = useMarket();
  if (!market) return null;
  const fmt = (v: string | null) => (v ? formatRate(Rate.parse(v, 'REFERENCE')) : null);
  const sell = fmt(market.SELL_USDT);
  const buy = fmt(market.BUY_USDT);
  const trail = market.trail ?? [];
  const d = line(trail);
  const rose = trail.length > 1 ? Number(trail.at(-1)) >= Number(trail[0]) : true;
  return (
    <div className={styles.market} data-trend={rose ? 'up' : 'down'}>
      <p className={styles.marketHead}>
        <span className={styles.pair} aria-hidden="true">
          <Coin currency="USDT" size={22} />
          <Coin currency="INR" size={12} className={styles.pairBadge} />
        </span>
        {GUIDES.rate.title}
        <i className={styles.live} aria-hidden="true" />
      </p>
      <dl className={styles.marketRows}>
        {sell ? (
          <div>
            <dt>{GUIDES.rate.sell}</dt>
            <dd>{sell}</dd>
          </div>
        ) : null}
        {buy ? (
          <div>
            <dt>{GUIDES.rate.buy}</dt>
            <dd>{buy}</dd>
          </div>
        ) : null}
      </dl>
      {d ? (
        <svg className={styles.spark} viewBox="0 0 120 36" aria-hidden="true" focusable="false">
          <path d={d} />
        </svg>
      ) : null}
      <p className={styles.marketNote}>{GUIDES.rate.note}</p>
    </div>
  );
}
