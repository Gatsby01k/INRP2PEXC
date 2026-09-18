'use client';

import type { ClientRate, Direction, Money } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatInr, formatRate, formatUsdtHeadline } from '../../format/money.ts';
import { formatIstTime } from '../../format/time.ts';
import styles from './TradeHeader.module.css';

interface Common {
  tradeRef: string;
  direction: Direction;
  base: Money<'USDT'>;
  inr: Money<'INR'>;
  rate: ClientRate;
  startedAt: Date;
}

/** Client audience has no client/route/margin fields; operator audience adds the counterparty name only. */
export type TradeHeaderProps = (Common & { audience: 'client' }) | (Common & { audience: 'operator'; clientName: string });

export function TradeHeader(props: TradeHeaderProps) {
  const sell = props.direction === 'SELL_USDT';
  const usdt = formatUsdtHeadline(props.base);
  const inr = `${formatInr(props.inr)} INR`;
  return (
    <header className={cx(styles.root, styles[props.audience])}>
      <p className={styles.meta}>
        <span className="ix-num">{props.tradeRef}</span>
        {props.audience === 'operator' ? <span> · {props.clientName}</span> : null}
        <span> · Started {formatIstTime(props.startedAt)}</span>
      </p>
      <h1 className={cx(styles.amounts, 'ix-num')}>
        <span>{sell ? usdt : inr}</span>
        <span aria-label="to" className={styles.arrow}>→</span>
        <span>{sell ? inr : usdt}</span>
      </h1>
      <p className={styles.rate}>
        at <span className="ix-num">{formatRate(props.rate)}</span>
      </p>
    </header>
  );
}
