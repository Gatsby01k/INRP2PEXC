'use client';

import { BOARD } from '../../../../content/site.ts';
import { Led } from '../led/Led.tsx';
import { marketMid, useMarket } from '../market.ts';
import styles from './board.module.css';

/**
 * The board under the hero: the robot's LEDs on a strip of its black glass, running the market's rate and what every
 * deal here does, as an exchange's board runs prices. The rate leads once it is read (market.ts) — the market's, never a
 * price of ours — with the day's direction beside it; the words are BOARD's, and are on the page as text too.
 */
export function Board() {
  const market = useMarket();
  const mid = marketMid(market);
  const trail = market?.trail ?? [];
  const rose = trail.length > 1 ? Number(trail.at(-1)) >= Number(trail[0]) : true;
  const rate = mid !== null ? `USDT/INR ₹${mid.toFixed(2)} ${rose ? '▲' : '▼'}` : null;
  const text = [...(rate ? [rate] : []), ...BOARD.lines].join('   ·   ');
  return (
    <div className={styles.board}>
      <span className={styles.tag} aria-hidden="true">
        <i />
        {BOARD.tag}
      </span>
      <Led text={text} mode="marquee" pitch={5} rows={11} speed={22} className={styles.led} />
      <p className="ix-visually-hidden">{BOARD.lines.join('. ')}</p>
    </div>
  );
}
