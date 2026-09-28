'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, type ButtonIntent, StepUpMark } from '@inrp2p/ui';
import s from './desk.module.css';

/**
 * The desk's pattern for an action that cannot be taken back.
 *
 * It is never one click. The button opens a short confirmation in place — what will happen, in plain words, and
 * the reason the audit trail will carry — and only the second, explicit button runs the command. A step-up action
 * says so before it asks (the hourglass), a destructive one is red, and Escape or "Keep" leaves everything as it
 * was. The command still authorizes and validates itself; this only makes sure a person meant it.
 */
export interface GuardedActionProps {
  /** The trigger button's label, and the confirm button's unless `confirmLabel` is given. */
  readonly label: string;
  readonly confirmLabel?: string;
  /** What will happen, said as a consequence ("The client is refunded…"). */
  readonly consequence: ReactNode;
  /** Reason field label; omit for an action that needs no reason. */
  readonly reasonLabel?: string;
  readonly minReason?: number;
  readonly placeholder?: string;
  readonly tone?: 'danger' | 'neutral';
  readonly trigger?: ButtonIntent;
  readonly size?: 'sm' | 'md';
  readonly stepUp?: boolean;
  readonly disabled?: boolean;
  /** Said under a disabled trigger, so a greyed-out button is never a mystery. */
  readonly disabledReason?: string | null;
  readonly busy?: boolean;
  /** Resolves true when the command went through; the confirmation then closes. */
  readonly onConfirm: (reason: string) => Promise<boolean>;
  readonly testId?: string;
}

export function GuardedAction({
  label,
  confirmLabel,
  consequence,
  reasonLabel,
  minReason = 3,
  placeholder,
  tone = 'neutral',
  trigger = 'secondary',
  size = 'sm',
  stepUp = false,
  disabled = false,
  disabledReason,
  busy = false,
  onConfirm,
  testId,
}: GuardedActionProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const confirmButton = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (reasonLabel) field.current?.focus();
    else confirmButton.current?.querySelector<HTMLButtonElement>('button[data-confirm]')?.focus();
  }, [open, reasonLabel]);

  const ready = !busy && (!reasonLabel || reason.trim().length >= minReason);

  if (!open) {
    return (
      <span className={s.stackTight} style={{ gap: 4 }} {...(testId ? { 'data-testid': testId } : {})}>
        <span>
          <Button intent={trigger} size={size} disabled={disabled || busy} onClick={() => setOpen(true)} {...(stepUp ? { shortcut: <StepUpMark label="needs your authenticator code" /> } : {})}>
            {label}
          </Button>
        </span>
        {disabled && disabledReason ? <span className={s.fieldHint}>{disabledReason}</span> : null}
      </span>
    );
  }

  return (
    <div
      className={s.guard}
      data-tone={tone === 'danger' ? 'danger' : undefined}
      role="group"
      aria-labelledby={`${id}-title`}
      {...(testId ? { 'data-testid': testId } : {})}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <p id={`${id}-title`} className={s.guardTitle}>
        {confirmLabel ?? label}?
      </p>
      <p className={s.guardBody}>{consequence}</p>
      {reasonLabel ? (
        <div className={s.field}>
          <label htmlFor={`${id}-reason`} className={s.fieldLabel}>
            <span>{reasonLabel}</span>
            <span className={s.muted}>{reason.trim().length < minReason ? `at least ${minReason} characters` : 'recorded in the audit trail'}</span>
          </label>
          <textarea ref={field} id={`${id}-reason`} className={s.control} rows={2} value={reason} placeholder={placeholder} onChange={(e) => setReason(e.target.value)} />
        </div>
      ) : null}
      <div className={s.actions} ref={confirmButton}>
        <Button
          data-confirm=""
          intent={tone === 'danger' ? 'danger' : 'primary'}
          size="sm"
          disabled={!ready}
          loading={busy}
          onClick={async () => {
            if (await onConfirm(reason.trim())) {
              setOpen(false);
              setReason('');
            }
          }}
          {...(stepUp ? { shortcut: <StepUpMark label="needs your authenticator code" /> } : {})}
        >
          {confirmLabel ?? label}
        </Button>
        <Button intent="ghost" size="sm" onClick={() => setOpen(false)}>
          Keep as is
        </Button>
      </div>
    </div>
  );
}
