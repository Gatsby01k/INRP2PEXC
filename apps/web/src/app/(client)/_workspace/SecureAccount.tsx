'use client';

import { useEffect, useRef, useState } from 'react';
import { ArcLoader, CopyButton, OtpInput, QrCode } from '@inrp2p/ui';
import { readTotpUri } from '../../../components/TotpEnrolment.tsx';
import { CheckIcon, DownloadIcon, LockIcon, PhoneIcon } from './icons.tsx';
import shell from '../shell.module.css';
import styles from './secure.module.css';

type Stage = 'intro' | 'reauth' | 'scan' | 'codes' | 'verify';

const groups = (s: string) => s.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? s;

const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return domain ? `${local.slice(0, 1)}•••@${domain}` : email;
};

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(`/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
}

/**
 * Setting up the client's authenticator — the factor that confirms every change to where they are paid (TD-11,
 * SECURITY §2.2) — as three short steps: scan the key into an app, keep the recovery codes, prove it works.
 *
 * Better Auth only lets a recent sign-in start this (ten minutes, `CLIENT_MFA_ENROLMENT_MAX_SESSION_AGE_SECONDS`).
 * When the session is older the client is not sent away to sign in again: a fresh code goes to their own email and
 * is confirmed here, which is the same sign-in, without leaving the task. Nothing is enrolled until the app's code is
 * accepted, and that acceptance is also this session's step-up — so the change that follows asks for nothing more.
 */
export function SecureAccount({ email, onDone, autoStart = false, embedded = false }: { email: string; onDone: () => void; autoStart?: boolean; embedded?: boolean }) {
  const [stage, setStage] = useState<Stage>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post('/two-factor/enable', {});
      const json = (await res?.json().catch(() => null)) as { totpURI?: string; backupCodes?: string[] } | null;
      if (res?.ok && json?.totpURI && json.backupCodes) {
        setSetup({ totpURI: json.totpURI, backupCodes: json.backupCodes });
        setStage('scan');
        return;
      }
      if (res?.status === 403 || res?.status === 401) {
        await sendEmailCode();
        setStage('reauth');
        return;
      }
      setError('The authenticator could not be set up just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const sendEmailCode = async () => {
    const res = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    setResendAt(Date.now() + 30_000);
    if (!res?.ok) setError('We could not send a code just now. Try again in a moment.');
  };

  const confirmIdentity = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post('/sign-in/email-otp', { email, otp: emailCode });
      if (!res?.ok) {
        setError('That code was not accepted. Check the latest email and try again.');
        return;
      }
      setEmailCode('');
    } finally {
      setBusy(false);
    }
    await begin();
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post('/two-factor/verify-totp', { code });
      if (!res?.ok) {
        setError('That code was not accepted. Enter the one your app shows now.');
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      void begin();
    }
  }, [autoStart]);

  useEffect(() => {
    if (stage !== 'reauth') return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [stage]);

  const download = () => {
    if (!setup) return;
    const text = `INRP2P Exchange — authenticator recovery codes\n${email}\n\nEach code works once.\n\n${setup.backupCodes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'inrp2p-recovery-codes.txt';
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const step = stage === 'scan' ? 1 : stage === 'codes' ? 2 : stage === 'verify' ? 3 : 0;

  if (stage === 'intro') {
    return (
      <div className={styles.intro}>
        <span className={styles.badge} aria-hidden="true">
          <LockIcon />
        </span>
        <h3 className={styles.title}>Protect where you are paid</h3>
        <p className={styles.text}>
          An authenticator app on your phone gives a six-digit code. You enter one whenever a bank account or wallet is added or archived, or someone’s authority to accept
          quotes changes — so a stolen password alone can never redirect your money.
        </p>
        <ul className={styles.points}>
          <li>
            <CheckIcon /> Works with Google Authenticator, Microsoft Authenticator, 1Password or Authy
          </li>
          <li>
            <CheckIcon /> Takes about a minute
          </li>
        </ul>
        {error ? (
          <p className={shell.error} role="alert">
            {error}
          </p>
        ) : null}
        <button type="button" className={`${shell.action} ${shell.wide}`} data-tone="ink" onClick={() => void begin()} disabled={busy} aria-busy={busy || undefined}>
          {busy ? <ArcLoader size="sm" label="Working" tone="inherit" /> : <PhoneIcon className={shell.actionIcon} />}
          Set up authenticator
        </button>
      </div>
    );
  }

  if (stage === 'reauth') {
    const wait = Math.ceil((resendAt - now) / 1000);
    return (
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault();
          if (emailCode.length === 6) void confirmIdentity();
        }}
      >
        <div>
          <h3 className={styles.title}>First, confirm it’s you</h3>
          <p className={styles.text}>
            Setting up an authenticator needs a fresh sign-in. We sent a code to <strong>{maskEmail(email)}</strong>.
          </p>
        </div>
        <OtpInput label="Code from your email" value={emailCode} onChange={setEmailCode} invalid={Boolean(error)} autoFocus />
        {error ? (
          <p className={shell.error} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className={`${shell.action} ${shell.wide}`} data-tone="ink" disabled={busy || emailCode.length !== 6} aria-busy={busy || undefined}>
          {busy ? <ArcLoader size="sm" label="Working" tone="inherit" /> : null}
          Confirm and continue
        </button>
        <button type="button" className={shell.textAction} disabled={wait > 0} onClick={() => void sendEmailCode()}>
          {wait > 0 ? `Send another code in ${wait}s` : 'Send another code'}
        </button>
      </form>
    );
  }

  const { secret, label: issued } = setup ? readTotpUri(setup.totpURI) : { secret: '', label: '' };
  const label = issued.includes(':') ? issued.slice(issued.indexOf(':') + 1) : issued;

  return (
    <div className={styles.stack}>
      <ol className={styles.steps} data-embedded={embedded || undefined} aria-label="Authenticator set-up">
        {['Scan', 'Save codes', 'Confirm'].map((name, i) => (
          <li key={name} data-state={i + 1 < step ? 'done' : i + 1 === step ? 'current' : 'next'} {...(i + 1 === step ? { 'aria-current': 'step' as const } : {})}>
            <span className={styles.stepMark} aria-hidden="true">
              {i + 1 < step ? <CheckIcon /> : i + 1}
            </span>
            {name}
          </li>
        ))}
      </ol>

      {stage === 'scan' && setup ? (
        <>
          <div className={styles.scan}>
            <div className={styles.qrFrame}>
              <QrCode value={setup.totpURI} label="QR code to add INRP2P to your authenticator app" className={styles.qr} />
            </div>
            <div className={styles.scanText}>
              <h3 className={styles.title}>Scan with your authenticator app</h3>
              <p className={styles.text}>Open the app on your phone, choose to add an account, and point the camera at this code.</p>
              <a className={shell.textAction} href={setup.totpURI}>
                On this phone? Open in the app
              </a>
            </div>
          </div>
          <div className={styles.keyBox}>
            <span className={styles.keyLabel}>Can’t scan? Enter this key for {label}</span>
            <span className={styles.keyRow}>
              <code className={styles.key}>{groups(secret)}</code>
              <CopyButton value={secret} label="authenticator key" />
            </span>
          </div>
          <button type="button" className={`${shell.action} ${shell.wide}`} data-tone="ink" onClick={() => setStage('codes')}>
            I’ve added it
          </button>
        </>
      ) : null}

      {stage === 'codes' && setup ? (
        <>
          <div>
            <h3 className={styles.title}>Keep your recovery codes</h3>
            <p className={styles.text}>If you lose your phone, each code works once instead of the app. They are shown only now.</p>
          </div>
          <ul className={styles.codes} aria-label="Recovery codes">
            {setup.backupCodes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <div className={styles.codeActions}>
            <CopyButton value={setup.backupCodes.join('\n')} label="recovery codes" />
            <button type="button" className={shell.secondaryAction} data-size="sm" onClick={download}>
              <DownloadIcon />
              Download
            </button>
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span>I’ve saved them somewhere safe</span>
          </label>
          <button type="button" className={`${shell.action} ${shell.wide}`} data-tone="ink" disabled={!saved} onClick={() => setStage('verify')}>
            Continue
          </button>
        </>
      ) : null}

      {stage === 'verify' ? (
        <form
          className={styles.stack}
          onSubmit={(e) => {
            e.preventDefault();
            if (code.length === 6) void verify();
          }}
        >
          <div>
            <h3 className={styles.title}>Enter the code from your app</h3>
            <p className={styles.text}>It changes every thirty seconds; enter the one showing now.</p>
          </div>
          <OtpInput label="Authenticator code" value={code} onChange={setCode} invalid={Boolean(error)} autoFocus />
          {error ? (
            <p className={shell.error} role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className={`${shell.action} ${shell.wide}`} data-tone="ink" disabled={busy || code.length !== 6} aria-busy={busy || undefined}>
            {busy ? <ArcLoader size="sm" label="Working" tone="inherit" /> : null}
            Turn on authenticator
          </button>
          <button type="button" className={shell.textAction} onClick={() => setStage('scan')}>
            Back to the QR code
          </button>
        </form>
      ) : null}
    </div>
  );
}
