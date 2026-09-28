import { EXPIRING_THRESHOLD_MS } from '@inrp2p/ui';
import { formatCountdown, formatIstTime } from '@inrp2p/ui/format';
import { ClockIcon } from '../_workspace/icons.tsx';
import styles from './exchange.module.css';

/** The time a quote is still held, as the ticket and the robot's panel both show it. */
export function HeldFor({ expiresAt, now }: { expiresAt: Date; now: number }) {
  const remaining = Math.max(0, expiresAt.getTime() - now);
  return (
    <span className={styles.countdown} data-state={remaining <= EXPIRING_THRESHOLD_MS ? 'expiring' : 'held'} role="timer" aria-live="off">
      <ClockIcon />
      <span>
        Held <span className={styles.countdownTime}>{formatCountdown(remaining)}</span>
      </span>
      <span className="ix-visually-hidden">, until {formatIstTime(expiresAt)}</span>
    </span>
  );
}
