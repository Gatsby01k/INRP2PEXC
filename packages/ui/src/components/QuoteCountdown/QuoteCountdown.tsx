'use client';

import { cx } from '../../cx.ts';
import { formatCountdown } from '../../format/time.ts';
import { useNow } from '../../hooks/useNow.ts';
import styles from './QuoteCountdown.module.css';

export const EXPIRING_THRESHOLD_MS = 15_000;

export interface QuoteCountdownProps {
  expiresAt: Date;
  /** Full validity window, used to draw the arc fraction. */
  validityMs: number;
  /** Fixed clock for stories/tests; omit to tick. The server always decides expiry. */
  now?: Date;
  size?: 'sm' | 'md';
  label?: string;
}

/**
 * Single thin arc that empties as time runs out. At ≤ 15 s the emphasis shifts to the warning
 * tone — no flashing. With reduced motion the arc is hidden and only the text countdown remains.
 */
export function QuoteCountdown({ expiresAt, validityMs, now, size = 'md', label = 'Quote locked' }: QuoteCountdownProps) {
  const current = useNow(now);
  const remaining = Math.max(0, expiresAt.getTime() - current.getTime());
  const fraction = validityMs > 0 ? Math.min(1, remaining / validityMs) : 0;
  const expiring = remaining > 0 && remaining <= EXPIRING_THRESHOLD_MS;
  const expired = remaining === 0;
  const r = 20;
  const c = 2 * Math.PI * r;
  const text = formatCountdown(remaining);
  return (
    <span className={cx(styles.root, styles[size], expiring && styles.expiring, expired && styles.expired)} data-state={expired ? 'expired' : expiring ? 'expiring' : 'locked'}>
      <svg viewBox="0 0 48 48" className={styles.svg} aria-hidden="true" focusable="false">
        <circle cx="24" cy="24" r={r} className={styles.track} />
        <circle cx="24" cy="24" r={r} className={styles.arc} strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} data-motion="countdown-arc" />
      </svg>
      <span className={styles.text}>
        <span className={styles.label}>{expired ? 'Quote expired' : label}</span>
        <span className={cx(styles.time, 'ix-num')}>
          <span aria-hidden="true">{text}</span>
          <span className="ix-visually-hidden">{expired ? 'expired' : `${text} remaining`}</span>
        </span>
      </span>
    </span>
  );
}
