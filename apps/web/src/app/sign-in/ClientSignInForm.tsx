'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, OtpInput } from '@inrp2p/ui';
import styles from './sign-in.module.css';

type Stage = 'EMAIL' | 'CODE';

/**
 * Client sign-in (SECURITY §2.2): a code to an address the desk already knows. Both steps are Better Auth's own
 * endpoints, and there is no sign-up — a client user exists because the desk linked them to a client, never
 * because someone typed an address here. The failure message is the same whatever went wrong, so the form does
 * not tell a stranger which addresses are real.
 */
export function ClientSignInForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('EMAIL');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = async (path: string, body: unknown): Promise<boolean> => {
    const res = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.ok;
  };

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
      if (!ok) {
        setError('We could not send a code just now. Try again in a moment.');
        return;
      }
      setStage('CODE');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const ok = await post('/sign-in/email-otp', { email, otp: code });
      if (!ok) {
        setError('That code was not accepted. Check it, or ask for a new one.');
        return;
      }
      router.push('/exchange');
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
        void (stage === 'EMAIL' ? sendCode() : submitCode());
      }}
    >
      {stage === 'EMAIL' ? (
        <>
          <div className="ix-field">
            <label htmlFor="email">Work email</label>
            <input id="email" className="ix-input" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <Button type="submit" intent="primary" fullWidth loading={busy} disabled={email === ''}>
            Send me a code
          </Button>
        </>
      ) : (
        <>
          <OtpInput label="Six-digit code" value={code} onChange={setCode} invalid={Boolean(error)} />
          <Button type="submit" intent="primary" fullWidth loading={busy} disabled={code.length !== 6}>
            Sign in
          </Button>
          <button type="button" className="ix-linkish" disabled={busy} onClick={() => void sendCode()}>
            Send another code
          </button>
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
