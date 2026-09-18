'use client';

import { useId } from 'react';
import { cx } from '../../cx.ts';
import { Button } from '../Button/Button.tsx';
import { OtpInput } from '../OtpInput/OtpInput.tsx';
import styles from './AcceptanceVerification.module.css';

export type VerificationState = 'choose' | 'sent' | 'invalid' | 'locked' | 'expired';

export interface MaskedRecipient {
  id: string;
  /** Already masked server-side, e.g. "a•••@acmepay.in". Full addresses never reach the link page. */
  masked: string;
}

export interface AcceptanceVerificationProps {
  state: VerificationState;
  intent: 'accept' | 'reject';
  recipients: readonly MaskedRecipient[];
  selectedRecipientId?: string;
  onSelectRecipient?: (id: string) => void;
  code: string;
  onCodeChange: (code: string) => void;
  attemptsRemaining?: number;
  /** Seconds until resend is allowed; 0 = allowed. */
  resendInSeconds?: number;
  onSend: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

/**
 * Quote-link verification (D-01, D-15). Viewing never changes the quote; accepting or formally
 * rejecting needs a code sent to a verified contact of an authorized client user.
 */
export function AcceptanceVerification(props: AcceptanceVerificationProps) {
  const msgId = useId();
  const { state, intent, recipients } = props;
  const selected = props.selectedRecipientId ?? (recipients.length === 1 ? recipients[0]!.id : undefined);
  const confirmLabel = intent === 'accept' ? 'Confirm & accept' : 'Confirm & reject';

  if (state === 'expired') {
    return (
      <section className={styles.root} aria-label="Verification">
        <h2 className={styles.title}>Quote expired</h2>
        <p className={styles.body}>The code can no longer be used. Ask the desk for a new quote.</p>
        <Button intent="secondary" onClick={props.onCancel}>
          Close
        </Button>
      </section>
    );
  }

  return (
    <section className={styles.root} aria-label="Confirm it's you">
      <h2 className={styles.title}>Confirm it’s you</h2>
      <fieldset className={styles.recipients} disabled={state !== 'choose' && state !== 'sent'}>
        <legend className={styles.legend}>We’ll send a 6-digit code to</legend>
        {recipients.map((r) => (
          <label key={r.id} className={cx(styles.recipient, selected === r.id && styles.selected)}>
            <input type="radio" name="recipient" value={r.id} checked={selected === r.id} onChange={() => props.onSelectRecipient?.(r.id)} />
            <span>{r.masked}</span>
          </label>
        ))}
      </fieldset>

      {state === 'choose' ? (
        <Button intent="primary" size="lg" fullWidth onClick={props.onSend} disabled={!selected} loading={Boolean(props.busy)}>
          Send code
        </Button>
      ) : (
        <>
          <OtpInput value={props.code} onChange={props.onCodeChange} invalid={state === 'invalid'} disabled={state === 'locked'} describedBy={msgId} />
          <p id={msgId} className={cx(styles.message, (state === 'invalid' || state === 'locked') && styles.error)} aria-live="polite">
            {state === 'invalid'
              ? `That code didn’t match. ${props.attemptsRemaining ?? 0} attempt${props.attemptsRemaining === 1 ? '' : 's'} left.`
              : state === 'locked'
                ? 'Too many attempts. Request a new code while the quote is still valid.'
                : props.resendInSeconds && props.resendInSeconds > 0
                  ? `Resend in 0:${String(props.resendInSeconds).padStart(2, '0')}`
                  : 'Didn’t get it? You can resend the code.'}
          </p>
          <Button intent="primary" size="lg" fullWidth onClick={props.onConfirm} disabled={props.code.length !== 6 || state === 'locked'} loading={Boolean(props.busy)}>
            {confirmLabel}
          </Button>
          <div className={styles.secondary}>
            <Button intent="ghost" size="sm" onClick={props.onSend} disabled={Boolean(props.resendInSeconds && props.resendInSeconds > 0)}>
              Resend code
            </Button>
            <Button intent="ghost" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
