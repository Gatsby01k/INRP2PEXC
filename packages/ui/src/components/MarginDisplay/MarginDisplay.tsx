'use client';

import type { Money } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatInr } from '../../format/money.ts';
import styles from './MarginDisplay.module.css';

export interface MarginDisplayProps {
  amount: Money<'INR'>;
  /** Realized and expected margin are never presented as the same thing (FI P&L). */
  kind: 'realized' | 'expected';
  label?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function MarginDisplay({ amount, kind, label = 'Gross margin', size = 'md' }: MarginDisplayProps) {
  const negative = amount.isNegative();
  return (
    <span className={cx(styles.root, styles[size], styles[kind], negative && styles.negative)}>
      <span className={styles.label}>
        {label}
        <span className={styles.kind}>{kind === 'realized' ? 'Realized' : 'Expected'}</span>
      </span>
      <span className={cx(styles.value, 'ix-num')}>
        {formatInr(amount, { sign: 'always' })}
        {negative ? <span className={styles.flag}> negative</span> : null}
      </span>
    </span>
  );
}
