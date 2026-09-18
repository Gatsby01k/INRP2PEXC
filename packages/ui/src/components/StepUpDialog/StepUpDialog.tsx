'use client';

import { useEffect, useId, useRef } from 'react';
import { Button } from '../Button/Button.tsx';
import { OtpInput } from '../OtpInput/OtpInput.tsx';
import styles from './StepUpDialog.module.css';

export interface StepUpDialogProps {
  open: boolean;
  /** What will happen after verification, e.g. "Confirm payout ₹2,500,000 · L3". */
  actionSummary: string;
  code: string;
  onCodeChange: (code: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  error?: string;
  busy?: boolean;
}

/** TOTP re-verification for step-up actions (SECURITY §2.1). Modal, labelled, Escape cancels, focus starts on the code. */
export function StepUpDialog({ open, actionSummary, code, onCodeChange, onConfirm, onCancel, error, busy }: StepUpDialogProps) {
  const titleId = useId();
  const descId = useId();
  const errId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className={styles.scrim}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={styles.dialog}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        <h2 id={titleId} className={styles.title}>
          Verify to continue
        </h2>
        <p id={descId} className={styles.body}>
          Enter the 6-digit code from your authenticator app to authorize: <strong>{actionSummary}</strong>
        </p>
        <OtpInput label="Authenticator code" value={code} onChange={onCodeChange} invalid={Boolean(error)} inputRef={inputRef} {...(error ? { describedBy: errId } : {})} />
        {error ? (
          <p id={errId} className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button intent="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button intent="primary" onClick={onConfirm} disabled={code.length !== 6} loading={Boolean(busy)}>
            Verify and confirm
          </Button>
        </div>
      </div>
    </div>
  );
}
