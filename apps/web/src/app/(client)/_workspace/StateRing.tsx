import styles from './state-ring.module.css';

/**
 * What a deal is doing, as one family of rings — the mark's ring, alive only while something is really happening:
 *
 * - `turn`: a pulse — it is waiting for you;
 * - `wait`: a node travelling a dotted orbit — it is waiting for the other side;
 * - `check`: an arc sweeping — someone is checking;
 * - `lock`: a closed disc with a lock — held in escrow, nothing moves;
 * - `done`: the disc closes and its tick is drawn, once;
 * - `hold`, `off`: still — paused, or over;
 * - `live`: breathing — a desk or a price that is on.
 *
 * Decorative: the word beside it says the same thing. It takes the text colour, or `--ring` where a pill sets one.
 */
export type RingState = 'turn' | 'wait' | 'check' | 'lock' | 'done' | 'hold' | 'off' | 'live';

export function StateRing({ state, className }: { state: RingState; className?: string | undefined }) {
  return (
    <svg className={`${styles.ring} ${className ?? ''}`} data-state={state} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {state === 'turn' ? (
        <>
          <circle className={styles.ripple} cx="10" cy="10" r="3" />
          <circle className={styles.beat} cx="10" cy="10" r="3.4" />
        </>
      ) : state === 'wait' ? (
        <>
          <circle className={styles.dashes} cx="10" cy="10" r="7.2" />
          <circle className={styles.orbiter} cx="10" cy="2.8" r="2.2" />
        </>
      ) : state === 'check' ? (
        <>
          <circle className={styles.track} cx="10" cy="10" r="7.2" />
          <path className={styles.sweep} d="M10 2.8A7.2 7.2 0 0 1 17.2 10" />
          <circle className={styles.dot} cx="10" cy="10" r="1.8" />
        </>
      ) : state === 'lock' ? (
        <>
          <circle className={styles.dot} cx="10" cy="10" r="8.4" />
          <rect className={styles.cut} x="6.3" y="9.2" width="7.4" height="5.6" rx="1.7" />
          <path className={styles.cutLine} d="M7.9 9.2V7.9a2.1 2.1 0 0 1 4.2 0v1.3" />
        </>
      ) : state === 'done' ? (
        <>
          <circle className={styles.dot} cx="10" cy="10" r="8.4" />
          <path className={styles.tick} d="M6.2 10.4l2.6 2.6 5.1-5.6" />
        </>
      ) : state === 'hold' ? (
        <>
          <circle className={styles.line} cx="10" cy="10" r="7.4" />
          <path className={styles.bars} d="M8 7.2v5.6M12 7.2v5.6" />
        </>
      ) : state === 'off' ? (
        <>
          <circle className={styles.line} cx="10" cy="10" r="7.4" opacity="0.5" />
          <path className={styles.bars} d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2" />
        </>
      ) : (
        <>
          <circle className={styles.breath} cx="10" cy="10" r="4" />
          <circle className={styles.dot} cx="10" cy="10" r="4" />
        </>
      )}
    </svg>
  );
}
