'use client';

import { useEffect, useRef, useState } from 'react';
import { ArcLoader, CopyButton, OtpInput, QrCode } from '@inrp2p/ui';
import { type ConfirmFactor, ConfirmPanel, confirmFactorsOf } from '../../../components/ConfirmIdentity.tsx';
import { readTotpUri } from '../../../components/TotpEnrolment.tsx';
import { CheckIcon, DownloadIcon, LockIcon, PhoneIcon } from './icons.tsx';
import shell from '../shell.module.css';
import styles from './secure.module.css';

type Stage = 'intro' | 'confirm' | 'scan' | 'codes' | 'verify';

const groups = (s: string) => s.replace(/\s+/g, '').match(/.{1,4}/g)?.join(' ') ?? s;

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
 * Setting one up is a change of how the person confirms (ADR 0026): with Telegram connected, Better Auth asks first for
 * a code from the factor they did not sign in with; with the email alone, for a sign-in or code in the last ten minutes.
 * Either way the person is not sent away: the confirmation is asked for here, then the set-up goes on. Nothing is
 * enrolled until the app's code is accepted, and that acceptance is also this session's step-up — so the change that
 * follows asks for nothing more.
 */
export function SecureAccount({ email, onDone, autoStart = false, embedded = false }: { email: string; onDone: () => void; autoStart?: boolean; embedded?: boolean }) {
  const [stage, setStage] = useState<Stage>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<{ totpURI: string; backupCodes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [confirmWith, setConfirmWith] = useState<ConfirmFactor[] | null>(null);
  const started = useRef(false);

  /** Asks Better Auth for a new authenticator. A refusal that names factors is a confirmation to give first. */
  const enable = async (): Promise<'OK' | 'CONFIRM' | 'FAILED'> => {
    const res = await post('/two-factor/enable', {});
    const json = (await res?.json().catch(() => null)) as { totpURI?: string; backupCodes?: string[] } & Record<string, unknown> | null;
    if (res?.ok && json?.totpURI && json.backupCodes) {
      setSetup({ totpURI: json.totpURI, backupCodes: json.backupCodes });
      setStage('scan');
      return 'OK';
    }
    const factors = confirmFactorsOf(json ?? undefined);
    if (res?.status === 403 && factors && factors.length > 0) {
      setConfirmWith(factors);
      setStage('confirm');
      return 'CONFIRM';
    }
    return 'FAILED';
  };

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      if ((await enable()) === 'FAILED') setError('The authenticator could not be set up just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
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
          An authenticator app on your phone gives a six-digit code that confirms a new bank account or wallet, a withdrawal, or a change to who may act for your
          account — without waiting for an email or a message. Someone who gets into your inbox alone can never redirect your money.
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

  if (stage === 'confirm' && confirmWith) {
    return (
      <div className={styles.stack}>
        <div>
          <h3 className={styles.title}>First, confirm it’s you</h3>
          <p className={styles.text}>Setting up an authenticator changes how you confirm what matters, so it is confirmed first.</p>
        </div>
        <ConfirmPanel
          embedded
          factors={confirmWith}
          purpose="SECURITY"
          summary="Set up an authenticator"
          onVerified={async () => {
            const out = await enable();
            return out === 'OK' ? null : out === 'CONFIRM' ? 'That did not confirm it. Try again.' : 'The authenticator could not be set up just now. Try again in a moment.';
          }}
        />
      </div>
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
