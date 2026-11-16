import Link from 'next/link';
import type { OrderSummary } from '@inrp2p/traders';
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
      return 'Waiting for the other side’s funds';
    case 'YOUR_TURN':
      return buy ? `Send ${o.youOwe ? inr(o.youOwe) : 'your INR'}` : `Send ${o.youOwe ? usdt(o.youOwe) : 'your USDT'}`;
    case 'CHECKING_YOURS':
      return buy ? 'Your payment is being checked' : 'Your USDT is becoming final';
    case 'REVIEW':
      return 'The desk is reviewing a transfer';
    case 'INRP2P_SENDING':
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
const LANES: readonly { key: string; title: string; ring: RingState; stages: readonly string[] }[] = [
  { key: 'turn', title: 'Your move', ring: 'turn', stages: ['OFFER', 'YOUR_TURN'] },
  { key: 'wait', title: 'Waiting for the other side', ring: 'wait', stages: ['HELD', 'AWAITING_FUNDING'] },
  { key: 'check', title: 'Being checked', ring: 'check', stages: ['CHECKING_YOURS', 'CHECKING_INRP2P', 'INRP2P_SENDING', 'REVIEW'] },
];

/**
 * Orders held or in progress as a queue in lanes — what waits for the trader first — one card each: the pair, the
 * side and how much, where it stands, and what is next. A lane with nothing in it is not drawn.
 */
export function ActiveOrders({ orders }: { orders: readonly OrderSummary[] }) {
  if (orders.length === 0) return null;
  const known = new Set(LANES.flatMap((l) => l.stages));
  const lanes = LANES.map((l) => ({ ...l, orders: orders.filter((o) => l.stages.includes(o.stage) || (l.key === 'check' && !known.has(o.stage))) })).filter((l) => l.orders.length > 0);
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
      <div className={styles.lanes} data-count={lanes.length}>
        {lanes.map((lane) => (
          <div key={lane.key} className={styles.lane} data-lane={lane.key}>
            <h3 className={styles.laneHead}>
              <StateRing state={lane.ring} className={styles.laneRing} />
              {lane.title}
              <span className={styles.laneCount}>{lane.orders.length}</span>
            </h3>
            <ul className={styles.laneList}>
              {lane.orders.map((o) => {
                const due = o.stage === 'YOUR_TURN' || o.stage === 'OFFER';
                return (
                  <li key={o.ref}>
                    <Link className={styles.orderCard} href={`/traders/orders/${o.ref}`} data-due={due || undefined}>
                      <span className={styles.orderTop}>
                        <PairCoin side={o.side} />
                        <span className={styles.orderText}>
                          <span className={styles.sideWord} data-side={o.side}>
                            {o.side === 'BUY_USDT' ? 'Buy' : 'Sell'}
                          </span>
                          <span className={styles.orderFigure}>{usdt(o.usdt)}</span>
                        </span>
                        <OrderPill stage={o.stage} status={o.status} />
                      </span>
                      <span className={styles.orderAct}>
                        <span>{nextStepText(o)}</span>
                        <span className={styles.orderGo} aria-hidden="true">
                          {due ? <ArrowIcon /> : <ChevronIcon />}
                        </span>
                      </span>
                      <span className={`${styles.orderRef} ${styles.refWhole}`}>{o.ref}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
