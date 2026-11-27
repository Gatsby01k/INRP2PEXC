'use client';

import { usePush } from '../exchange/usePush.ts';
import { BellIcon } from './icons.tsx';
import shell from '../shell.module.css';
import styles from './telegram.module.css';

/**
 * ADR 0033 §2.6: notifications in this browser — what the person's Telegram would be told, for someone who has no
 * Telegram or wants both. One tap, and the browser asks. Nothing shows where the deployment has no push key or the
 * browser has no push.
 */
export function PushConnect({ publicKey }: { publicKey: string | null }) {
  const push = usePush(publicKey);
  if (!publicKey || push.state === 'unsupported') return null;
  const on = push.state === 'on';
  return (
    <section className={`${shell.card} ${styles.card}`} aria-labelledby="push-title">
      <span className={styles.icon} data-on={on || undefined} aria-hidden="true">
        <BellIcon />
      </span>
      <div className={styles.text}>
        <h2 id="push-title" className={styles.title}>
          Notifications on this device
          {on ? <span className={styles.on}>On</span> : null}
        </h2>
        <p className={styles.detail}>
          {on
            ? 'Prices found for you, another client ready to deal, your moves in a deal — on this device, the moment they happen.'
            : push.state === 'denied'
              ? 'This browser blocks notifications from INRP2P. Allow them in the browser’s site settings, then come back.'
              : 'Prices found for you, another client ready to deal, your moves in a deal — on this device, even with the page closed.'}
        </p>
      </div>
      <div className={styles.actions}>
        {on || push.state === 'denied' ? null : (
          <button type="button" className={shell.action} data-size="sm" data-tone="ink" disabled={push.state === 'asking'} onClick={() => void push.turnOn()}>
            Turn on
          </button>
        )}
      </div>
    </section>
  );
}
