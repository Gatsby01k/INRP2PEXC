'use client';

import { Fragment } from 'react';
import Link from 'next/link';
import type { RobotFace as Face } from '@inrp2p/robot';
import { ArrowIcon, ChevronIcon } from '../_workspace/icons.tsx';
import { openRobot } from './open.ts';
import { RobotFace } from './RobotFace.tsx';
import type { Speech, SpeechTone } from './speech.ts';
import styles from './says.module.css';

/** The robot's name (owner's choice, 2026-11-28): Hinglish for "bro" — the one who has your back in a deal. */
export const ROBOT_NAME = 'Bhai';

const FACE: Record<SpeechTone, Face> = { calm: 'calm', guard: 'look', alert: 'alert', happy: 'happy' };

/**
 * Bhai speaking, as a character in a game speaks: a white line of dialogue with his name on a black glass tab over its
 * corner, its tail towards him, the words arriving one after another as if said. The first sentence is what matters;
 * a second, quieter one says why. Never a popup, never in the way of the move, one line at a time — the bubble arrives
 * again only when what it says changes (`speech.key`).
 *
 * `variant` is where it stands: `field` on the mark's orange stage, beside the big robot; `sheet` on a white card, where
 * his small face speaks instead. `ask` puts "Ask" on the name tab, which opens the masthead robot's conversation.
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
  const [lead, ...rest] = speech.lines;
  let n = 0;
  // Each word its own span, a plain space between them, so lines still break where words do.
  const words = (text: string) =>
    text.split(/\s+/).filter(Boolean).map((w) => (
      <Fragment key={n}>
        <span className={styles.w} style={{ ['--w' as string]: n++ }}>
          {w}
        </span>{' '}
      </Fragment>
    ));
  return (
    <div
      key={speech.key}
      className={`${styles.says}${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-tone={speech.tone}
      {...(live ? { role: 'status', 'aria-live': 'polite' } : {})}
    >
      {variant === 'sheet' ? <RobotFace face={FACE[speech.tone]} size={38} className={styles.avatar} /> : null}
      <div className={styles.bubble}>
        <span className={styles.tab}>
          <i className={styles.led} aria-hidden="true" />
          <span className={styles.name}>{ROBOT_NAME}</span>
          {ask ? (
            <button type="button" className={styles.ask} onClick={openRobot} aria-label={`Ask ${ROBOT_NAME}`}>
              Ask
              <ChevronIcon className={styles.askIcon} />
            </button>
          ) : null}
        </span>
        <p className={styles.text}>
          {lead ? <span className={styles.lead}>{words(lead)}</span> : null}
          {rest.map((line, i) => (
            <span key={i} className={styles.more}>
              {words(line)}
            </span>
          ))}
        </p>
        {speech.action ? (
          <Link className={styles.action} href={speech.action.href}>
            {speech.action.label}
            <ArrowIcon />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
