'use client';

import Link from 'next/link';
import type { TraderHome, TraderNetworkView } from '@inrp2p/traders';
import { formatCountdown } from '@inrp2p/ui/format';
import { Amount } from '../../../../components/Amount.tsx';
import { Coin } from '../../../../components/Coin.tsx';
import { BankMark } from '../../../../components/PayMarks.tsx';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setAvailabilityAction } from '../../../../server/actions/traders.ts';
import { FieldHalo } from '../../_workspace/FieldHalo.tsx';
import { ArrowIcon, CheckIcon, ShieldIcon } from '../../_workspace/icons.tsx';
import { inr, isZero, sentence, trx, usdt } from './format.ts';
import shell from '../../shell.module.css';
import traders from '../traders.module.css';
import styles from './home.module.css';

/**
 * The working trader's switch, in the page's heading: one glass pill that says whether orders come — "You're online ·
 * taking new orders" — with the switch at its end. Switching off stops new orders at once; nothing in progress is
 * touched. No sound either way.
 */
export function OnlinePill({ home }: { home: TraderHome }) {
  const { run, busy, error, dialog } = useCommand();
  const paused = home.state === 'PAUSED';
  const on = home.available;
  const toggle = () => run(on ? 'Switch off' : 'Switch on', (key) => setAvailabilityAction({ available: !on }, key));
  return (
    <div className={styles.online} data-on={(on && !paused) || undefined} data-online-pill="">
      <span className={styles.onlineDot} aria-hidden="true" />
      <span id="availability-title" className={styles.onlineText}>
        <b>
          {paused ? (
            'Paused'
          ) : (
            <>
              <span className={styles.wide}>You’re {on ? 'online' : 'offline'}</span>
              <span className={styles.narrow}>{on ? 'Online' : 'Offline'}</span>
            </>
          )}
        </b>
        <span>{paused ? 'orders in progress continue' : on ? 'taking new orders' : 'no new orders'}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby="availability-title"
        className={`${traders.switch} ${styles.onlineSwitch}`}
        disabled={busy || paused || !home.canAct}
        title={home.canAct ? undefined : 'Someone who can accept quotes for your account switches this'}
        onClick={() => void toggle()}
      >
        <span className={traders.track} aria-hidden="true">
          <span className={traders.knob} />
        </span>
      </button>
      {error ? (
        <p className={styles.onlineError} role="alert">
          {sentence(error)}
        </p>
      ) : null}
      {dialog}
    </div>
  );
}

/** The share of a timed step that is left, for a ring: a pay window is half an hour, so that is the ring's whole. */
const RING_WHOLE_MS = 30 * 60_000;

/**
 * The top of the working screen, in the mark's orange: the one order that waits on the trader soonest — what to do, in
 * a sentence as large as the page's figures, the time left on the robot's visor, and the way into it. With nothing
 * waiting, the field says so and where orders come from.
 */
