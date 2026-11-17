'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { type AssistantState, type Step, soundForTransition } from './model.ts';
import { playSound } from './sound.ts';
import { AlertIcon, ArrowIcon, CheckIcon, InfoIcon, ShieldIcon, TimerIcon } from '../_workspace/icons.tsx';
import shell from '../shell.module.css';
import { StateRing } from '../_workspace/StateRing.tsx';
import styles from './assistant.module.css';

/** The glyph of each state: what needs the client, what is being waited on or checked, what is done. */
const MOOD_ICON = {
  alert: AlertIcon,
  focused: ArrowIcon,
  waiting: TimerIcon,
  verifying: ShieldIcon,
  success: CheckIcon,
  ready: CheckIcon,
  none: InfoIcon,
} as const;

/** The state's ring beside its word: the same family as every status pill. */
const MOOD_RING = { alert: 'turn', focused: 'turn', waiting: 'wait', verifying: 'check', success: 'done', ready: 'live', none: 'live' } as const;

/** The state as a glyph on a soft disc in its tone — the face of a status card. */
export function StateMark({ mood }: { mood: AssistantState['mood'] }) {
  const Icon = MOOD_ICON[mood as keyof typeof MOOD_ICON] ?? InfoIcon;
  return (
    <span className={styles.mark} data-mood={mood} aria-hidden="true">
      <Icon className={styles.markIcon} />
    </span>
  );
}

/** A reference is read and quoted whole: in a sentence it never breaks at its hyphens. */
export function WholeRefs({ text }: { text: string }) {
  const parts = text.split(/([A-Z]{2}-\d{6}-\d{4,})/);
  if (parts.length === 1) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} style={{ whiteSpace: 'nowrap' }}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** The state a page is in, as a word or two beside a dot in its tone. */
export function StateChip({ state, className }: { state: Pick<AssistantState, 'mood' | 'label'>; className?: string | undefined }) {
  return (
    <span className={`${styles.chip}${className ? ` ${className}` : ''}`} data-mood={state.mood}>
      <StateRing state={MOOD_RING[state.mood as keyof typeof MOOD_RING] ?? 'live'} className={styles.chipRing} />
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
 * chip, a line and a sentence, with the state's glyph beside it — small, because the work is the
 * page and the status is about it. `steps`, where the page has a sequence, shows how far it has got; `meta` carries
 * a figure that belongs with the state; `children` sit on the card under it, and `after` follows it as cards of
 * their own.
 *
 * On a narrower screen the status leads the page (`data-lead`), so what is happening is read first.
 */
/** A status that waits for the reader is the page's orange moment: the field, not a card. */
const YOUR_MOVE: ReadonlySet<string> = new Set(['Your move', 'New order']);

export function AssistantPanel({
  state,
  steps,
  meta,
  children,
  after,
  lead = true,
  split = false,
}: {
  state: AssistantState;
  /**
   * The column carries the page's secondary cards (`after`) as well as its status. On a narrower screen the status
   * still leads the page, and those cards follow the work rather than coming before it.
   */
  split?: boolean;
  size?: 'large' | 'compact';
  /** On a narrow screen the panel leads the page (its status first); off, it follows the work. */
  lead?: boolean;
  steps?: readonly Step[] | null | undefined;
  meta?: ReactNode;
  children?: ReactNode;
  after?: ReactNode;
}) {
  const titleId = useId();
  useAssistantState(state);

  return (
    <aside className={shell.aside} {...(lead ? { 'data-lead': '' } : {})} {...(split ? { 'data-split': '' } : {})} aria-labelledby={titleId}>
      <section
        className={YOUR_MOVE.has(state.label) ? `${styles.note} ${shell.brandField}` : styles.note}
        data-assistant-mood={state.mood}
        data-first=""
        {...(YOUR_MOVE.has(state.label) ? { 'data-turn': '' } : {})}
      >
        <div className={styles.noteHead}>
          <StateMark mood={state.mood} />
          <div aria-live="polite" className={styles.noteText}>
            <StateChip state={state} />
            <h2 id={titleId} className={styles.noteTitle}>
              <WholeRefs text={state.title} />
            </h2>
          </div>
        </div>
        <p className={styles.noteBody}>{state.body}</p>
        {meta ? <div className={styles.meta}>{meta}</div> : null}
        {steps && steps.length > 0 ? <ProgressTrack steps={steps} /> : null}
        {children}
      </section>
      {after}
    </aside>
  );
}

/**
 * A page's status as one line across the top of its work, for a page that needs its whole width: the state's glyph,
 * the state in a word, and what it means. Drawn only when something is under way or needs the client.
 */
export function StatusBanner({ state }: { state: AssistantState }) {
  return (
    <section className={styles.banner} data-assistant-mood={state.mood} aria-live="polite">
      <StateMark mood={state.mood} />
      <div className={styles.bannerText}>
        <StateChip state={state} />
        <p className={styles.bannerTitle}>
          <WholeRefs text={state.title} />
        </p>
        <p className={styles.noteBody}>{state.body}</p>
      </div>
    </section>
  );
}
