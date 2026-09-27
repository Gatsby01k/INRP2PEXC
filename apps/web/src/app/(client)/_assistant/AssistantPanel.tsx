'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { type AssistantState, type Step, soundForTransition } from './model.ts';
import { playSound } from './sound.ts';
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

/** Where the page's sequence has got: the step being waited on, or the last one done. */
function ProgressTrack({ steps }: { steps: readonly Step[] }) {
  const index = Math.max(
    steps.findIndex((s) => s.status === 'current' || s.status === 'exception'),
    steps.every((s) => s.status === 'done') ? steps.length - 1 : 0,
  );
  const step = steps[index]!;
  return (
    <div className={styles.progress}>
      <div className={styles.progressHead}>
        <span className={styles.progressCount}>
          Step {index + 1} of {steps.length}
        </span>
        <span className={styles.progressLabel}>{step.label}</span>
      </div>
      <div className={styles.segments} aria-hidden="true">
        {steps.map((s) => (
          <span key={s.label} className={styles.segment} data-status={s.status} />
        ))}
      </div>
    </div>
  );
}

/**
 * A page's status, reported by the workspace robot: the state of record the page's server data is in (`model.ts`),
 * as a chip, a line and a sentence — and the mood the robot rests in while it lasts. `steps`, where the page has a
 * sequence, puts how far it has got under the robot too; `meta` carries a figure that belongs with the state (the
 * time a quote is still held).
 *
 * Rendered by the page, so it arrives with the page's own data and says the right thing on first paint. On a
 * desktop it sits under the robot in the workspace's right-hand column, with the chip beside its head; on a
 * narrower screen it leads the page, with a small still of the robot in the same mood. `size` is how much room
 * the robot takes above it: the Exchange and a trade give it the most, a list the least.
 *
 * A change of state while the page is open is also the only thing that can make a sound (`soundForTransition`):
 * the first state a page shows never does.
 */
export function AssistantPanel({
  state,
  size = 'large',
  steps,
  meta,
  children,
}: {
  state: AssistantState;
  size?: 'large' | 'compact';
  steps?: readonly Step[] | null | undefined;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  const titleId = useId();
  const still = STILLS[state.mood];
  const previous = useRef<AssistantState | null>(null);

  // The robot rests in the page's mood while it lasts; leaving the page lets it go.
  useEffect(() => {
    robotCues.emit({ kind: 'mood', mood: state.mood });
  }, [state.mood]);
  useEffect(() => () => robotCues.emit({ kind: 'mood', mood: 'ready' }), []);
  useEffect(() => {
    const cue = soundForTransition(previous.current, state);
    previous.current = state;
    if (cue) playSound(cue);
  }, [state]);

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
        {meta ? <div className={styles.meta}>{meta}</div> : null}
        {steps && steps.length > 0 ? <ProgressTrack steps={steps} /> : null}
        {children}
      </aside>
    </>
  );
}
