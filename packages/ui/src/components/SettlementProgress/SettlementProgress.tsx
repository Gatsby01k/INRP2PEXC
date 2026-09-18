'use client';

import type { Money } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatInr, formatInrCompact } from '../../format/money.ts';
import { percentString } from '../../format/number.ts';
import styles from './SettlementProgress.module.css';

export interface SettlementProgressProps {
  /** Confirmed legs only. */
  received: Money<'INR'>;
  total: Money<'INR'>;
  /** Legs sent but not yet confirmed (operator view). */
  inFlight?: Money<'INR'>;
  /** Compact numbers for summaries ("₹6.5M received"); exact by default. */
  compact?: boolean;
  receivedLabel?: string;
}

export function SettlementProgress({ received, total, inFlight, compact = false, receivedLabel = 'received' }: SettlementProgressProps) {
  const remaining = total.sub(received);
  const fmt = compact ? formatInrCompact : (m: Money<'INR'>) => formatInr(m);
  const pct = percentString(received.minor, total.minor);
  const flightPct = inFlight ? percentString(inFlight.minor, total.minor) : '0.00';
  return (
    <div className={styles.root}>
      <div className={styles.figures}>
        <p className={styles.received}>
          <span className={cx(styles.value, 'ix-num')}>{fmt(received)}</span> {receivedLabel}
        </p>
        <p className={styles.remaining}>
          <span className={cx(styles.value, 'ix-num')}>{fmt(remaining.isNegative() ? total.sub(total) : remaining)}</span> remaining
        </p>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={`${formatInr(received)} of ${formatInr(total)} ${receivedLabel}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number.parseInt(pct, 10)}
        aria-valuetext={`${formatInr(received)} of ${formatInr(total)}`}
      >
        <span className={styles.fill} style={{ width: `${pct}%` }} data-motion="fill" />
        {inFlight ? <span className={styles.flight} style={{ width: `${flightPct}%` }} /> : null}
      </div>
    </div>
  );
}
