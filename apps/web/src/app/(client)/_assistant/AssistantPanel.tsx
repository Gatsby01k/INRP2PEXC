'use client';

import { type ReactNode, useEffect, useId } from 'react';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import type { AssistantState } from './model.ts';
import { STILLS } from './stills.ts';
import styles from './assistant.module.css';

function Chip({ state, className, hidden = false }: { state: AssistantState; className: string | undefined; hidden?: boolean }) {
  return (
    <span className={className} data-mood={state.mood} {...(hidden ? { 'aria-hidden': true } : {})}>
      <span className={styles.dot} aria-hidden="true" />
      {state.label}
    </span>
  );
}

/**
 * A page's status, reported by the workspace robot: the state of record the page's server data is in (`model.ts`),
 * as a chip, a line and a sentence — and the mood the robot rests in while it lasts.
 *
 * Rendered by the page, so it arrives with the page's own data and says the right thing on first paint. On a
 * desktop it sits under the robot in the workspace's right-hand column, with the chip beside the robot's head; on a
 * narrower screen it leads the page, with a small still of the robot in the same mood. `size` is how much room
 * the robot takes above it: the Exchange gives it the most, a list the least.
 */
export function AssistantPanel({ state, size = 'large', children }: { state: AssistantState; size?: 'large' | 'compact'; children?: ReactNode }) {
  const titleId = useId();
  const still = STILLS[state.mood];

  // The robot rests in the page's mood while it lasts; leaving the page lets it go.
  useEffect(() => {
    robotCues.emit({ kind: 'mood', mood: state.mood });
  }, [state.mood]);
  useEffect(() => () => robotCues.emit({ kind: 'mood', mood: 'none' }), []);

  return (
    <>
      <Chip state={state} className={styles.bubble} hidden />
      <aside className={styles.note} aria-labelledby={titleId} data-assistant-mood={state.mood} data-assistant-size={size}>
        <div className={styles.noteHead}>
          <img className={styles.avatar} src={still.src} width={still.width} height={still.height} alt="" loading="lazy" decoding="async" />
          <Chip state={state} className={styles.chip} />
        </div>
        <div aria-live="polite">
          <h2 id={titleId} className={styles.noteTitle}>
            {state.title}
          </h2>
          <p className={styles.noteBody}>{state.body}</p>
        </div>
        {children}
      </aside>
    </>
  );
}
