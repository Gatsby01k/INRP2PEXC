'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { OrderSummary } from '@inrp2p/traders';
import { formatCountdown } from '@inrp2p/ui/format';
import { Amount } from '../../../../components/Amount.tsx';
import { ArrowIcon, ChevronIcon } from '../../_workspace/icons.tsx';
import { PairCoin } from '../../_workspace/PairCoin.tsx';
import { StateRing, type RingState } from '../../_workspace/StateRing.tsx';
import { OrderPill } from './OrderPill.tsx';
import { inr, usdt } from './format.ts';
import shell from '../../shell.module.css';
import styles from '../traders.module.css';

/** What the trader has to do next on an order — or that it has nothing to do. */
export function nextStepText(o: OrderSummary): string {
  const buy = o.side === 'BUY_USDT';
  switch (o.stage) {
    case 'OFFER':
      return 'Accept or decline';
    case 'HELD':
      return 'Held while the trade is confirmed';
    case 'AWAITING_FUNDING':
      // A P2P deal says who is doing what: the buyer paying the trader's rupees, or the seller filling the escrow.
      if (!buy && o.p2pStep === 'PAY') return `The buyer is paying ${inr(o.inr)}`;
      if (buy && o.p2pStep === 'ESCROW') return 'The seller is sending USDT';
      return 'Waiting for the other side’s funds';
    case 'YOUR_TURN':
      return buy ? `Send ${o.youOwe ? inr(o.youOwe) : 'your INR'}` : `Send ${o.youOwe ? usdt(o.youOwe) : 'your USDT'}`;
    case 'CHECKING_YOURS':
      if (buy && o.p2pStep === 'CONFIRM') return `The seller is confirming your ${inr(o.inr)}`;
      return buy ? 'Your payment is being checked' : 'Your USDT is becoming final';
    case 'REVIEW':
      return 'The desk is reviewing a transfer';
    case 'INRP2P_SENDING':
      if (buy && o.p2pStep === 'RELEASE') return 'USDT is on its way to your wallet';
      return buy ? 'INRP2P is sending your USDT' : 'INRP2P is paying your INR';
    case 'CHECKING_INRP2P':
      return 'INRP2P’s payment is being confirmed';
    case 'COMPLETED':
      return 'Completed';
    default:
      return o.closeNote ?? 'Closed';
  }
}

/** The queue's three lanes, in the order a trader reads them: what waits for them, what waits for the other side, what is being checked. */
const LANES: readonly { key: string; title: string; short: string; ring: RingState; stages: readonly string[] }[] = [
  { key: 'turn', title: 'Your move', short: 'Your move', ring: 'turn', stages: ['OFFER', 'YOUR_TURN'] },
  { key: 'wait', title: 'Waiting for the other side', short: 'Waiting', ring: 'wait', stages: ['HELD', 'AWAITING_FUNDING'] },
  { key: 'check', title: 'Being checked', short: 'Checking', ring: 'check', stages: ['CHECKING_YOURS', 'CHECKING_INRP2P', 'INRP2P_SENDING', 'REVIEW'] },
];

/** Under the card, beside its reference: the one fact about where the money is, in a few words. */
function footNote(o: OrderSummary): string {
  const buy = o.side === 'BUY_USDT';
  switch (o.stage) {
    case 'YOUR_TURN':
      return buy ? 'From your own account' : 'TRC20';
    case 'AWAITING_FUNDING':
      return !buy && o.p2pStep === 'PAY' ? 'Your USDT is in escrow' : buy ? 'Nothing to pay yet' : 'Nothing to send yet';
    case 'HELD':
      return 'Not started';
    case 'CHECKING_YOURS':
      return buy ? 'Paid from your account' : 'Becoming final';
    case 'INRP2P_SENDING':
    case 'CHECKING_INRP2P':
      return buy ? 'To your wallet' : 'To your bank';
    case 'REVIEW':
      return 'Desk review';
    default:
      return '';
  }
}

/** How many cards a lane shows before it says how many more there are. */
const LANE_CAP = 3;

/**
 * Orders held or in progress as a queue in three lanes — what waits for the trader, what waits for the other side, what
 * is being checked — one card each: the pair, the side and how much, the time or state at its corner, the next step as
 * a bar to press, and the reference with one fact under it. A lane shows its first three; the rest are a link away.
 */
