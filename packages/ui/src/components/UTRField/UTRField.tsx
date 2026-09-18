'use client';

import { useId } from 'react';
import { cx } from '../../cx.ts';
import styles from './UTRField.module.css';

export type UtrCheck = 'idle' | 'checking' | 'available' | 'duplicate';

/** Normalization mirrors the server's `utr_normalized`: trimmed, uppercased, spaces removed. */
export function normalizeUtr(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

export interface UTRFieldProps {
  value: string;
  onChange: (normalized: string) => void;
  check?: UtrCheck;
  /** Leg that already uses this UTR, shown when duplicate (FI-22). */
  duplicateOf?: string;
  label?: string;
  disabled?: boolean;
}

export function UTRField({ value, onChange, check = 'idle', duplicateOf, label = 'UTR / reference', disabled }: UTRFieldProps) {
  const id = useId();
  const msgId = `${id}-msg`;
  const message =
    check === 'duplicate'
      ? `Already recorded${duplicateOf ? ` on ${duplicateOf}` : ''}. A UTR can belong to one transfer only.`
      : check === 'checking'
        ? 'Checking for duplicates…'
        : check === 'available'
          ? 'Not used on any other transfer.'
          : 'Letters and digits, as shown by the bank.';
  return (
    <div className={cx(styles.root, styles[check])}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        className={cx(styles.input, 'ix-num')}
        value={value}
        onChange={(e) => onChange(normalizeUtr(e.target.value))}
        autoComplete="off"
        spellCheck={false}
        maxLength={40}
        disabled={disabled}
        aria-invalid={check === 'duplicate' || undefined}
        aria-describedby={msgId}
      />
      <p id={msgId} className={styles.message} aria-live="polite">
        {message}
      </p>
    </div>
  );
}
