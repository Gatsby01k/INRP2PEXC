import type { OrderStage } from '@inrp2p/traders';
import styles from '../traders.module.css';

const WORDS: Record<OrderStage, { label: string; tone: 'action' | 'waiting' | 'done' | 'neutral' }> = {
  OFFER: { label: 'New order', tone: 'action' },
  HELD: { label: 'Held', tone: 'waiting' },
  AWAITING_FUNDING: { label: 'Waiting', tone: 'waiting' },
  YOUR_TURN: { label: 'Your turn', tone: 'action' },
  CHECKING_YOURS: { label: 'Checking', tone: 'waiting' },
  CHECKING_INRP2P: { label: 'Confirming', tone: 'waiting' },
  INRP2P_SENDING: { label: 'In progress', tone: 'waiting' },
  REVIEW: { label: 'Under review', tone: 'waiting' },
  COMPLETED: { label: 'Completed', tone: 'done' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

const CLOSED_WORDS: Record<string, string> = { DECLINED: 'Declined', EXPIRED: 'Expired', WITHDRAWN: 'Withdrawn', RELEASED: 'Released', CANCELLED: 'Cancelled' };

/** An order's state as a pill: a dot and its word, in the trader's terms — never colour alone. */
export function OrderPill({ stage, status, size = 'md' }: { stage: OrderStage; status: string; size?: 'md' | 'lg' }) {
  const known = WORDS[stage];
  const label = stage === 'CLOSED' ? (CLOSED_WORDS[status] ?? known.label) : known.label;
  return (
    <span className={styles.pill} data-tone={known.tone} data-size={size}>
      <span className={styles.pillDot} aria-hidden="true" />
      {label}
    </span>
  );
}
