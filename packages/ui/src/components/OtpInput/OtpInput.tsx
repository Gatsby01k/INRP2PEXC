import { useId, type Ref } from 'react';
import { cx } from '../../cx.ts';
import styles from './OtpInput.module.css';

export interface OtpInputProps {
  value: string;
  onChange: (digits: string) => void;
  label?: string;
  length?: number;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
}

/**
 * One native input (best autofill, screen reader and paste behaviour) drawn as digit cells.
 * `autocomplete="one-time-code"` lets mobile keyboards offer the emailed code.
 */
export function OtpInput({ value, onChange, label = 'Code', length = 6, invalid, disabled, describedBy, inputRef, autoFocus }: OtpInputProps) {
  const id = useId();
  const digits = value.padEnd(length, ' ').slice(0, length).split('');
  return (
    <div className={cx(styles.root, invalid && styles.invalid)}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.frame}>
        <input
          id={id}
          ref={inputRef}
          className={styles.input}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={length}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
        <div className={styles.cells} aria-hidden="true">
          {digits.map((d, i) => (
            <span key={i} className={cx(styles.cell, 'ix-num', i === value.length && styles.cursor)}>
              {d.trim()}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
