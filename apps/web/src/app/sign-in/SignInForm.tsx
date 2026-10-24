'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, OtpInput } from '@inrp2p/ui';
import { type TotpSetup, TotpEnrolment } from '../../components/TotpEnrolment.tsx';
import styles from './sign-in.module.css';

type Stage = 'PASSWORD' | 'TOTP' | 'ENROL';

/**
 * Two steps, both Better Auth's own endpoints: `sign-in/email` establishes the session and
 * `two-factor/verify-totp` makes it MFA-verified, which is what the proxy requires of every other page. The
 * failure message is deliberately the same whatever went wrong, so this form never tells an attacker which
 * half they got right.
 *
 * An operator without an authenticator yet — the first OWNER after bootstrap, anyone newly provisioned — is taken
 * through setting one up right there (`two-factor/enable` with the password just typed, then the first code): the
 * desk opens only once a code has been verified, so there is still no way in on a password alone.
 */
export function SignInForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('PASSWORD');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<TotpSetup | null>(null);

  const send = async (path: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> | null }> => {
    const res = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    if (!res) return { ok: false, json: { message: 'The connection dropped. Try again.' } };
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, json };
  };
  const post = async (path: string, body: unknown): Promise<boolean> => (await send(path, body)).ok;

  const submitPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const signedIn = await send('/sign-in/email', { email, password });
      if (!signedIn.ok) {
        setError('That email and password did not match.');
        return;
      }
      if (signedIn.json?.twoFactorRedirect) {
        setStage('TOTP');
        return;
      }
      // No authenticator yet: set one up now, with the password just proven.
      const enabled = await send('/two-factor/enable', { password });
      const totpURI = enabled.json?.totpURI;
      const backupCodes = enabled.json?.backupCodes;
      if (!enabled.ok || typeof totpURI !== 'string' || !Array.isArray(backupCodes)) {
        setError('An authenticator could not be set up. Ask the desk owner.');
        return;
      }
      setSetup({ totpURI, backupCodes: backupCodes.map(String) });
      setStage('ENROL');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await post('/two-factor/verify-totp', { code });
      if (!ok) {
        setError('That code was not accepted. Try the current one.');
        return;
      }
      router.push('/');
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'ENROL' && setup) {
    return (
      <div className={styles.form}>
        <TotpEnrolment
          setup={setup}
          busy={busy}
          error={error}
          submitLabel="Verify and open the desk"
          onVerify={(c) => {
            setCode(c);
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                if (!(await post('/two-factor/verify-totp', { code: c }))) {
                  setError('That code was not accepted. Try the current one.');
                  return;
                }
                router.push('/');
                router.refresh();
              } finally {
                setBusy(false);
              }
            })();
          }}
        />
      </div>
    );
  }

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void (stage === 'PASSWORD' ? submitPassword() : submitCode());
      }}
    >
      {stage === 'PASSWORD' ? (
        <>
          <div className="ix-field">
            <label htmlFor="email">Work email</label>
            <input id="email" className="ix-input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="ix-field">
            <label htmlFor="password">Password</label>
            <input id="password" className="ix-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <Button type="submit" intent="primary" fullWidth loading={busy} disabled={email === '' || password === ''}>
            Continue
          </Button>
        </>
      ) : (
        <>
          <OtpInput label="Authenticator code" value={code} onChange={setCode} invalid={Boolean(error)} />
          <Button type="submit" intent="primary" fullWidth loading={busy} disabled={code.length !== 6}>
            Verify and open the desk
          </Button>
        </>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
