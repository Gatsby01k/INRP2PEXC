import type { DeskStatus as Status } from '@inrp2p/db';
import styles from '../desk.module.css';

const WORDS: Record<Status, { label: string; tone: 'live' | 'paused' | 'neutral' }> = {
  LIVE: { label: 'Live', tone: 'live' },
  PAUSED: { label: 'Paused', tone: 'paused' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUSPENDED: { label: 'Suspended by INRP2P', tone: 'paused' },
};

/** The desk's status as a pill: a dot and its word — live beats gently, the way an open sign glows. */
export function DeskStatus({ status }: { status: Status }) {
  const w = WORDS[status];
  return (
    <span className={styles.status} data-tone={w.tone}>
      <span className={styles.statusDot} aria-hidden="true" />
      {w.label}
    </span>
  );
}

/** A deal's state in the desk's words. */
export function DealStatus({ state, yourMove, inReview = false }: { state: 'ASKING' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; yourMove: boolean; inReview?: boolean }) {
  // In review: a payment is disputed, or the client's USDT is going back — INRP2P has it (ADR 0020 §2.15).
  const [label, tone] =
    state === 'ASKING' ? ['Holding your price', 'neutral'] : state === 'COMPLETED' ? ['Completed', 'done'] : state === 'CANCELLED' ? ['Cancelled', 'neutral'] : inReview ? ['With INRP2P', 'paused'] : yourMove ? ['Your move', 'action'] : ['Waiting on client', 'paused'];
  return (
    <span className={styles.status} data-tone={tone}>
      <span className={styles.statusDot} aria-hidden="true" />
      {label}
    </span>
  );
}
