import type { RobotFace as Face } from '@inrp2p/robot';
import styles from './robot.module.css';

/**
 * The robot's head, small: the same white ceramic head, black visor, orange ears and antenna as the landing's robot, drawn
 * in a few vector shapes so it can live in the masthead at no cost — no WebGL, no image, a few hundred bytes. Its eyes
 * are LEDs on the visor and carry its whole face, as on the big robot: calm with a blink now and then, `^ ^` when
 * something went right, a glance towards the page, three dots while it searches, wide when something needs the person,
 * stars when a price is found, hearts for someone coming back, closed with a "z" while a trader is offline.
 *
 * Every motion is CSS on the eyes alone and stops under reduced motion. `news` lights the antenna: something new to say.
 */
export function RobotFace({ face, news = false, size = 40, className }: { face: Face; news?: boolean; size?: number; className?: string | undefined }) {
  return (
    <svg
      className={`${styles.face}${className ? ` ${className}` : ''}`}
      data-face={face}
      {...(news ? { 'data-news': '' } : {})}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="robot-ceramic" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ece7df" />
        </linearGradient>
        <radialGradient id="robot-glass" cx="0.3" cy="0" r="1.1">
          <stop offset="0" stopColor="#3d3f47" />
          <stop offset="0.45" stopColor="#16171b" />
          <stop offset="1" stopColor="#0a0b0d" />
        </radialGradient>
      </defs>
      <g className={styles.antenna}>
        <line x1="20" y1="8.6" x2="20" y2="4.6" stroke="#16171b" strokeWidth="1.4" strokeLinecap="round" />
        <circle className={styles.antennaBall} cx="20" cy="3.4" r="2.1" />
      </g>
      <rect className={styles.ear} x="2.6" y="15.4" width="4.6" height="11" rx="2.2" />
      <rect className={styles.ear} x="32.8" y="15.4" width="4.6" height="11" rx="2.2" />
      <rect x="5.6" y="8" width="28.8" height="27" rx="10" fill="url(#robot-ceramic)" stroke="rgba(18,19,23,0.14)" strokeWidth="0.8" />
      <rect x="8.9" y="11.6" width="22.2" height="17.4" rx="6.4" fill="url(#robot-glass)" />
      <path d="M11.4 13.6 h6.2" stroke="rgba(255,255,255,0.26)" strokeWidth="1.1" strokeLinecap="round" />
      <g className={styles.eyes}>
        {/* calm, look and alert share the pill eyes; the face's class moves and sizes them */}
        <g className={styles.pills}>
          <rect className={styles.eye} x="14" y="17.6" width="3.4" height="5" rx="1.7" />
          <rect className={styles.eye} x="22.6" y="17.6" width="3.4" height="5" rx="1.7" />
        </g>
        <g className={styles.arcs}>
          <path d="M13.8 21.6 q1.9 -3 3.8 0" />
          <path d="M22.4 21.6 q1.9 -3 3.8 0" />
        </g>
        <g className={styles.dots}>
          <circle cx="15.6" cy="20.2" r="1.35" />
          <circle cx="20" cy="20.2" r="1.35" />
          <circle cx="24.4" cy="20.2" r="1.35" />
        </g>
        <g className={styles.stars}>
          <path d="M15.7 16.9 l0.9 2.4 2.4 0.9 -2.4 0.9 -0.9 2.4 -0.9 -2.4 -2.4 -0.9 2.4 -0.9 z" />
          <path d="M24.3 16.9 l0.9 2.4 2.4 0.9 -2.4 0.9 -0.9 2.4 -0.9 -2.4 -2.4 -0.9 2.4 -0.9 z" />
        </g>
        <g className={styles.hearts}>
          <path d="M15.7 23 l-2.3 -2.4 a1.35 1.35 0 0 1 2.3 -1.7 a1.35 1.35 0 0 1 2.3 1.7 z" />
          <path d="M24.3 23 l-2.3 -2.4 a1.35 1.35 0 0 1 2.3 -1.7 a1.35 1.35 0 0 1 2.3 1.7 z" />
        </g>
        <g className={styles.sleep}>
          <path d="M13.9 20.8 h3.6" />
          <path d="M22.5 20.8 h3.6" />
          <text x="27.6" y="16.6">z</text>
        </g>
      </g>
    </svg>
  );
}
