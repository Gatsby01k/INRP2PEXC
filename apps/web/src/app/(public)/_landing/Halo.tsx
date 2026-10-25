import styles from './halo.module.css';

/**
 * What the robot stands in front of: the mark's orange as a sun, the mark's three arcs turning round it, and a dotted
 * orbit carrying the mark's three nodes. Drawing only; placed inside a robot stage, behind the robot.
 */
export function Halo() {
  return (
    <div className={styles.halo} aria-hidden="true">
      <span className={styles.sun} />
      <svg className={styles.ring} viewBox="0 0 100 100" fill="none" focusable="false">
        <circle cx="50" cy="50" r="48" pathLength="360" strokeDasharray="90 30" />
      </svg>
      <svg className={styles.orbit} viewBox="0 0 100 100" fill="none" focusable="false">
        <circle cx="50" cy="50" r="49.4" pathLength="360" strokeDasharray="1 7" />
        <circle cx="50" cy="0.6" r="1.1" className={styles.node} />
        <circle cx="7.2" cy="74.7" r="1.1" className={styles.node} />
        <circle cx="92.8" cy="74.7" r="1.1" className={styles.node} />
      </svg>
    </div>
  );
}
