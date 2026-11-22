'use client';

import { useState } from 'react';
import { ArcLoader, OtpInput } from '@inrp2p/ui';
import { ConfirmPanel } from '../../../components/Confirm.tsx';
import { type ConfirmFactor, confirmFactorsOf } from '../../../components/confirm-factors.ts';
import { Field } from './Field.tsx';
import { CheckIcon, MailIcon } from './icons.tsx';
import shell from '../shell.module.css';
import styles from './secure.module.css';

type Answer = { ok: boolean; status: number; json: Record<string, unknown> | null } | null;

async function post(path: string, body: unknown): Promise<Answer> {
  try {
    const res = await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return null;
  }
}

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

type Stage = 'address' | 'confirm' | 'code' | 'added' | 'joined';

/**
 * Adding an email to an account Telegram opened (ADR 0026): the address, a code to it, done. The email then signs in
 * with a code too, and confirms what a Telegram session alone must not. Adding it may first ask for a code from the bot
 * (a change of how they sign in). If the address already has an account this still-empty Telegram account can join,
 * the server joins them and this session ends: the person signs in again, to the account they already had.
 */
export function AddEmail({ onDone, intro = true }: { onDone: () => void; /** False inside a sheet that already says what this is. */ intro?: boolean }) {
  const [stage, setStage] = useState<Stage>('address');
  const [email, setEmail] = useState('');
  const [to, setTo] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [confirmWith, setConfirmWith] = useState<ConfirmFactor[] | null>(null);

  /** Sends the code. Returns what to say when it did not go (the confirmation panel shows it), or null. */
  const send = async (): Promise<string | null> => {
    setBusy(true);
    setError(null);
    setFieldError(null);
    const res = await post('/account-email/send', { email: email.trim() });
    setBusy(false);
    if (res?.ok) {
      // The address as the person typed it: it is their own, on their own screen.
      setTo(email.trim().toLowerCase());
      setCode('');
      setConfirmWith(null);
      setStage('code');
      return null;
    }
    const factors = confirmFactorsOf(res?.json ?? undefined);
    if (res?.json?.code === 'STEP_UP_REQUIRED' && factors && factors.length > 0) {
      setConfirmWith(factors);
      setStage('confirm');
      return null;
    }
    const message =
      res?.json?.code === 'INVALID_EMAIL'
        ? 'Enter your full email, like name@example.com.'
        : res?.status === 429
          ? 'Too many tries in a short time. Wait a few minutes.'
          : res?.json?.code === 'EMAIL_ALREADY_SET'
            ? 'This account already has its email.'
            : 'The code could not be sent just now. Try again in a moment.';
    if (res?.json?.code === 'INVALID_EMAIL') setFieldError(message);
    else setError(message);
    if (stage === 'confirm') setStage('address');
    return message;
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    const res = await post('/account-email/verify', { code });
    setBusy(false);
    if (res?.ok && res.json?.merged === true) {
      setStage('joined');
      return;
    }
    if (res?.ok) {
      setStage('added');
      return;
    }
    if (res?.json?.code === 'EMAIL_HAS_ACCOUNT') {
      setError('This email already has its own INRP2P account. Use another email here — or sign out and sign in with that one.');
      setStage('address');
      return;
    }
    setError(res?.status === 429 ? 'Too many tries in a short time. Wait a few minutes.' : 'That code was not accepted. Check the latest email, or send a new code.');
  };

  if (stage === 'confirm' && confirmWith) {
    return (
      <div className={styles.stack}>
        <div>
          <h3 className={styles.title}>First, confirm it’s you</h3>
          <p className={styles.text}>An email becomes a way to sign in, so adding one is confirmed first.</p>
        </div>
        <ConfirmPanel embedded factors={confirmWith} purpose="SECURITY" summary={`Add ${email.trim()}`} onVerified={send} />
      </div>
    );
  }

  if (stage === 'added' || stage === 'joined') {
    const joined = stage === 'joined';
    return (
      <div className={styles.intro}>
        <span className={styles.badge} data-tone="ok" aria-hidden="true">
          <CheckIcon />
        </span>
        <h3 className={styles.title}>{joined ? 'Your accounts are one now' : 'Email added'}</h3>
        <p className={styles.text}>
          {joined
            ? `${to} already had an INRP2P account, so your Telegram now signs in to that one. Sign in again with Telegram to carry on there.`
            : `${to} now signs you in with a code, and confirms the changes you make from Telegram.`}
        </p>
        {joined ? (
          <a className={`${shell.action} ${shell.wide}`} data-tone="ink" href="/sign-in">
            Sign in again
          </a>
        ) : (
          <button type="button" className={`${shell.action} ${shell.wide}`} data-tone="ink" onClick={onDone}>
            Done
          </button>
        )}
      </div>
    );
  }

  if (stage === 'code') {
    return (
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) void verify();
        }}
      >
        <div>
          <h3 className={styles.title}>Enter the code we sent</h3>
          <p className={styles.text}>Six digits, sent to {to}. It works for five minutes.</p>
        </div>
        <OtpInput label="Email code" value={code} onChange={setCode} invalid={Boolean(error)} autoFocus />
        {error ? (
          <p className={shell.error} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className={`${shell.action} ${shell.wide}`} data-tone="ink" disabled={busy || code.length !== 6} aria-busy={busy || undefined}>
          {busy ? <ArcLoader size="sm" label="Checking the code" tone="inherit" /> : null}
          Add email
        </button>
        <div className={styles.codeLinks}>
          <button type="button" className={shell.textAction} disabled={busy} onClick={() => void send()}>
            Send a new code
          </button>
          <button
            type="button"
            className={shell.textAction}
            disabled={busy}
            onClick={() => {
              setError(null);
              setStage('address');
            }}
          >
            Use another email
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      className={styles.stack}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!looksLikeEmail(email)) {
          setFieldError('Enter your full email, like name@example.com.');
          return;
        }
        void send();
      }}
    >
      {intro ? (
        <div className={styles.intro}>
          <span className={styles.badge} aria-hidden="true">
            <MailIcon />
          </span>
          <h3 className={styles.title}>Add your email</h3>
          <p className={styles.text}>
            You signed up with Telegram. Add your email and it signs you in with a code too — and confirms a new bank account, a withdrawal or a team change you make
            from Telegram.
          </p>
        </div>
      ) : null}
      <Field
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="name@example.com"
        value={email}
        error={fieldError}
        onChange={(e) => {
          setEmail(e.target.value);
          setFieldError(null);
        }}
      />
      {error ? (
        <p className={shell.error} role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className={`${shell.action} ${shell.wide}`} data-tone="ink" disabled={busy} aria-busy={busy || undefined}>
        {busy ? <ArcLoader size="sm" label="Sending a code" tone="inherit" /> : <MailIcon className={shell.actionIcon} />}
        Send a code
      </button>
    </form>
  );
}
