import type { Money } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatInr, formatUsdtHeadline } from '../../format/money.ts';
import styles from './RoutePositionRow.module.css';

export interface ObligationSide {
  total: Money;
  allocated: Money;
  /** e.g. "₹10,200,000 direct to client" */
  note?: string;
}

export interface RoutePositionRowProps {
  /** Operator-only (requires route_positions:view). */
  audience: 'operator';
  tradeRef: string;
  routeName: string;
  executionMode: 'DIRECT_TO_CLIENT' | 'TO_EXCHANGE';
  status: 'OPEN' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'CANCELLED';
  routeDelivers: ObligationSide;
  exchangeDelivers: ObligationSide;
}

const fmt = (m: Money) => (m.currency === 'INR' ? formatInr(m as Money<'INR'>) : formatUsdtHeadline(m as Money<'USDT'>));

function Side({ title, side }: { title: string; side: ObligationSide }) {
  const remaining = side.total.sub(side.allocated as never);
  return (
    <div className={styles.side}>
      <span className={styles.sideTitle}>{title}</span>
      <dl className={styles.nums}>
        <div>
          <dt>Total</dt>
          <dd className="ix-num">{fmt(side.total)}</dd>
        </div>
        <div>
          <dt>Allocated</dt>
          <dd className="ix-num">{fmt(side.allocated)}</dd>
        </div>
        <div className={cx(styles.remaining, remaining.isZero() && styles.zero)}>
          <dt>Remaining</dt>
          <dd className="ix-num">{fmt(remaining)}</dd>
        </div>
      </dl>
      {side.note ? <span className={styles.note}>{side.note}</span> : null}
    </div>
  );
}

const STATUS: Record<RoutePositionRowProps['status'], string> = { OPEN: 'Open', PARTIALLY_SETTLED: 'Partially settled', SETTLED: 'Settled', CANCELLED: 'Cancelled' };

export function RoutePositionRow(props: RoutePositionRowProps) {
  return (
    <article className={cx(styles.root, styles[props.status.toLowerCase()])} aria-label={`Route obligation for ${props.tradeRef}`}>
      <header className={styles.head}>
        <span className="ix-num">{props.tradeRef}</span>
        <span className={styles.route}>
          {props.routeName} · {props.executionMode === 'DIRECT_TO_CLIENT' ? 'Direct to client' : 'To exchange'}
        </span>
        <span className={styles.status}>{STATUS[props.status]}</span>
      </header>
      <div className={styles.sides}>
        <Side title="Route delivers" side={props.routeDelivers} />
        <Side title="Exchange delivers" side={props.exchangeDelivers} />
      </div>
    </article>
  );
}
