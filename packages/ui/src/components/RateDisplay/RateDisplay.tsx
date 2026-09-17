import type { Rate, RateKind } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatRate } from '../../format/money.ts';
import styles from './RateDisplay.module.css';

const KIND_LABEL: Record<RateKind, string> = { CLIENT: 'Client rate', ROUTE: 'Route rate', REFERENCE: 'Reference' };

export interface RateDisplayProps<K extends RateKind> {
  rate: Rate<K>;
  /** Indicative prices must never look executable (brief "Quote states"). */
  state?: 'firm' | 'indicative';
  size?: 'sm' | 'md' | 'lg' | 'display';
  /** Label is always shown so client and route rates can never be confused (FI-01). */
  label?: string;
  unit?: boolean;
}

export function RateDisplay<K extends RateKind>({ rate, state = 'firm', size = 'md', label, unit = true }: RateDisplayProps<K>) {
  return (
    <span className={cx(styles.root, styles[size], styles[state], styles[rate.kind.toLowerCase()])}>
      <span className={styles.label}>
        {label ?? KIND_LABEL[rate.kind]}
        {state === 'indicative' ? <span className={styles.tag}>Indicative · not executable</span> : null}
      </span>
      <span className={cx(styles.value, 'ix-num')}>
        {formatRate(rate)}
        {unit ? <span className={styles.unit}> / USDT</span> : null}
      </span>
    </span>
  );
}