export function MoveField({ home, now, calm }: { home: TraderHome; now: number; calm: { title: string; body: string } }) {
  const due = home.active
    .filter((o) => o.stage === 'YOUR_TURN')
    .slice()
    .sort((a, b) => (a.dueBy ? Date.parse(a.dueBy) : Infinity) - (b.dueBy ? Date.parse(b.dueBy) : Infinity));
  const first = due[0];
  // ADR 0032: nothing is this trader's to do, but people wait for a trader's price on one of its sides — that is the move.
  const demand = home.waiting.slice().sort((a, b) => b.count - a.count)[0];
  if (!first && demand) {
    const theyBuy = demand.side === 'SELL_USDT';
    return (
      <section className={`${shell.brandField} ${styles.field}`} aria-labelledby="move-title" data-demand="">
        <FieldHalo sun />
        <div className={styles.fieldText}>
          <p className={styles.fieldEyebrow}>
            <span className={styles.liveDot} aria-hidden="true" />
            {demand.count === 1 ? 'A client is waiting' : `${demand.count} clients are waiting`} · no trader has a price
          </p>
          <h2 id="move-title" className={styles.fieldTitle}>
            {demand.aboutUsdt ? `People want to ${theyBuy ? 'buy' : 'sell'} ${usdt(demand.aboutUsdt)}` : `People want to ${theyBuy ? 'buy' : 'sell'} USDT`}
          </h2>
          <p className={styles.fieldSub}>
            Nobody on INRP2P has a price for them right now. Put your {theyBuy ? 'Sell' : 'Buy'} USDT price on and the next deal comes to you —
            {home.available ? ' you are online.' : ' go online first.'}
          </p>
          <div className={styles.fieldActions}>
            <Link className={styles.onField} href="/traders/setup">
              Set my price
              <ArrowIcon />
            </Link>
            <Link className={styles.offField} href="/traders/orders">
              All orders
            </Link>
          </div>
        </div>
      </section>
    );
  }
  if (!first) {
    return (
      <section className={`${shell.brandField} ${styles.field}`} aria-labelledby="move-title" data-calm="">
        <FieldHalo sun />
        <div className={styles.fieldText}>
          <p className={styles.fieldEyebrow}>{home.available ? 'Online · nothing waits on you' : 'Offline'}</p>
          <h2 id="move-title" className={styles.fieldTitle}>
            {calm.title}
          </h2>
          <p className={styles.fieldSub}>{calm.body}</p>
          <div className={styles.fieldActions}>
            <Link className={styles.onField} href="/traders/orders">
              All orders
              <ArrowIcon />
            </Link>
          </div>
        </div>
      </section>
    );
  }
  const buy = first.side === 'BUY_USDT';
  const left = first.dueBy ? Math.max(0, Date.parse(first.dueBy) - now) : null;
  const share = left === null ? 1 : Math.min(1, Math.max(0.04, left / RING_WHOLE_MS));
  return (
    <section className={`${shell.brandField} ${styles.field}`} aria-labelledby="move-title">
      <FieldHalo />
      <div className={styles.fieldText}>
        <p className={styles.fieldEyebrow}>
          Your move · {due.length} {due.length === 1 ? 'order' : 'orders'}
        </p>
        <h2 id="move-title" className={styles.fieldTitle}>
          {buy ? `Pay ${inr(first.youOwe ?? first.inr)} to the seller` : `Send ${usdt(first.youOwe ?? first.usdt)} to escrow`}
        </h2>
        <p className={styles.fieldSub}>
          {buy ? `${usdt(first.usdt)} is locked for you in escrow` : `The buyer pays ${inr(first.inr)} once it is in`}
          <span className={styles.wide}>
            {' '}
            · <span className={styles.mono}>{first.ref}</span>
          </span>
        </p>
        <div className={styles.fieldActions}>
          <Link className={styles.onField} href={`/traders/orders/${first.ref}`}>
            Open the order
            <ArrowIcon />
          </Link>
          {due.length > 1 ? (
            <Link className={styles.offField} href="/traders/orders">
              All {due.length}
            </Link>
          ) : null}
        </div>
      </div>
      {left !== null ? (
        <span className={styles.ring} role="timer" aria-label={`${formatCountdown(left)} left to ${buy ? 'pay' : 'send'}`}>
          <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
            <circle className={styles.ringTrack} cx="60" cy="60" r="52" />
            <circle className={styles.ringArc} cx="60" cy="60" r="52" strokeDasharray="326.7" strokeDashoffset={326.7 * (1 - share)} />
          </svg>
          <span className={styles.ringText} aria-hidden="true">
            <b>{formatCountdown(left)}</b>
            <small>left to {buy ? 'pay' : 'send'}</small>
          </span>
        </span>
      ) : null}
    </section>
  );
}

/** One balance: the figure, a bar of what is free against what open orders hold, and the held part in words. */
function Balance({ label, currency, available, held }: { label: string; currency: 'INR' | 'USDT'; available: string | null; held: string | null }) {
  const a = available ? Number(available) : 0;
  const h = held ? Number(held) : 0;
  const share = a + h > 0 ? a / (a + h) : 0;
  return (
    <div className={styles.balance} data-quiet={available === null || undefined}>
      <span className={styles.balanceHead}>
        <span className={styles.balanceLabel}>{label}</span>
        <Coin currency={currency} size={24} />
      </span>
      <span className={styles.balanceFigure}>{available === null ? '—' : <Amount value={currency === 'INR' ? inr(available) : usdt(available)} />}</span>
      <span className={styles.meter} aria-hidden="true">
        <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
      </span>
      <span className={styles.balanceNote}>
        {available === null ? 'Not offered' : held && !isZero(held) ? `${currency === 'INR' ? inr(held) : usdt(held)} held for orders` : 'Nothing held'}
      </span>
    </div>
  );
}

