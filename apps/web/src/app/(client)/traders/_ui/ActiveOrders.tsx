import Link from 'next/link';
import type { OrderSummary } from '@inrp2p/traders';
import { ChevronIcon } from '../../_workspace/icons.tsx';
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

/** Orders held or in progress, one line each: what, how much, where it stands, what is next. */
export function ActiveOrders({ orders }: { orders: readonly OrderSummary[] }) {
  if (orders.length === 0) return null;
  return (
    <section className={shell.card} aria-labelledby="active-orders-title">
      <div className={shell.cardHead}>
        <h2 id="active-orders-title" className={shell.cardTitle}>
          Active orders
        </h2>
        <Link className={shell.textAction} href="/traders/orders">
          All orders
          <ChevronIcon />
        </Link>
      </div>
      <ul className={styles.orderList}>
        {orders.map((o) => (
          <li key={o.ref}>
            <Link className={styles.orderRow} href={`/traders/orders/${o.ref}`} data-due={o.stage === 'YOUR_TURN' || o.stage === 'OFFER' || undefined}>
              <span className={styles.sideMark} data-side={o.side}>
                {o.side === 'BUY_USDT' ? 'Buy' : 'Sell'}
              </span>
              <span className={styles.orderText}>
                <span className={styles.orderMain}>{usdt(o.usdt)}</span>
                <span className={`${styles.orderMeta} ${styles.refWhole}`}>{o.ref}</span>
              </span>
              <span className={styles.orderStep}>{nextStepText(o)}</span>
              <span className={styles.next}>
                <OrderPill stage={o.stage} status={o.status} />
                <ChevronIcon className={styles.chevron} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
