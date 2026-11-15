import { StateRing, type RingState } from './StateRing.tsx';
import styles from './workspace.module.css';

/** A trade's lifecycle state in the client's words: what they are waiting for, not what the desk is doing. */
export const TRADE_STATUS: Record<string, { label: string; tone: 'waiting' | 'progress' | 'done' | 'neutral'; ring: RingState }> = {
  AWAITING_FIRST_LEG: { label: 'Awaiting funds', tone: 'waiting', ring: 'wait' },
  FIRST_LEG_DETECTED: { label: 'Verifying', tone: 'waiting', ring: 'check' },
  FIRST_LEG_CONFIRMED: { label: 'In progress', tone: 'progress', ring: 'check' },
  SETTLING: { label: 'In progress', tone: 'progress', ring: 'check' },
  PARTIALLY_SETTLED: { label: 'In progress', tone: 'progress', ring: 'check' },
  COMPLETED: { label: 'Completed', tone: 'done', ring: 'done' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', ring: 'off' },
};

/** The status of a trade as a pill: its ring and its word, never colour alone. A trade on hold says so first. */
export function StatusPill({ status, onHold = false, size = 'md' }: { status: string; onHold?: boolean; size?: 'md' | 'lg' }) {
  const known = TRADE_STATUS[status] ?? { label: status, tone: 'neutral' as const, ring: 'off' as const };
  const held = onHold && known.tone !== 'done' && known.tone !== 'neutral';
  const tone = held ? 'hold' : known.tone;
  return (
    <span className={styles.pill} data-tone={tone} data-size={size}>
      <StateRing state={held ? 'hold' : known.ring} className={styles.pillIcon} />
      {held ? 'On hold' : known.label}
    </span>
  );
}