/** What the trader can provide now, side by side with its move: rupees and USDT, each with what open orders hold. */
export function Balances({ home }: { home: TraderHome }) {
  const buy = home.blocks.find((b) => b.side === 'BUY_USDT');
  const sell = home.blocks.find((b) => b.side === 'SELL_USDT');
  return (
    <section className={`${shell.card} ${styles.balances}`} aria-label="Balances">
      <Balance label="INR available" currency="INR" available={buy?.available ?? null} held={buy?.held ?? null} />
      <Balance label="USDT available" currency="USDT" available={sell?.available ?? null} held={sell?.held ?? null} />
    </section>
  );
}

/** The Security Reserve at a glance: what is held, how much of it open deals lock, and the one deal it allows. */
export function ReserveTile({ home }: { home: TraderHome }) {
  const r = home.reserve!;
  const held = Number(r.balance);
  const locked = Number(r.locked);
  return (
    <section className={`${shell.card} ${styles.tile}`} aria-labelledby="reserve-title">
      <div className={styles.tileHead}>
        <span className={styles.tileIcon} aria-hidden="true">
          <ShieldIcon />
        </span>
        <Link className={shell.textAction} href="/traders/reserve">
          Manage
        </Link>
      </div>
      <h2 id="reserve-title" className={styles.tileLabel}>
        Security reserve
      </h2>
      <p className={styles.tileFigure}>
        <Amount value={usdt(r.balance)} />
      </p>
      <span className={styles.meter} data-tone="brand" aria-hidden="true">
        <span style={{ width: `${held > 0 ? Math.min(100, (locked / held) * 100).toFixed(1) : 0}%` }} />
      </span>
      <p className={styles.tileNote}>
        {usdt(r.locked).replace(' USDT', '')} locked for open deals.{home.limits ? ` One deal up to ${usdt(home.limits.maxDeal)}.` : ''}
      </p>
    </section>
  );
}

/** Where the trader's money settles: its registered account and wallet, verified, and what the network deposit holds. */
export function SettleTile({ home, network }: { home: TraderHome; network: TraderNetworkView | null }) {
  const reg = home.registered!;
  const verified = !home.issues.includes('DESTINATIONS_INACTIVE');
  const bank = /^(.*?)\s*(•+\s*\d{3,4})$/.exec(reg.bank);
  return (
    <section className={`${shell.card} ${styles.tile}`} aria-labelledby="settle-title">
      <div className={styles.tileHead}>
        <h2 id="settle-title" className={styles.tileLabel}>
          You settle through
        </h2>
        <Link className={shell.textAction} href="/traders/settlement">
          Manage
        </Link>
      </div>
      <ul className={styles.settle}>
        <li>
          <BankMark ifsc="" name={bank ? bank[1]! : reg.bank} size={30} />
          <span className={styles.settleText} title={reg.bank}>
            {bank ? bank[2]!.replace(/(•+)\s*/, '$1 ') : reg.bank}
          </span>
          {verified ? (
            <span className={styles.verified} role="img" aria-label="Verified">
              <CheckIcon />
            </span>
          ) : null}
        </li>
        <li>
          <Coin currency="USDT" size={30} />
          <span className={`${styles.settleText} ${styles.mono}`} title={reg.walletAddress}>
            {reg.wallet}
          </span>
          {verified ? (
            <span className={styles.verified} role="img" aria-label="Verified">
              <CheckIcon />
            </span>
          ) : null}
        </li>
      </ul>
      {network ? (
        <p className={styles.settleFoot}>
          <span>{network.mode === 'GASFREE' ? 'Network fees' : 'Network deposit'}</span>
          <Link href="/traders/network">{network.mode === 'GASFREE' ? 'GasFree' : trx(network.available)}</Link>
        </p>
      ) : null}
    </section>
  );
}
