'use client';

import { Rate, type ClientRate, type RouteRate, type TradeEconomics } from '@inrp2p/kernel';
import { formatInr, formatRate, formatUsdtHeadline } from '../../format/money.ts';
import { MarginDisplay } from '../MarginDisplay/MarginDisplay.tsx';
import styles from './RateComparison.module.css';

export interface RateComparisonProps {
  /** Operator-only: route rate and margin are never rendered on client surfaces. */
  audience: 'operator';
  clientRate: ClientRate;
  routeRate: RouteRate;
  /** System-computed economics (kernel `computeTradeEconomics`); margin is never typed. */
  economics: TradeEconomics;
}

export function RateComparison({ clientRate, routeRate, economics }: RateComparisonProps) {
  const diff = routeRate.micro > clientRate.micro ? routeRate.micro - clientRate.micro : clientRate.micro - routeRate.micro;
  return (
    <div className={styles.wrap}>
    <dl className={styles.grid}>
      <div className={styles.item}>
        <dt>Client</dt>
        <dd className="ix-num">{formatRate(clientRate)}</dd>
      </div>
      <div className={styles.item} data-kind="route">
        <dt>Route</dt>
        <dd className="ix-num">{formatRate(routeRate)}</dd>
      </div>
      <div className={styles.item}>
        <dt>Spread</dt>
        <dd className="ix-num">{diff === 0n ? '₹0.00' : formatRate(Rate.ofMicro(diff, 'REFERENCE'))}</dd>
      </div>
      <div className={styles.item}>
        <dt>Volume</dt>
        <dd className="ix-num">{formatUsdtHeadline(economics.base)}</dd>
      </div>
      <div className={styles.item}>
        <dt>Client {economics.direction === 'SELL_USDT' ? 'receives' : 'pays'}</dt>
        <dd className="ix-num">{formatInr(economics.clientInr)}</dd>
      </div>
    </dl>
      <div className={styles.margin}>
        <MarginDisplay amount={economics.grossMargin} kind="expected" label="Gross margin" size="lg" />
      </div>
    </div>
  );
}

