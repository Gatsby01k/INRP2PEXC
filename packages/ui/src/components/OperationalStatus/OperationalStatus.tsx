'use client';

import { cx } from '../../cx.ts';
import styles from './OperationalStatus.module.css';

export type TradeLifecycleState = 'AWAITING_FIRST_LEG' | 'FIRST_LEG_DETECTED' | 'FIRST_LEG_CONFIRMED' | 'SETTLING' | 'PARTIALLY_SETTLED' | 'COMPLETED' | 'CANCELLED';

const LIFECYCLE: Record<TradeLifecycleState, string> = {
  AWAITING_FIRST_LEG: 'Awaiting client funds',
  FIRST_LEG_DETECTED: 'Funds detected',
  FIRST_LEG_CONFIRMED: 'Funds confirmed',
  SETTLING: 'Settling',
  PARTIALLY_SETTLED: 'Partially settled',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/**
 * Trade lifecycle label with the exception hold overlay (D-04): when on hold, "Exception" is the
 * primary status and the preserved lifecycle state stays visible as secondary text.
 */
export function OperationalStatus({ state, hold = false }: { state: TradeLifecycleState; hold?: boolean }) {
  const tone = hold ? 'exception' : state === 'COMPLETED' ? 'done' : state === 'CANCELLED' ? 'muted' : 'active';
  return (
    <span className={cx(styles.root, styles[tone])} data-state={state} data-hold={hold || undefined}>
      <span aria-hidden="true" className={styles.dot} />
      {hold ? (
        <>
          <span className={styles.primary}>Exception</span>
          <span className={styles.secondary}>· {LIFECYCLE[state]}</span>
        </>
      ) : (
        <span className={styles.primary}>{LIFECYCLE[state]}</span>
      )}
    </span>
  );
}
