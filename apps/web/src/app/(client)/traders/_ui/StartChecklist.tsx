'use client';

import Link from 'next/link';
import type { TraderHome } from '@inrp2p/traders';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setAvailabilityAction } from '../../../../server/actions/traders.ts';
import { ArrowIcon, CheckIcon } from '../../_workspace/icons.tsx';
import { usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

type ItemState = 'done' | 'current' | 'pending';

/** What still stands between this trader and its first order, read from the projection alone. */
export function startProgress(home: TraderHome) {
  const working = home.state === 'APPROVED' || home.state === 'PAUSED';
  const r = home.reserve;
  const required = r?.required && /[1-9]/.test(r.required) ? r.required : home.programmeReserve;
  // Under review the projection says what is left to send; once working, the reserve's own shortfall does.
  const reserveIn = working
    ? r !== null && r.required !== null && !/[1-9]/.test(r.shortfall)
    : home.review !== null && home.review.reserveToSend !== null && !/[1-9]/.test(home.review.reserveToSend);
  const toSend = working ? (r && /[1-9]/.test(r.shortfall) ? r.shortfall : required) : (home.review?.reserveToSend ?? required);
  const pricesSet = working && home.blocks.length > 0 && home.blocks.every((b) => b.status === 'ACTIVE' && (b.rateBasis === 'MARKET' || b.rate !== null) && b.minOrder !== null && b.maxOrder !== null);
  return { working, required, reserveIn, toSend, pricesSet, online: working && home.available };
}

/** Whether the checklist still has something to say: under review, or approved and not yet taking orders. */
export function showStartChecklist(home: TraderHome): boolean {
  if (home.state === 'UNDER_REVIEW') return true;
  const p = startProgress(home);
  return p.working && !(p.pricesSet && p.online);
}

function Item({ n, state, title, children }: { n: number; state: ItemState; title: string; children?: React.ReactNode }) {
  return (
    <li className={styles.startItem} data-state={state} {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}>
      <span className={styles.startNum} aria-hidden="true">
        {state === 'done' ? <CheckIcon /> : n}
      </span>
      <span className={styles.startBody}>
        <span className={styles.startTitle}>
          {title}
          {state === 'done' ? <span className="ix-visually-hidden"> — done</span> : null}
        </span>
        {children}
      </span>
    </li>
  );
}

/**
 * The way to a first order, one step at a time and in the order it happens (ADR 0024, 0028): the application, the Security
 * Reserve from the trader's own wallet — which proves the wallet and is what gets it approved, so it is the move to make
 * the moment it has applied — its prices, and going online. Its own page is there to open beside them. Each step says
 * what it needs and has the one action that does it.
 */
export function StartChecklist({ home }: { home: TraderHome }) {
  const { run, busy, error, dialog } = useCommand();
  const p = startProgress(home);
  const review = home.review;
  const wallet = home.registered?.wallet ?? null;
  const goOnline = () => run('Go online', (key) => setAvailabilityAction({ available: true }, key));

  // The first step not done is the one to act on; the reserve can be sent while the application is still being read.
  const states: ItemState[] = [
    // The application is the trader's to send, and it is sent: what follows is INRP2P's review, said beside it.
    'done',
    p.reserveIn ? 'done' : 'current',
    p.pricesSet ? 'done' : p.working && p.reserveIn ? 'current' : 'pending',
    p.online ? 'done' : p.pricesSet ? 'current' : 'pending',
  ];
  const doneCount = states.filter((s) => s === 'done').length;

  return (
    <section className={`${shell.surface} ${styles.start}`} aria-labelledby="start-title" data-robot-target="panel">
      <div className={styles.startHead}>
        <h2 id="start-title" className={shell.cardTitle}>
          {p.working ? 'Start taking orders' : 'Your way to the first order'}
        </h2>
        <span className={styles.startCount}>
          {doneCount} of 4 done
        </span>
      </div>
      <ol className={styles.startList}>
        <Item n={1} state={states[0]!} title={p.working ? 'Approved' : 'Application sent'}>
          <span className={styles.startText}>
            {p.working
              ? 'Your bank account and wallet are verified.'
              : review?.automatic && review.waitingOn === 'RESERVE'
                ? 'You are approved automatically the moment your reserve lands.'
                : review?.automatic
                  ? 'A person at INRP2P is checking one of your details; you are told here and in Notifications.'
                  : 'INRP2P reviews it and tells you here and in Notifications. Send your reserve meanwhile: you can go online the minute you are approved.'}
            {!p.working && home.application ? <span className={styles.startMeta}> Sent {formatIstDateTime(new Date(home.application.appliedAt))}.</span> : null}
          </span>
        </Item>
        <Item n={2} state={states[1]!} title={p.required ? `Security Reserve · ${usdt(p.required)}` : 'Security Reserve'}>
          {p.reserveIn ? (
            <span className={styles.startText}>In, and yours: it is released when you stop and your orders are finished.</span>
          ) : (
            <>
              <span className={styles.startText}>
                Send {p.toSend ? usdt(p.toSend) : 'it'} on TRON (TRC20) from your registered wallet{wallet ? ` ${wallet}` : ''}. That proves the wallet is yours, and it
                stays yours: it is not spent on deals.
              </span>
              <span>
                <Link className={shell.action} href="/traders/reserve" data-robot-target="cta">
                  Send the reserve
                  <ArrowIcon className={shell.actionIcon} />
                </Link>
              </span>
            </>
          )}
        </Item>
        <Item n={3} state={states[2]!} title="Your prices">
          <span className={styles.startText}>
            {p.pricesSet
              ? 'Both sides set.'
              : 'A minute for both sides: follow the market by your own margin, and say how much you can take on.'}
          </span>
          {states[2] === 'current' ? (
            <span>
              <Link className={shell.action} href="/traders/setup">
                Set your prices
                <ArrowIcon className={shell.actionIcon} />
              </Link>
            </span>
          ) : null}
        </Item>
        <Item n={4} state={states[3]!} title="Go online">
          <span className={styles.startText}>Orders come to you while you are online, at your prices and within your limits.</span>
          {states[3] === 'current' && home.canAct ? (
            <span>
              <button type="button" className={shell.action} onClick={() => void goOnline()} disabled={busy}>
                {busy ? <ArcLoader size="sm" label="Going online" tone="inherit" /> : null}
                Go online
              </button>
            </span>
          ) : null}
        </Item>
      </ol>
      {p.working ? (
        <p className={styles.startAside}>
          {home.deskOpened ? 'Your own page is open: ' : 'Your own page, prices and clients, beside INRP2P’s orders: '}
          <Link className={shell.textAction} href="/desk">
            {home.deskOpened ? 'Your desk' : 'Open your page'}
          </Link>
        </p>
      ) : null}
      {error ? (
        <p className={shell.error} role="alert">
          {error}
        </p>
      ) : null}
      {dialog}
    </section>
  );
}
