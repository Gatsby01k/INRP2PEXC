'use client';

import Link from 'next/link';
import type { TraderHome } from '@inrp2p/traders';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setAvailabilityAction } from '../../../../server/actions/traders.ts';
import { InfoIcon } from '../../_workspace/icons.tsx';
import { amountIn, sentence, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/** What stops orders, in the trader's words, and the one thing to do about it where there is one. */
function Issue({ home }: { home: TraderHome }) {
  const reserve = home.reserve;
  if (home.issues.includes('RESERVE_SHORT') && reserve) {
    return (
      <p className={shell.info} data-tone="warning" role="status">
        <InfoIcon className={shell.infoIcon} />
        <span>
          Your Security Reserve needs {usdt(reserve.shortfall)} more before new orders can be assigned.{' '}
          <Link className={shell.textAction} href="/traders/reserve">
            Add to your reserve
          </Link>
        </span>
      </p>
    );
  }
  if (home.issues.includes('DESTINATIONS_INACTIVE')) {
    return (
      <p className={shell.info} data-tone="warning" role="status">
        <InfoIcon className={shell.infoIcon} />
        <span>Your registered bank account or wallet is no longer active. The desk reviews settlement details — ask on your usual channel.</span>
      </p>
    );
  }
  if (home.issues.includes('ASSIGNMENTS_DISABLED')) {
    return (
      <p className={shell.info} data-tone="warning" role="status">
        <InfoIcon className={shell.infoIcon} />
        <span>New orders are paused by INRP2P{home.controlNote ? `: ${home.controlNote}` : '.'} Orders in progress continue.</span>
      </p>
    );
  }
  return null;
}

/** Under the count: whether any order is waiting on the trader, then any offer to answer, then plain progress. */
function activeNote(home: TraderHome): string {
  const due = home.active.filter((o) => o.stage === 'YOUR_TURN').length;
  if (due > 0) return `${due} waiting for you`;
  if (home.offers.length > 0) return home.offers.length === 1 ? '1 new offer' : `${home.offers.length} new offers`;
  return home.active.length > 0 ? 'in progress' : 'none right now';
}

/**
 * The top of the working screen: am I online, and what can I provide. The switch is the trader's own — switching off
 * stops new orders at once, and nothing in progress is touched. No sound either way.
 */
export function AvailabilityCard({ home }: { home: TraderHome }) {
  const { run, busy, error, dialog } = useCommand();
  const paused = home.state === 'PAUSED';
  const on = home.available;
  const buy = home.blocks.find((b) => b.side === 'BUY_USDT');
  const sell = home.blocks.find((b) => b.side === 'SELL_USDT');
  const toggle = () => run(on ? 'Switch off' : 'Switch on', (key) => setAvailabilityAction({ available: !on }, key));

  return (
    <section className={`${shell.surface} ${styles.availability}`} aria-labelledby="availability-title" data-robot-target="toggle">
      <div className={styles.availHead}>
        <div className={styles.availText}>
          <span id="availability-title" className={shell.label}>
            Provide liquidity
          </span>
          <p className={styles.availState}>{paused ? 'Paused by INRP2P' : on ? 'You’re online' : 'You’re offline'}</p>
          <p className={styles.availNote}>
            {paused
              ? 'No new orders are assigned. Orders in progress continue.'
              : on
                ? 'You are available for matching. Switching off stops new orders; orders in progress continue.'
                : 'No new orders are assigned while you are off.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="availability-title"
          className={styles.switch}
          disabled={busy || paused || !home.canAct}
          onClick={() => void toggle()}
        >
          <span aria-hidden="true">{on ? 'ON' : 'OFF'}</span>
          <span className={styles.track} aria-hidden="true">
            <span className={styles.knob} />
          </span>
        </button>
      </div>

      <dl className={styles.figures}>
        <div className={styles.figure} {...(buy ? {} : { 'data-quiet': '' })}>
          <dt>INR available</dt>
          <dd>{buy ? amountIn('INR', buy.available) : '—'}</dd>
          <span className={styles.figureNote}>{buy ? (/[1-9]/.test(buy.held) ? `${amountIn('INR', buy.held)} held for orders` : 'Nothing held') : 'Not offered'}</span>
        </div>
        <div className={styles.figure} {...(sell ? {} : { 'data-quiet': '' })}>
          <dt>USDT available</dt>
          <dd>{sell ? amountIn('USDT', sell.available) : '—'}</dd>
          <span className={styles.figureNote}>{sell ? (/[1-9]/.test(sell.held) ? `${amountIn('USDT', sell.held)} held for orders` : 'Nothing held') : 'Not offered'}</span>
        </div>
        <div className={styles.figure}>
          <dt>Security Reserve</dt>
          <dd>{home.reserve ? usdt(home.reserve.engaged ? home.reserve.locked : home.reserve.balance) : '—'}</dd>
          <span className={styles.figureNote}>{!home.reserve ? 'not set' : home.reserve.engaged ? 'locked' : 'held · not locked while you are off'}</span>
        </div>
        <div className={styles.figure}>
          <dt>Active orders</dt>
          <dd>{home.active.length}</dd>
          <span className={styles.figureNote}>{activeNote(home)}</span>
        </div>
      </dl>

      <Issue home={home} />
      {!home.canAct ? <p className={styles.note}>Someone who can accept quotes for your account switches this on and off.</p> : null}
      {error ? (
        <p className={shell.error} role="alert">
          {sentence(error)}
        </p>
      ) : null}
      {dialog}
    </section>
  );
}
