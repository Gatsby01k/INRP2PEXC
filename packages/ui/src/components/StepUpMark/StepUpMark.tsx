'use client';

import { cx } from '../../cx.ts';
import styles from './StepUpMark.module.css';

/**
 * The step-up marker — the hourglass the desk puts on an action that will ask for an authenticator code
 * (SECURITY §2.1). Drawn as SVG in `currentColor`, not written as `⧗` (U+29D7): that character is not in Geist,
 * and a font fallback renders it differently on every machine (VISUAL_BASELINES §4).
 *
 * Decorative by default — the action's own label says what it does. `label` gives it a name where it appears
 * without one.
 */
export function StepUpMark({ label, className }: { label?: string; className?: string }) {
  return (
    <svg
      className={cx(styles.root, className)}
      viewBox="0 0 12 12"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
      focusable="false"
    >
      <path d="M3 1.4h6M3 10.6h6M3.6 1.4v1.7L6 6 3.6 8.9v1.7M8.4 1.4v1.7L6 6l2.4 2.9v1.7" className={styles.stroke} />
    </svg>
  );
}
