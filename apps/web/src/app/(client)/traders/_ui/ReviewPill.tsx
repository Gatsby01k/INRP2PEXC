import type { ReviewState } from '@inrp2p/traders';
import styles from '../traders.module.css';

const WORDS: Record<ReviewState, string> = { PENDING_REVIEW: 'Pending review', VERIFIED: 'Verified', REJECTED: 'Rejected', ARCHIVED: 'Archived' };
const TONE: Record<ReviewState, string> = { PENDING_REVIEW: 'waiting', VERIFIED: 'done', REJECTED: 'neutral', ARCHIVED: 'neutral' };

/** Where the desk's review of a bank account or wallet stands. Only a verified one is ever settled through. */
export function ReviewPill({ state }: { state: ReviewState }) {
  return (
    <span className={styles.pill} data-tone={TONE[state]}>
      <span className={styles.pillDot} aria-hidden="true" />
      {WORDS[state]}
    </span>
  );
}
