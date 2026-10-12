'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { type AssistantState, type Step, soundForTransition } from './model.ts';
import { playSound } from './sound.ts';
import { STILLS } from './stills.ts';
import shell from '../shell.module.css';
import styles from './assistant.module.css';

/** The state a page is in, as a word or two beside a dot in its tone. */
export function StateChip({ state, className }: { state: Pick<AssistantState, 'mood' | 'label'>; className?: string | undefined }) {
  return (
    <span className={`${styles.chip}${className ? ` ${className}` : ''}`} data-mood={state.mood}>
      <span className={styles.dot} aria-hidden="true" />
      {state.label}
    </span>
  );
}

/** Where the page's sequence has got: the step being waited on, or the last one done. */
export function ProgressTrack({ steps }: { steps: readonly Step[] }) {
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
 * What a page's state means beyond the page: the mood any robot on screen rests in while it lasts, and — when the
 * state changes while the page is open — the one sound that change deserves (`soundForTransition`). The first
 * state a page shows never sounds. Pages that draw their own status (the Exchange) use this alone.
 */
export function useAssistantState(state: AssistantState): void {
  const previous = useRef<AssistantState | null>(null);
  useEffect(() => {
    robotCues.emit({ kind: 'mood', mood: state.mood });
  }, [state.mood]);
  useEffect(() => () => robotCues.emit({ kind: 'mood', mood: 'ready' }), []);
  useEffect(() => {
    const cue = soundForTransition(previous.current, state);
    previous.current = state;
    if (cue) playSound(cue);
  }, [state]);
}

/**
 * A page's status, in the column beside its work: the state of record the page's server data is in (`model.ts`) as a
 * chip, a line and a sentence, with the robot's face in the same mood beside it — small, because the work is the
 * page and the status is about it. `steps`, where the page has a sequence, shows how far it has got; `meta` carries
 * a figure that belongs with the state; `children` sit on the card under it, and `after` follows it as cards of
 * their own.
 *
 * On a narrower screen the status leads the page (`data-lead`), so what is happening is read first.
 */
export function AssistantPanel({
  state,
  steps,
  meta,
  children,
  after,
}: {
  state: AssistantState;
  size?: 'large' | 'compact';
  steps?: readonly Step[] | null | undefined;
  meta?: ReactNode;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const titleId = useId();
  const still = STILLS[state.mood];
  useAssistantState(state);

  return (
    <aside className={shell.aside} data-lead="" aria-labelledby={titleId}>
      <section className={styles.note} data-assistant-mood={state.mood}>
        <div className={styles.noteHead}>
          <span className={styles.avatarFrame} aria-hidden="true">
            <img className={styles.avatar} src={still.src} width={still.width} height={still.height} alt="" loading="lazy" decoding="async" />
          </span>
          <StateChip state={state} />
        </div>
        <div aria-live="polite" className={styles.noteText}>
          <h2 id={titleId} className={styles.noteTitle}>
            {state.title}
          </h2>
          <p className={styles.noteBody}>{state.body}</p>
        </div>
        {meta ? <div className={styles.meta}>{meta}</div> : null}
        {steps && steps.length > 0 ? <ProgressTrack steps={steps} /> : null}
        {children}
      </section>
      {after}
    </aside>
  );
}

/**
 * A page's status as one line across the top of its work, for a page that needs its whole width: the robot's face,
 * the state in a word, and what it means. Drawn only when something is under way or needs the client.
 */
export function StatusBanner({ state }: { state: AssistantState }) {
  const still = STILLS[state.mood];
  return (
    <section className={styles.banner} data-assistant-mood={state.mood} aria-live="polite">
      <span className={styles.avatarFrame} aria-hidden="true">
        <img className={styles.avatar} src={still.src} width={still.width} height={still.height} alt="" loading="lazy" decoding="async" />
      </span>
      <div className={styles.bannerText}>
        <StateChip state={state} />
        <p className={styles.bannerTitle}>{state.title}</p>
        <p className={styles.noteBody}>{state.body}</p>
      </div>
    </section>
  );
}
