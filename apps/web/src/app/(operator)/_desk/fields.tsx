'use client';

import { useId, type ReactNode, type Ref } from 'react';
import { groupDigits, sanitizeAmountInput } from '@inrp2p/ui';
import { sanitizeRateInput, stepRate } from './numbers.ts';
import s from './desk.module.css';

/**
 * Desk form controls at operator density. Every one of them is a labelled native control — the label is the
 * accessible name, which is also how the end-to-end suite finds them — and none of them decides anything: the
 * command re-checks every value.
 */

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  disabled,
  mono,
  inputRef,
  autoFocus,
  maxLength,
  type = 'text',
  aside,
  onEnter,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  maxLength?: number;
  type?: 'text' | 'date' | 'search';
  aside?: ReactNode;
  onEnter?: () => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={s.field}>
      <div className={s.fieldLabel}>
        <label htmlFor={id}>{label}</label>
        {aside ? <span className={s.muted}>{aside}</span> : null}
      </div>
      <input
        id={id}
        ref={inputRef}
        className={s.control}
        style={mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-table)' } : undefined}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? hintId : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      {error ? (
        <p id={hintId} className={s.fieldError}>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className={s.fieldHint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextArea({ label, value, onChange, hint, placeholder, rows = 2, disabled }: { label: ReactNode; value: string; onChange: (v: string) => void; hint?: ReactNode; placeholder?: string; rows?: number; disabled?: boolean }) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.fieldLabel}>
        {label}
      </label>
      <textarea id={id} className={s.control} rows={rows} value={value} placeholder={placeholder} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint ? (
        <p id={`${id}-hint`} className={s.fieldHint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField<V extends string>({
  label,
  value,
  onChange,
  options,
  hint,
  disabled,
}: {
  label: ReactNode;
  value: V;
  onChange: (v: V) => void;
  options: readonly { value: V; label: string; disabled?: boolean }[];
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.fieldLabel}>
        {label}
      </label>
      <select id={id} className={s.control} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as V)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? <p className={s.fieldHint}>{hint}</p> : null}
    </div>
  );
}

/**
 * Exact amount entry (the design system's own sanitizer): digits and one point, never more decimals than the
 * currency has, grouped as typed. It never rounds what a person entered.
 */
export function AmountField({
  label,
  currency,
  value,
  onChange,
  hint,
  error,
  disabled,
  inputRef,
  aside,
  onEnter,
  suffix,
}: {
  label: ReactNode;
  currency: 'INR' | 'USDT';
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  disabled?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  aside?: ReactNode;
  onEnter?: () => void;
  suffix?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [whole = '', frac] = value.split('.');
  const grouped = whole ? `${groupDigits(whole)}${frac !== undefined ? `.${frac}` : ''}` : '';
  return (
    <div className={s.field}>
      <div className={s.fieldLabel}>
        <label htmlFor={id}>{label}</label>
        {aside ? <span className={s.muted}>{aside}</span> : null}
      </div>
      <div className={s.amount} {...(error ? { 'data-invalid': '' } : {})}>
        {currency === 'INR' ? (
          <span className={s.amountAffix} aria-hidden="true">
            ₹
          </span>
        ) : null}
        <input
          id={id}
          ref={inputRef}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={grouped}
          placeholder="0"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? hintId : undefined}
          onChange={(e) => {
            const next = sanitizeAmountInput(e.target.value, currency);
            if (next !== null) onChange(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
        <span className={s.amountAffix}>{suffix ?? (currency === 'INR' ? 'INR' : 'USDT')}</span>
      </div>
      {error ? (
        <p id={hintId} className={s.fieldError}>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className={s.fieldHint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={s.checkbox}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export interface Choice<V extends string> {
  readonly value: V;
  readonly title: ReactNode;
  readonly aside?: ReactNode;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly body?: ReactNode;
}

/** A radio group drawn as rows: the choice, what it means, and — where there is one — the figure that decides it. */
export function Choices<V extends string>({ legend, value, onChange, choices, name }: { legend: string; value: V; onChange: (v: V) => void; choices: readonly Choice<V>[]; name?: string }) {
  const generated = useId();
  const group = name ?? generated;
  return (
    <fieldset className={s.choices} role="radiogroup" aria-labelledby={`${generated}-legend`}>
      <legend id={`${generated}-legend`}>{legend}</legend>
      {choices.map((c) => (
        <label key={c.value} className={s.choice} {...(value === c.value ? { 'data-checked': '' } : {})} {...(c.disabled ? { 'data-disabled': '' } : {})}>
          <input type="radio" name={group} checked={value === c.value} disabled={c.disabled} onChange={() => onChange(c.value)} />
          <span className={s.choiceBody}>
            <span className={s.choiceTitle}>
              <span>{c.title}</span>
              {c.aside ? <span className="ix-num">{c.aside}</span> : null}
            </span>
            {c.description ? <span className={s.choiceDesc}>{c.description}</span> : null}
            {c.body}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function Segments<V extends string>({ value, onChange, options, label }: { value: V; onChange: (v: V) => void; options: readonly { value: V; label: ReactNode }[]; label: string }) {
  return (
    <div className={s.segmented} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={s.segment} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A rate, with the dealer's keys: ↑/↓ move it by ₹0.01, with Shift by ₹0.10 — exact micro-unit arithmetic, never a
 * float. The number is always read back by `Rate.parse` in the command.
 */
export function RateField({
  label,
  value,
  onChange,
  hint,
  error,
  inputRef,
  aside,
  onEnter,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  hint?: ReactNode;
  error?: string | null;
  inputRef?: Ref<HTMLInputElement>;
  aside?: ReactNode;
  onEnter?: () => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={s.field}>
      <div className={s.fieldLabel}>
        <label htmlFor={id}>{label}</label>
        {aside ? <span className={s.muted}>{aside}</span> : null}
      </div>
      <div className={s.amount} {...(error ? { 'data-invalid': '' } : {})}>
        <span className={s.amountAffix} aria-hidden="true">
          ₹
        </span>
        <input
          id={id}
          ref={inputRef}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder="0.00"
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? hintId : undefined}
          onChange={(e) => {
            const next = sanitizeRateInput(e.target.value);
            if (next !== null) onChange(next);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const step = (e.shiftKey ? 100_000n : 10_000n) * (e.key === 'ArrowUp' ? 1n : -1n);
              onChange(stepRate(value, step));
            } else if (e.key === 'Enter' && onEnter) {
              e.preventDefault();
              onEnter();
            }
          }}
        />
        <span className={s.amountAffix}>per USDT</span>
      </div>
      {error ? (
        <p id={hintId} className={s.fieldError}>
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className={s.fieldHint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
