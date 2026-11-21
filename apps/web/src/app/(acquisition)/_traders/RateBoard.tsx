'use client';

import { Coin } from '../../../components/Coin.tsx';
import { TRADER_TERMS } from '../../../content/site.ts';
import type { TradersPageCopy } from '../../../content/traders.ts';
import { Led } from '../../(public)/_landing/led/Led.tsx';
import { marketMid, useMarket } from '../../(public)/_landing/market.ts';
import styles from './traders.module.css';

/** A percentage the way a trader says it: `6%`, `5.75%`. */
const pct = (n: number): string => `${Number(n.toFixed(2))}%`;

/**
 * The hero's rate board: the market's USDT/INR rate now (ADR 0025's reference, the one reading the page shares), and the
 * price a trader sells at with the programme's typical margin over it, in the robot's LEDs — what they keep of it beside
 * INRP2P's fee. Every figure is the market's rate and the programme's terms; nothing is a price of ours or anybody's
 * record. Until the rate is read, the LEDs show dashes of the same width, so nothing on the page moves when it arrives.
 */
export function RateBoard({ copy }: { copy: TradersPageCopy['hero']['board'] }) {
  const mid = marketMid(useMarket());
  const margin = TRADER_TERMS.margin.typical;
  const fee = TRADER_TERMS.feeBps / 100;
  const price = mid ? (mid * (1 + margin / 100)).toFixed(2) : null;
  const keep = margin - fee;
  return (
    <figure className={styles.board} aria-label={copy.note}>
      <div className={styles.boardHead}>
        <span className={styles.pair}>
          <Coin currency="USDT" size={20} />
          {copy.pair}
        </span>
        <span className={styles.live}>
          <span className={styles.liveDot} aria-hidden="true" />
          {copy.market} <b>{mid ? `₹${mid.toFixed(2)}` : '—'}</b>
        </span>
      </div>
      <div className={styles.boardMain}>
        <span className={styles.boardLabel}>
          {copy.yours} <b className={styles.marginChip}>+{margin}%</b>
        </span>
        <Led text={price ? `₹${price}` : '₹--.--'} pitch={7} rows={9} className={styles.boardLed} label={price ? `₹${price}` : copy.waiting} />
      </div>
      <div className={styles.boardFoot}>
        <span>
          {copy.keep} <b>{pct(keep)}</b>
        </span>
        <span>
          INRP2P <b>{pct(fee)}</b>
        </span>
      </div>
      <div className={styles.boardBar} aria-hidden="true">
        <span className={styles.boardBarYours} style={{ flexGrow: keep }} />
        <span className={styles.boardBarOurs} style={{ flexGrow: fee }} />
      </div>
      <figcaption className={styles.boardNote}>{copy.note}</figcaption>
    </figure>
  );
}
