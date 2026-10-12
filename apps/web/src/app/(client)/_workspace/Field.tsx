'use client';

import { type InputHTMLAttributes, type ReactNode, forwardRef, useId } from 'react';
import { CheckIcon } from './icons.tsx';
import styles from './form.module.css';

/**
 * One labelled field of the workspace's forms: its label, the control, and under it either a hint or — once the
 * client has said something the field cannot take — what is wrong, in words, next to the field it concerns. A field
 * that has been checked and is right says so quietly with a tick. Never the browser's own bubble.
 */
export const Field = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
    label: ReactNode;
    hint?: ReactNode;
    error?: string | null;
    valid?: boolean;
    adornment?: ReactNode;
    action?: ReactNode;
    mono?: boolean;
  }
>(function Field({ label, hint, error, valid = false, adornment, action, mono = false, className, ...input }, ref) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={`${styles.field}${className ? ` ${className}` : ''}`} data-invalid={error ? '' : undefined}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.control} data-valid={valid && !error ? '' : undefined}>
        {adornment ? <span className={styles.adornment}>{adornment}</span> : null}
        <input
          ref={ref}
          id={id}
          className={`${styles.input}${mono ? ` ${styles.mono}` : ''}`}
          aria-invalid={error ? true : undefined}
          {...(note ? { 'aria-describedby': noteId } : {})}
          {...input}
        />
        {valid && !error ? <CheckIcon className={styles.validIcon} /> : null}
        {action ? <span className={styles.action}>{action}</span> : null}
      </div>
      {note ? (
        <p id={noteId} className={error ? styles.error : styles.hint} {...(error ? { role: 'alert' } : {})}>
          {note}
        </p>
      ) : null}
    </div>
  );
});

/** A short choice between a few named options, drawn as one segmented control (a radio group underneath). */
export function Segmented<T extends string>({
  legend,
  value,
  options,
  onChange,
}: {
  legend: string;
  value: T;
  options: readonly { value: T; label: string; detail?: string }[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className={styles.segmentedSet}>
      <legend className={styles.label}>{legend}</legend>
      <div className={styles.segmented} data-count={options.length}>
        {options.map((o) => (
          <label key={o.value} className={styles.segment}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span className={styles.segmentText}>
              <span className={styles.segmentLabel}>{o.label}</span>
              {o.detail ? <span className={styles.segmentDetail}>{o.detail}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** On or off, said in words beside it for anyone who cannot see the knob. */
export function Switch({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={styles.switch} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className={styles.knob} aria-hidden="true" />
    </button>
  );
}
