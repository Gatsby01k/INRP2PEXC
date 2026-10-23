'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TelegramLinkView } from '@inrp2p/clients';
import { useCommand } from '../../../components/useCommand.tsx';
import { revokeTelegramLinkAction, startTelegramLinkAction } from '../../../server/actions/telegram.ts';
import { PlaneIcon } from './icons.tsx';
import shell from '../shell.module.css';
import styles from './telegram.module.css';

/** How often the card looks again while the person is pressing Start in Telegram. */
const WAIT_POLL_MS = 3_000;

/**
 * Deal alerts in the person's own Telegram (ADR 0020 §2.14): connect in two taps — "Connect", then "Open Telegram",
 * where Start sends the bot the one-time code — and the card turns to "On" by itself. Disconnecting takes one tap; so
 * does `/stop` in the chat. Nothing shows when no bot is configured.
 */
export function TelegramConnect({ view, botConfigured, title = 'Alerts in Telegram' }: { view: TelegramLinkView; botConfigured: boolean; title?: string }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const { run, busy, error, dialog } = useCommand();
  const waiting = view.status !== 'ACTIVE' && (url !== null || view.status === 'PENDING');

  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, WAIT_POLL_MS);
    return () => window.clearInterval(t);
  }, [waiting, router]);

  if (!botConfigured) return null;

  const connect = async () => {
    const out = await run('Connect Telegram', (key) => startTelegramLinkAction(key));
    if (out.ok) setUrl(out.result.url);
  };

  return (
    <section className={`${shell.card} ${styles.card}`} aria-labelledby="telegram-title">
      <span className={styles.icon} data-on={view.status === 'ACTIVE' || undefined} aria-hidden="true">
        <PlaneIcon />
      </span>
      <div className={styles.text}>
        <h2 id="telegram-title" className={styles.title}>
          {title}
          {view.status === 'ACTIVE' ? <span className={styles.on}>On</span> : null}
        </h2>
        <p className={styles.detail}>
          {view.status === 'ACTIVE'
            ? `New deals, your moves, deadlines and completions go to ${view.username ? `@${view.username}` : 'your chat'}.`
            : waiting
              ? 'Open Telegram and press Start. This card turns on by itself.'
              : 'New deals, your moves, deadlines and completions — in your own Telegram, the moment they happen.'}
        </p>
        {error ? (
          <p className={shell.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className={styles.actions}>
        {view.status === 'ACTIVE' ? (
          <button type="button" className={shell.textAction} disabled={busy} onClick={() => void run('Disconnect Telegram', (key) => revokeTelegramLinkAction(key))}>
            Disconnect
          </button>
        ) : url ? (
          <a className={shell.action} data-size="sm" data-tone="ink" href={url} target="_blank" rel="noreferrer">
            Open Telegram
          </a>
        ) : (
          <button type="button" className={shell.action} data-size="sm" data-tone="ink" disabled={busy} onClick={() => void connect()}>
            {view.status === 'PENDING' ? 'New link' : 'Connect'}
          </button>
        )}
      </div>
      {dialog}
    </section>
  );
}
