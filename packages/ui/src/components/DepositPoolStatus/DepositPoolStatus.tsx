import { cx } from '../../cx.ts';
import { ExceptionBanner } from '../ExceptionBanner/ExceptionBanner.tsx';
import styles from './DepositPoolStatus.module.css';

export interface DepositPoolStatusProps {
  capability: 'DERIVED' | 'POOL' | 'UNSUPPORTED';
  provider: string;
  available: number;
  assigned: number;
  cooldown: number;
  lowThreshold: number;
}

/** Custody capability and address counts (D-02). UNSUPPORTED disables SELL acceptance — shown as a blocking fact. */
export function DepositPoolStatus({ capability, provider, available, assigned, cooldown, lowThreshold }: DepositPoolStatusProps) {
  if (capability === 'UNSUPPORTED') {
    return (
      <ExceptionBanner
        severity="blocking"
        title="Unique deposit addresses are not supported by the custody provider"
        description={`${provider} cannot derive or pool TRC20 receive addresses. SELL USDT acceptance is disabled; there is no fallback attribution.`}
      />
    );
  }
  const low = capability === 'POOL' && available < lowThreshold;
  return (
    <section className={cx(styles.root, low && styles.low)} aria-label="Deposit addresses">
      <header className={styles.head}>
        <h3 className={styles.title}>Deposit addresses · TRC20</h3>
        <span className={styles.capability}>
          {provider} · {capability === 'DERIVED' ? 'Derived per trade' : 'Provider pool'}
        </span>
      </header>
      <dl className={styles.counts}>
        {capability === 'POOL' ? (
          <div>
            <dt>Available</dt>
            <dd className="ix-num">{available}</dd>
          </div>
        ) : null}
        <div>
          <dt>Assigned to open trades</dt>
          <dd className="ix-num">{assigned}</dd>
        </div>
        <div>
          <dt>Cooldown</dt>
          <dd className="ix-num">{cooldown}</dd>
        </div>
      </dl>
      {low ? <p className={styles.warning}>Pool low: fewer than {lowThreshold} addresses available. Replenish in the custody provider.</p> : null}
    </section>
  );
}
