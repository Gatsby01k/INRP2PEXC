import type { Money } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatInr, formatInrCompact } from '../../format/money.ts';
import { percentString } from '../../format/number.ts';
import styles from './CapacityMeter.module.css';

export interface CapacityMeterProps {
  accountLabel: string;
  capacity: Money<'INR'>;
  used: Money<'INR'>;
  reserved: Money<'INR'>;
  status: 'ACTIVE' | 'PAUSED' | 'UNAVAILABLE';
  /** Exact figures in panels; compact in overview grids. */
  compact?: boolean;
}

/** Operational capacity in one glance: restrained bar, no chart. Available is derived, may be negative after an audited reduction. */
export function CapacityMeter({ accountLabel, capacity, used, reserved, status, compact = true }: CapacityMeterProps) {
  const available = capacity.sub(used).sub(reserved);
  const fmt = compact ? formatInrCompact : (m: Money<'INR'>) => formatInr(m);
  const over = available.isNegative();
  return (
    <section className={cx(styles.root, styles[status.toLowerCase()], over && styles.over)} aria-label={`${accountLabel} capacity`}>
      <header className={styles.head}>
        <h3 className={styles.title}>{accountLabel}</h3>
        <span className={styles.status}>{status}</span>
      </header>
      <div className={styles.bar} aria-hidden="true">
        <span className={styles.used} style={{ width: `${percentString(used.minor, capacity.minor)}%` }} />
        <span className={styles.reserved} style={{ width: `${percentString(reserved.minor, capacity.minor)}%` }} />
      </div>
      <dl className={styles.figures}>
        <div>
          <dt>Working capacity</dt>
          <dd className="ix-num">{fmt(capacity)}</dd>
        </div>
        <div>
          <dt>
            <span className={cx(styles.key, styles.keyUsed)} aria-hidden="true" />
            Used
          </dt>
          <dd className="ix-num">{fmt(used)}</dd>
        </div>
        <div>
          <dt>
            <span className={cx(styles.key, styles.keyReserved)} aria-hidden="true" />
            Reserved
          </dt>
          <dd className="ix-num">{fmt(reserved)}</dd>
        </div>
        <div className={styles.available}>
          <dt>Available</dt>
          <dd className="ix-num">
            {fmt(available)}
            {over ? <span className={styles.overText}> over committed</span> : null}
          </dd>
        </div>
      </dl>
    </section>
  );
}
