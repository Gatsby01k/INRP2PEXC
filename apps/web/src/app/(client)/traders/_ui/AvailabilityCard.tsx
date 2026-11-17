'use client';

import Link from 'next/link';
import type { TraderHome } from '@inrp2p/traders';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setAvailabilityAction } from '../../../../server/actions/traders.ts';
import { InfoIcon } from '../../_workspace/icons.tsx';
import { Unit } from './Unit.tsx';
import { amountIn, balanceIn, sentence, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/** What stops orders, in the trader's words, and the one thing to do about it where there is one. */
export function Issue({ home }: { home: TraderHome }) {
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
        <span>
          Your registered bank account or wallet is no longer active.{' '}
          <Link className={shell.textAction} href="/traders/settlement">
            Submit new settlement details
          </Link>{' '}
          — the desk reviews them before orders resume.
        </span>
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
  // Online, and still no order can come: every side is paused, unpriced or out of capacity. Said here, where "online" is.
  const stuck = sidesTakingNothing(home);
  if (stuck) {
    return (
      <p className={shell.info} data-tone="warning" role="status">
        <InfoIcon className={shell.infoIcon} />
        <span>You are online, but no order can reach you: {stuck}. Open the side under “Your prices” and press Edit.</span>
      </p>
    );
  }
  return null;
}

const SIDE_STOPPED: Record<string, string> = {
  BLOCK_PAUSED: 'is paused',
  NO_RATE: 'has no rate',
  NO_LIMITS: 'has no order size',
  NO_CAPACITY: 'has no capacity left',
};

/**
 * Why an online trader gets no orders although nothing is wrong with its account: each of its sides, and what stops it.
 * Null when it is offline, something about the account already says why, or at least one side can take an order. A market
 * rate that is only waiting for the market is not the trader's to fix, and is said on the side itself.
 */
export function sidesTakingNothing(home: TraderHome): string | null {
  if (!home.available || home.state !== 'APPROVED' || home.issues.length > 0 || home.blocks.length === 0) return null;
  if (home.blocks.some((b) => b.issues.length === 0)) return null;
  const said = home.blocks
    .filter((b) => !(b.issues[0] === 'NO_RATE' && b.rateBasis === 'MARKET'))
    .map((b) => `${b.side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT'} ${SIDE_STOPPED[b.issues[0]!] ?? 'takes no orders'}`);
  return said.length > 0 ? said.join(', ') : null;
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
    <section className={`${shell.card} ${styles.availability}`} aria-labelledby="availability-title" data-robot-target="toggle" data-on={(on && !paused) || undefined}>
      <div className={styles.availHead}>
        <span className={styles.availDot} aria-hidden="true" />
        <div className={styles.availText}>
          <span id="availability-title" className={styles.availLabel}>
            Provide liquidity
          </span>
          <p className={styles.availState}>{paused ? 'Paused by INRP2P' : on ? 'You’re online' : 'You’re offline'}</p>
        </div>
        <p className={styles.availNote}>
          {paused
            ? 'No new orders are assigned. Orders in progress continue.'
            : on
              ? sidesTakingNothing(home)
                ? 'Online, but no side can take an order right now — see below.'
                : 'You are available for matching. Switching off stops new orders; orders in progress continue.'
              : 'No new orders are assigned while you are off.'}
        </p>
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
          <dd>{buy ? <Unit value={amountIn('INR', buy.available)} /> : '—'}</dd>
          <span className={styles.figureNote}>{buy ? (/[1-9]/.test(buy.held) ? `${amountIn('INR', buy.held)} held for orders` : 'Nothing held') : 'Not offered'}</span>
        </div>
        <div className={styles.figure} {...(sell ? {} : { 'data-quiet': '' })}>
          <dt>USDT available</dt>
          <dd>{sell ? <Unit value={balanceIn('USDT', sell.available)} /> : '—'}</dd>
          <span className={styles.figureNote}>{sell ? (/[1-9]/.test(sell.held) ? `${balanceIn('USDT', sell.held)} held for orders` : 'Nothing held') : 'Not offered'}</span>
        </div>
        <div className={styles.figure}>
          <dt>Security Reserve</dt>
          <dd>{home.reserve ? <Unit value={usdt(home.reserve.engaged ? home.reserve.locked : home.reserve.balance)} /> : '—'}</dd>
          <span className={styles.figureNote}>{!home.reserve ? 'not set' : home.reserve.engaged ? 'locked' : 'held · not locked while you are off'}</span>
        </div>
        <div className={styles.figure}>
          <dt>Active orders</dt>
          <dd>{home.active.length}</dd>
          <span className={styles.figureNote} data-tone={home.active.some((o) => o.stage === 'YOUR_TURN') ? 'action' : undefined}>
            {activeNote(home)}
          </span>
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
