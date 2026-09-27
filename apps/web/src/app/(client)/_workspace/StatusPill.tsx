import { CheckIcon, ClockIcon, PauseIcon } from './icons.tsx';
import styles from './workspace.module.css';

/** A trade's lifecycle state in the client's words: what they are waiting for, not what the desk is doing. */
export const TRADE_STATUS: Record<string, { label: string; tone: 'waiting' | 'progress' | 'done' | 'neutral' }> = {
  AWAITING_FIRST_LEG: { label: 'Waiting', tone: 'waiting' },
  FIRST_LEG_DETECTED: { label: 'Verifying', tone: 'waiting' },
  FIRST_LEG_CONFIRMED: { label: 'In progress', tone: 'progress' },
  SETTLING: { label: 'In progress', tone: 'progress' },
  PARTIALLY_SETTLED: { label: 'In progress', tone: 'progress' },
  COMPLETED: { label: 'Completed', tone: 'done' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** The status of a trade as a pill: a glyph and its word, never colour alone. A trade on hold says so first. */
export function StatusPill({ status, onHold = false }: { status: string; onHold?: boolean }) {
  const known = TRADE_STATUS[status] ?? { label: status, tone: 'neutral' as const };
  const held = onHold && known.tone !== 'done' && known.tone !== 'neutral';
  const tone = held ? 'hold' : known.tone;
  return (
    <span className={styles.pill} data-tone={tone}>
      {tone === 'done' ? <CheckIcon className={styles.pillIcon} /> : tone === 'hold' ? <PauseIcon className={styles.pillIcon} /> : tone === 'neutral' ? null : <ClockIcon className={styles.pillIcon} />}
      {held ? 'On hold' : known.label}
    </span>
  );
}
