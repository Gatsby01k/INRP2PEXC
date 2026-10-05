'use client';

import { useState } from 'react';
import { Button, CopyButton, OtpInput } from '@inrp2p/ui';
import styles from './TotpEnrolment.module.css';

export interface TotpSetup {
  /** The `otpauth://` URI Better Auth returned from `two-factor/enable`. */
  readonly totpURI: string;
  /** One-time recovery codes, shown once. */
  readonly backupCodes: readonly string[];
}

/** The secret and account label inside an `otpauth://totp/…` URI, for typing into an authenticator by hand. */
export function readTotpUri(uri: string): { secret: string; label: string } {
  const u = new URL(uri);
  const label = decodeURIComponent(u.pathname.replace(/^\/+/, '').replace(/^totp\//, ''));
  return { secret: u.searchParams.get('secret') ?? '', label };
}

const groups = (s: string) => s.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? s;

/**
 * Setting up an authenticator, the same on the desk and on the client workspace: the key to add to an authenticator
 * app (as a link a phone opens directly, and as text to type), the one-time recovery codes — shown this once — and
 * the code that proves the authenticator works. Nothing is enrolled until that code is accepted
 * (`skipVerificationOnEnable: false`); the secret never leaves this screen except into the person's authenticator.
 */
export function TotpEnrolment({ setup, onVerify, busy, error, submitLabel }: {
  setup: TotpSetup;
  onVerify: (code: string) => void;
  busy: boolean;
  error: string | null;
  submitLabel: string;
}) {
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const { secret, label } = readTotpUri(setup.totpURI);
  return (
    <div className={styles.enrol}>
      <ol className={styles.steps}>
        <li>
          <strong>Add this key to your authenticator app</strong> (Google Authenticator, 1Password, Authy…). On a phone,{' '}
          <a href={setup.totpURI}>open it in the app</a>; otherwise type the key for <em>{label}</em>:
          <span className={styles.key}>
            <code>{groups(secret)}</code>
            <CopyButton value={secret} label="authenticator key" />
          </span>
        </li>
        <li>
          <strong>Keep these recovery codes somewhere safe.</strong> Each works once if you lose the authenticator; they are
          not shown again.
          <span className={styles.codes}>
            {setup.backupCodes.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </span>
          <span className={styles.row}>
            <CopyButton value={setup.backupCodes.join('\n')} label="recovery codes" />
            <label className={styles.check}>
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved them
            </label>
          </span>
        </li>
        <li>
          <strong>Enter the code the app shows now.</strong>
          <OtpInput label="Authenticator code" value={code} onChange={setCode} invalid={Boolean(error)} />
        </li>
      </ol>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <Button intent="primary" fullWidth loading={busy} disabled={!saved || code.length !== 6} onClick={() => onVerify(code)}>
        {submitLabel}
      </Button>
    </div>
  );
}
