import { useId, type ChangeEvent } from 'react';
import { exponentOf, type CurrencyCode } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { groupDigits } from '../../format/number.ts';
import styles from './MoneyInput.module.css';

export interface MoneyInputProps {
  label: string;
  currency: CurrencyCode;
  /** Plain decimal string ("100000", "10200000.50") — parsed by the kernel when submitted. */
  value: string;
  onChange: (value: string) => void;
  size?: 'display' | 'field';
  hint?: string;
  error?: string;
  suffix?: string;
  disabled?: boolean;
}

/**
 * Exact amount entry. Accepts only digits and one decimal point, and refuses to accept more
 * fractional digits than the currency has — it never rounds what a person typed.
 */
export function sanitizeAmountInput(raw: string, currency: CurrencyCode): string | null {
  const cleaned = raw.replace(/[,\s]/g, '');
  if (cleaned === '') return '';
  const m = /^(\d*)(\.(\d*))?$/.exec(cleaned);
  if (!m) return null;
  const whole = (m[1] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = m[3];
  if (fraction !== undefined && fraction.length > exponentOf(currency)) return null;
  if (whole.length > 15) return null;
  return fraction === undefined ? whole : `${whole || '0'}.${fraction}`;
}

export function MoneyInput({ label, currency, value, onChange, size = 'field', hint, error, suffix, disabled }: MoneyInputProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    const next = sanitizeAmountInput(e.target.value, currency);
    if (next !== null) onChange(next);
  };
  const [whole = '', frac] = value.split('.');
  const grouped = whole ? `${groupDigits(whole)}${frac !== undefined ? `.${frac}` : ''}` : '';
  return (
    <div className={cx(styles.root, styles[size], error && styles.invalid)}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.control}>
        {currency === 'INR' ? <span className={styles.prefix} aria-hidden="true">₹</span> : null}
        <input
          id={id}
          className={cx(styles.input, 'ix-num')}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={grouped}
          placeholder="0"
          onChange={onInput}
          disabled={disabled}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={hint || error ? hintId : undefined}
        />
        <span className={styles.suffix}>{suffix ?? currency}</span>
      </div>
      {error ? (
        <p id={hintId} className={styles.error}>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
