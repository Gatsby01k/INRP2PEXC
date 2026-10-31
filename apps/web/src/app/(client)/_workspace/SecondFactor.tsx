'use client';

import { useState } from 'react';
import type { Protection } from '../../../server/client.ts';
import { ConfirmDialog, ConfirmPanel, type ConfirmFactor } from '../../../components/ConfirmIdentity.tsx';
import { PhoneIcon, PlaneIcon } from './icons.tsx';
import { SecureAccount } from './SecureAccount.tsx';
import { startTelegramLink } from './telegram-link.ts';
import shell from '../shell.module.css';
import styles from './secure.module.css';

/**
 * A second way to confirm (ADR 0026), for someone who signed in with their email and has nothing else yet: their
 * Telegram — two taps, then its codes arrive as a notification — or an authenticator app. Either one, and a new bank
 * account, a withdrawal or a team change is confirmed by it from then on.
 */
export function SecondFactor({ protection, email, returnTo, onDone, embedded = false }: { protection: Protection; email: string; returnTo: string; onDone: () => void; embedded?: boolean }) {
  const [app, setApp] = useState(protection.telegram !== 'OFFER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmFactor[] | null>(null);

  const connect = async (): Promise<string | null> => {
    setBusy(true);
    setError(null);
    const step = await startTelegramLink(returnTo);
    if (step.kind === 'REDIRECT') {
      window.location.assign(step.url);
      return null;
    }
    setBusy(false);
    if (step.kind === 'CONFIRM') {
      setConfirm(step.factors);
      return null;
    }
    const message = step.kind === 'FAILED' ? step.message : 'Telegram could not be connected just now. Try again in a moment.';
    setConfirm(null);
    setError(message);
    return message;
  };

  if (app) return <SecureAccount email={email} onDone={onDone} embedded={embedded} />;

  return (
    <div className={styles.intro}>
      <span className={styles.badge} aria-hidden="true">
        <PlaneIcon />
      </span>
      <h3 className={styles.title}>Confirm changes with Telegram</h3>
      <p className={styles.text}>
        Connect your Telegram once. From then on a new bank account or wallet, a withdrawal or a team change is confirmed with a code our bot sends you — and you can
        sign in with one tap.
      </p>
      {error ? (
        <p className={shell.error} role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className={`${shell.action} ${shell.wide}`} data-tone="ink" onClick={() => void connect()} disabled={busy} aria-busy={busy || undefined}>
        <PlaneIcon className={shell.actionIcon} />
        Connect Telegram
      </button>
      <button type="button" className={shell.textAction} onClick={() => setApp(true)}>
        <PhoneIcon className={shell.actionIcon} />
        Use an authenticator app instead
      </button>
      <ConfirmDialog open={confirm !== null} onCancel={() => setConfirm(null)}>
        {confirm ? <ConfirmPanel factors={confirm} purpose="SECURITY" summary="Connect your Telegram" onCancel={() => setConfirm(null)} onVerified={connect} /> : null}
      </ConfirmDialog>
    </div>
  );
}
