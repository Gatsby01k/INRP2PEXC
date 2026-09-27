import type { Step } from '../_assistant/model.ts';
import { CheckIcon } from './icons.tsx';
import styles from './workspace.module.css';

const SPOKEN: Record<Step['status'], string> = { done: 'done', current: 'in progress', pending: 'not started', exception: 'stopped' };

/**
 * Where something stands in a sequence the product actually runs — a request on its way to a trade, a trade on its
 * way to settled. Across a surface wide enough for it, down one narrower. The step being waited on is the only
 * one that says more than its name; each status is said in words as well as drawn.
 */
export function Stepper({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <ol className={styles.stepper} aria-label={label}>
      {steps.map((s) => (
        <li key={s.label} className={styles.step} data-status={s.status} {...(s.status === 'current' ? { 'aria-current': 'step' as const } : {})}>
          <span className={styles.stepMark} aria-hidden="true">
            {s.status === 'done' ? <CheckIcon className={styles.stepCheck} /> : s.status === 'exception' ? '!' : null}
          </span>
          <span className={styles.stepText}>
            <span className={styles.stepLabel}>
              {s.label}
              <span className="ix-visually-hidden">, {SPOKEN[s.status]}</span>
            </span>
            {s.detail ? <span className={styles.stepDetail}>{s.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
