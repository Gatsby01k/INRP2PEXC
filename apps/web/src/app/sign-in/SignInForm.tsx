'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, OtpInput } from '@inrp2p/ui';
import styles from './sign-in.module.css';

type Stage = 'PASSWORD' | 'TOTP';

/**
 * Two steps, both Better Auth's own endpoints: `sign-in/email` establishes the session and
 * `two-factor/verify-totp` makes it MFA-verified, which is what the proxy requires of every other page. The
 * failure message is deliberately the same whatever went wrong, so this form never tells an attacker which
 * half they got right.
 */
export function SignInForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('PASSWORD');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = async (path: string, body: unknown): Promise<boolean> => {
    const res = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  };

  const submitPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await post('/sign-in/email', { email, password });
      if (!ok) {
        setError('That email and password did not match.');
        return;
      }
      setStage('TOTP');
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
