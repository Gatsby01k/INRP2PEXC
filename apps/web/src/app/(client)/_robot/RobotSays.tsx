'use client';

import Link from 'next/link';
import type { RobotFace as Face } from '@inrp2p/robot';
import { ArrowIcon, ChatIcon, ShieldIcon } from '../_workspace/icons.tsx';
import { openRobot } from './open.ts';
import { RobotFace } from './RobotFace.tsx';
import type { Speech, SpeechTone } from './speech.ts';
import styles from './says.module.css';

const FACE: Record<SpeechTone, Face> = { calm: 'calm', guard: 'look', alert: 'alert', happy: 'happy' };
const WHO: Record<SpeechTone, string> = { calm: 'Robot', guard: 'Robot · heads-up', alert: 'Robot · stop', happy: 'Robot' };

/**
 * The robot speaking (ADR 0034 addendum): a remark in its own voice, beside it on the stage or on the sheet under it —
 * never a popup, never in the way of the move. One remark at a time: the bubble arrives again only when what it says
 * changes (`speech.key`). Its log is the visor's: black glass, the times in the mark's orange, the live row blinking.
 *
 * `variant` is where it stands: `field` on the mark's orange stage, its corner towards the robot; `sheet` on a white card,
 * with the robot's face as the speaker. `ask` adds "Ask me", which opens the masthead robot's conversation.
 */
export function RobotSays({
  speech,
  variant = 'field',
  ask = false,
  live = true,
  className,
}: {
  speech: Speech;
  variant?: 'field' | 'sheet';
  ask?: boolean;
  /** Announced politely when it changes; off where the stage around it already announces. */
  live?: boolean;
  className?: string | undefined;
}) {
  const intro = speech.lines.length > 2;
  return (
    <div
      key={speech.key}
      className={`${styles.says}${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-tone={speech.tone}
      {...(intro ? { 'data-intro': '' } : {})}
      {...(live ? { role: 'status', 'aria-live': 'polite' } : {})}
    >
      <div className={styles.head}>
        <RobotFace face={FACE[speech.tone]} size={variant === 'sheet' ? 26 : 22} className={styles.face} />
        <span className={styles.who}>
          {speech.tone === 'guard' || speech.tone === 'alert' ? <ShieldIcon className={styles.whoIcon} /> : null}
          {WHO[speech.tone]}
        </span>
        {ask ? (
          <button type="button" className={styles.ask} onClick={openRobot}>
            <ChatIcon />
            Ask me
          </button>
        ) : null}
      </div>
      <p className={styles.text}>
        {speech.lines.map((line, i) => (
          <span key={i} className={styles.line} style={{ ['--i' as string]: i }}>
            {line}{' '}
          </span>
        ))}
      </p>
      {speech.log && speech.log.length > 0 ? (
        <ol className={styles.log} aria-label="What the robot is doing">
          {speech.log.map((r, i) => (
            <li key={`${i}:${r.text}`} data-state={r.state}>
              <span className={styles.logAt}>{r.state === 'live' ? <i className={styles.logDot} aria-hidden="true" /> : r.at ?? '✓'}</span>
              <span className={styles.logText}>{r.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {speech.action ? (
        <Link className={styles.action} href={speech.action.href}>
          {speech.action.label}
          <ArrowIcon />
        </Link>
      ) : null}
    </div>
  );
}
