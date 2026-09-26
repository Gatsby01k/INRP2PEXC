'use client';

import type { Ref } from 'react';
import { CODE_LENGTH, codeDigits } from './access.ts';
import styles from './gateway.module.css';

/**
 * The six-digit code, drawn as cells across the surface's width.
 *
 * Underneath is one ordinary input, laid over the cells and invisible, because one input is what every other part
 * of the platform understands: a phone's keyboard offers the emailed code into it (`one-time-code`), a paste of
 * "123 456" or "123-456" lands whole, and a screen reader hears one labelled field rather than six boxes. The
 * cells only draw what that input holds and where the next digit goes.
 */
export function CodeField({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  inputRef,
}: {
  id: string;
  value: string;
  onChange: (digits: string) => void;
  invalid: boolean;
  describedBy: string;
  inputRef: Ref<HTMLInputElement>;
}) {
  // The cell the next digit goes into; the last one once the code is complete.
  const next = Math.min(value.length, CODE_LENGTH - 1);
  return (
    <div className={styles.code} data-invalid={invalid || undefined}>
      <input
        id={id}
        ref={inputRef}
        className={styles.codeInput}
        value={value}
        onChange={(e) => onChange(codeDigits(e.target.value))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        enterKeyHint="go"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      <div className={styles.cells} aria-hidden="true">
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <span key={i} className={`${styles.cell} ix-num`} data-filled={i < value.length || undefined} data-next={i === next || undefined}>
            {value[i] ?? ''}
          </span>
        ))}
      </div>
    </div>
  );
}
