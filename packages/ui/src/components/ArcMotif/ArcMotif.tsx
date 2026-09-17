import { cx } from '../../cx.ts';
import styles from './ArcMotif.module.css';

export type ArcStage = 0 | 1 | 2 | 3;

/**
 * The three structural arcs of the INRP2P mark used as a quiet progress motif
 * (quote · transfer · settlement). Decorative: callers always provide text.
 */
export function ArcMotif({ completed, size = 20, tone = 'brand', className }: { completed: ArcStage; size?: number; tone?: 'brand' | 'success' | 'muted'; className?: string }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  const seg = c / 3;
  const gap = 2.2;
  return (
    <svg className={cx(styles.root, styles[tone], className)} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx="10"
          cy="10"
          r={r}
          className={i < completed ? styles.on : styles.off}
          strokeDasharray={`${seg - gap} ${c - seg + gap}`}
          strokeDashoffset={-(i * seg) + c / 4}
        />
      ))}
    </svg>
  );
}