export function ActiveOrders({ orders, now }: { orders: readonly OrderSummary[]; now: number }) {
  const known = new Set(LANES.flatMap((l) => l.stages));
  const lanes = LANES.map((l) => ({ ...l, orders: orders.filter((o) => l.stages.includes(o.stage) || (l.key === 'check' && !known.has(o.stage))) })).filter((l) => l.orders.length > 0);
  // On a phone the lanes are one at a time, under a switch: the trader's own move first.
  const [picked, setPicked] = useState<string | null>(null);
  const shown = lanes.find((l) => l.key === picked)?.key ?? lanes[0]?.key;
  if (orders.length === 0) return null;
  return (
    <section className={styles.queue} aria-labelledby="active-orders-title">
      <div className={styles.queueHead}>
        <h2 id="active-orders-title" className={styles.queueTitle}>
          Active orders <span className={styles.queueCount}>· {orders.length}</span>
        </h2>
        <Link className={shell.textAction} href="/traders/orders">
          All orders
          <ChevronIcon />
        </Link>
      </div>
      <div className={styles.laneTabs} role="group" aria-label="Show orders">
        {lanes.map((lane) => (
          <button key={lane.key} type="button" aria-pressed={lane.key === shown} onClick={() => setPicked(lane.key)}>
            {lane.short} · {lane.orders.length}
          </button>
        ))}
      </div>
      <div className={styles.lanes} data-count={lanes.length}>
        {lanes.map((lane) => (
          <div key={lane.key} className={styles.lane} data-lane={lane.key} data-shown={lane.key === shown || undefined}>
            <h3 className={styles.laneHead}>
              <StateRing state={lane.ring} className={styles.laneRing} />
              {lane.title}
              <span className={styles.laneCount}>{lane.orders.length}</span>
            </h3>
            <ul className={styles.laneList}>
              {lane.orders.slice(0, LANE_CAP).map((o) => {
                const due = o.stage === 'YOUR_TURN' || o.stage === 'OFFER';
                const left = o.dueBy ? Date.parse(o.dueBy) - now : null;
                return (
                  <li key={o.ref}>
                    <Link className={styles.orderCard} href={`/traders/orders/${o.ref}`} data-due={due || undefined}>
                      <span className={styles.orderTop}>
                        <PairCoin side={o.side} />
                        <span className={styles.orderText}>
                          <span className={styles.sideWord} data-side={o.side}>
                            {o.side === 'BUY_USDT' ? 'Buy' : 'Sell'}
                          </span>
                          <span className={styles.orderFigure}>
                            <Amount value={usdt(o.usdt)} />
                          </span>
                        </span>
                        {left !== null && lane.key !== 'check' ? (
                          // The time is the corner's whole message: a lit pill when it is the trader's, a quiet one when not.
                          <span className={styles.timeChip} data-tone={due ? 'turn' : 'wait'} role="timer" aria-label={`${formatCountdown(Math.max(0, left))} left`}>
                            {due ? <span className={styles.timeDot} aria-hidden="true" /> : <StateRing state="wait" className={styles.timeRing} />}
                            {due ? formatCountdown(Math.max(0, left)) : `${Math.max(1, Math.ceil(left / 60_000))} min`}
                          </span>
                        ) : (
                          <OrderPill stage={o.stage} status={o.status} />
                        )}
                      </span>
                      <span className={styles.orderAct}>
                        <span>{nextStepText(o)}</span>
                        <span className={styles.orderGo} aria-hidden="true">
                          {due ? <ArrowIcon /> : <ChevronIcon />}
                        </span>
                      </span>
                      <span className={styles.orderFoot}>
                        <span className={`${styles.orderRef} ${styles.refWhole}`}>{o.ref}</span>
                        <span>{footNote(o)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {lane.orders.length > LANE_CAP ? (
              <Link className={styles.laneMore} data-lane={lane.key} href="/traders/orders">
                {lane.orders.length - LANE_CAP} more{lane.key === 'turn' ? ' waiting for you' : ''}
                <ChevronIcon />
              </Link>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
