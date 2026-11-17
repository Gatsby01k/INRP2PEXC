import type { OrderStage } from '@inrp2p/traders';
import { StateRing, type RingState } from '../../_workspace/StateRing.tsx';
import styles from '../../_workspace/workspace.module.css';

const WORDS: Record<OrderStage, { label: string; tone: 'turn' | 'waiting' | 'progress' | 'hold' | 'done' | 'neutral'; ring: RingState }> = {
  OFFER: { label: 'New order', tone: 'turn', ring: 'turn' },
  HELD: { label: 'Held', tone: 'waiting', ring: 'lock' },
  AWAITING_FUNDING: { label: 'Waiting', tone: 'waiting', ring: 'wait' },
  YOUR_TURN: { label: 'Your move', tone: 'turn', ring: 'turn' },
  CHECKING_YOURS: { label: 'Checking', tone: 'progress', ring: 'check' },
  CHECKING_INRP2P: { label: 'Confirming', tone: 'progress', ring: 'check' },
  INRP2P_SENDING: { label: 'In progress', tone: 'progress', ring: 'check' },
  REVIEW: { label: 'Under review', tone: 'hold', ring: 'hold' },
  COMPLETED: { label: 'Completed', tone: 'done', ring: 'done' },
  CLOSED: { label: 'Closed', tone: 'neutral', ring: 'off' },
};

const CLOSED_WORDS: Record<string, string> = { DECLINED: 'Declined', EXPIRED: 'Expired', WITHDRAWN: 'Withdrawn', RELEASED: 'Released', CANCELLED: 'Cancelled' };

/** An order's state as a pill: its ring and its word, in the trader's terms — never colour alone. */
export function OrderPill({ stage, status, size = 'md' }: { stage: OrderStage; status: string; size?: 'md' | 'lg' }) {
  const known = WORDS[stage];
  const label = stage === 'CLOSED' ? (CLOSED_WORDS[status] ?? known.label) : known.label;
  return (
    <span className={styles.pill} data-tone={known.tone} data-size={size}>
      <StateRing state={known.ring} className={styles.pillIcon} />
      {label}
    </span>
  );
}
