import type { ReactNode } from 'react';
import type { Step } from '../_assistant/model.ts';
import { CheckIcon } from './icons.tsx';
import styles from './summary.module.css';

const SPOKEN: Record<Step['status'], string> = { done: 'done', current: 'in progress', pending: 'not started', exception: 'stopped' };

export interface Figure {
  readonly label: string;
  readonly value: ReactNode;
}

/** An order's figures in one row: what you pay, what you receive, at what rate — each a quiet label over the figure. */
export function Figures({ figures }: { figures: readonly Figure[] }) {
  return (
    <dl className={styles.figures} data-count={figures.length}>
      {figures.map((f) => (
        <div key={f.label} className={styles.figure}>
          <dt className={styles.figureLabel}>{f.label}</dt>
          <dd className={styles.figureValue}>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The money's journey as one line from the first stop to the last, filled as far as it has got. Every stop says its
 * state in words as well as drawn; the one being waited on says what it waits for.
 */
export function Track({ steps, label, note }: { steps: readonly (Step & { readonly note?: string })[]; label: string; note?: (s: Step & { readonly note?: string }) => string }) {
  const reached = Math.max(0, steps.findIndex((s) => s.status !== 'done'));
  const progress = steps.every((s) => s.status === 'done') ? 1 : reached / Math.max(1, steps.length - 1);
  return (
    <ol className={styles.track} aria-label={label} style={{ ['--progress' as string]: progress, ['--stops' as string]: steps.length }}>
      {steps.map((s) => (
        <li key={s.label} className={styles.stop} data-status={s.status} {...(s.status === 'current' ? { 'aria-current': 'step' as const } : {})}>
          <span className={styles.node} aria-hidden="true">
            {s.status === 'done' ? <CheckIcon /> : s.status === 'exception' ? '!' : null}
          </span>
          <span className={styles.stopLabel}>
            {s.label}
            <span className="ix-visually-hidden">, {SPOKEN[s.status]}</span>
          </span>
          <span className={styles.stopDetail}>{note ? note(s) : (s.detail ?? '')}</span>
        </li>
      ))}
    </ol>
  );
}
