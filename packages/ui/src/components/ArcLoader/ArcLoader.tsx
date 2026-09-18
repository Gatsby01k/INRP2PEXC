'use client';

import { cx } from '../../cx.ts';
import styles from './ArcLoader.module.css';

/** One moving brand arc instead of a generic spinner. With reduced motion it is a static arc. */
export function ArcLoader({ size = 'md', label = 'Loading', tone = 'brand' }: { size?: 'sm' | 'md' | 'lg'; label?: string; tone?: 'brand' | 'inherit' }) {
  return (
    <span role="status" className={cx(styles.root, styles[size], styles[tone])}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.svg} data-motion="spin">
        <circle cx="12" cy="12" r="9" className={styles.track} />
        <circle cx="12" cy="12" r="9" className={styles.arc} strokeDasharray="18.85 37.7" />
      </svg>
      <span className="ix-visually-hidden">{label}</span>
    </span>
  );
}
