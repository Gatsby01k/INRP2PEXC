import styles from './success.module.css';

const R = 30;
const C = 2 * Math.PI * R;
const SEG = C / 3;
const GAP = 7;

/**
 * Something just came right: the mark's three arcs close one after another around a tick — the brand's own
 * motif finishing, rather than a generic confetti. Decorative; the words beside it say what happened.
 */
export function SuccessMark({ size = 88 }: { size?: number }) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 80 80" aria-hidden="true" focusable="false">
      <circle className={styles.halo} cx="40" cy="40" r="38" />
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          className={styles.arc}
          style={{ animationDelay: `${120 + i * 140}ms` }}
          cx="40"
          cy="40"
          r={R}
          strokeDasharray={`${SEG - GAP} ${C - SEG + GAP}`}
          strokeDashoffset={-(i * SEG) + C / 4}
        />
      ))}
      <path className={styles.tick} d="M28.5 41l7.5 7.5L52 32.5" />
    </svg>
  );
}
