'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TelegramView } from '@inrp2p/clients';
import { type ConfirmFactor, type ConfirmPurpose, ConfirmDialog, ConfirmPanel, SecondFactorNeeded } from '../../../components/ConfirmIdentity.tsx';
import { useCommand } from '../../../components/useCommand.tsx';
import { enableTelegramAlertsAction, revokeTelegramLinkAction } from '../../../server/actions/telegram.ts';
import { Switch } from './Field.tsx';
import { PlaneIcon } from './icons.tsx';
import { type TelegramStep, disconnectTelegram, startTelegramLink, telegramLinkProblem } from './telegram-link.ts';
import shell from '../shell.module.css';
import styles from './telegram.module.css';

/**
 * The person's Telegram (ADR 0026), in one card: connected once from here, it signs them in with one tap, receives the
 * codes that confirm their changes, and — for a member of a client — their deal alerts. Connecting goes to Telegram and
 * back; disconnecting stops all three. Either may first ask for a confirmation by another factor, shown in place.
 */
export function TelegramCard({
  view,
  returnTo,
  outcome,
  title = 'Telegram',
}: {
  view: TelegramView;
  /** The page Telegram sends the person back to. */
  returnTo: string;
  /** What the way back said: `?telegram=linked`, or `?telegram=failed&error=…`. */
  outcome?: { readonly state: 'linked' | 'failed'; readonly error: string | null } | undefined;
  title?: string;
}) {
  const router = useRouter();
  const alerts = useCommand();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(outcome?.state === 'failed' ? telegramLinkProblem(outcome.error) : null);
  const [confirm, setConfirm] = useState<{ factors: ConfirmFactor[]; purpose: ConfirmPurpose; then: () => Promise<TelegramStep> } | null>(null);
  const [needsFactor, setNeedsFactor] = useState(false);
  const linked = view.login !== null;
  const alertsOn = view.alerts?.status === 'ACTIVE';

  // The way back from Telegram leaves its word in the address; once read, the address is put back as it was.
  useEffect(() => {
    if (!outcome) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('telegram');
    url.searchParams.delete('error');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, [outcome]);

  const follow = async (step: TelegramStep, then: () => Promise<TelegramStep>): Promise<string | null> => {
    if (step.kind === 'REDIRECT') {
      window.location.assign(step.url);
      return null;
    }
    if (step.kind === 'DONE') {
      setConfirm(null);
      setBusy(false);
      router.refresh();
      return null;
    }
    setBusy(false);
    if (step.kind === 'CONFIRM') {
      setConfirm({ factors: step.factors, purpose: step.purpose, then });
      return null;
    }
    if (step.kind === 'NEEDS_FACTOR') {
      setNeedsFactor(true);
      return null;
    }
    setConfirm(null);
    setProblem(step.message);
    return step.message;
  };

  const act = async (then: () => Promise<TelegramStep>) => {
    setBusy(true);
    setProblem(null);
    await follow(await then(), then);
  };

  const connect = () => act(() => startTelegramLink(returnTo));
  const disconnect = () => act(() => disconnectTelegram(view.login!.accountId));

  const who = view.login?.username ? `@${view.login.username}` : 'your Telegram';
  const justLinked = outcome?.state === 'linked' && linked;

  return (
    <section className={`${shell.card} ${styles.card}`} aria-labelledby="telegram-title" id="telegram">
      <span className={styles.icon} data-on={linked || undefined} aria-hidden="true">
        <PlaneIcon />
      </span>
      <div className={styles.text}>
        <h2 id="telegram-title" className={styles.title}>
          {title}
          {linked ? <span className={styles.on}>Connected</span> : null}
        </h2>
        <p className={styles.detail}>
          {linked
            ? `${justLinked ? 'Done — ' : ''}${who} signs you in with one tap and gets the codes that confirm your changes${view.alerts ? `${alertsOn ? ' and your deal alerts' : ''}` : ''}.`
            : 'Sign in with one tap, confirm changes with a code from the INRP2P bot, and get your deal alerts there.'}
        </p>
        {problem ? (
          <p className={shell.error} role="alert">
            {problem}
          </p>
        ) : null}
        {alerts.error ? (
          <p className={shell.error} role="alert">
            {alerts.error}
          </p>
        ) : null}
      </div>
      <div className={styles.actions}>
        {linked ? (
          <button type="button" className={shell.textAction} disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </button>
        ) : (
          <button type="button" className={shell.action} data-size="sm" data-tone="ink" disabled={busy} aria-busy={busy || undefined} onClick={() => void connect()}>
            Connect Telegram
          </button>
        )}
      </div>
      {linked && view.alerts ? (
        <div className={styles.row}>
          <span className={styles.rowText}>
            <span className={styles.rowTitle}>Deal alerts</span>
            <span className={styles.detail}>New deals, your moves, deadlines and completions, the moment they happen.</span>
          </span>
          <Switch
            checked={alertsOn}
            label="Deal alerts in Telegram"
            disabled={alerts.busy}
            onChange={(next) =>
              void (next ? alerts.run('Turn on Telegram alerts', (key) => enableTelegramAlertsAction(key)) : alerts.run('Turn off Telegram alerts', (key) => revokeTelegramLinkAction(key)))
            }
          />
        </div>
      ) : null}
      {alerts.dialog}
      <ConfirmDialog open={confirm !== null} onCancel={() => setConfirm(null)}>
        {confirm ? (
          <ConfirmPanel
            factors={confirm.factors}
            purpose={confirm.purpose}
            summary={linked ? `Disconnect ${who}` : 'Connect your Telegram'}
            onCancel={() => setConfirm(null)}
            onVerified={async () => {
              const then = confirm.then;
              return follow(await then(), then);
            }}
          />
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog open={needsFactor} onCancel={() => setNeedsFactor(false)}>
        <SecondFactorNeeded summary={linked ? `Disconnect ${who}` : 'Connect your Telegram'} onCancel={() => setNeedsFactor(false)} />
      </ConfirmDialog>
    </section>
  );
}
