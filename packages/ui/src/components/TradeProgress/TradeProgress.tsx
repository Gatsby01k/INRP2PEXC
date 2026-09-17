import type { Direction } from '@inrp2p/kernel';
import { cx } from '../../cx.ts';
import { formatIstTime } from '../../format/time.ts';
import styles from './TradeProgress.module.css';

export type StageStatus = 'done' | 'current' | 'pending' | 'exception';

export interface TradeStage {
  status: StageStatus;
  at?: Date;
  detail?: string;
}

const LABELS: Record<Direction, readonly [string, string, string, string]> = {
  SELL_USDT: ['Quote accepted', 'USDT received', 'INR payout', 'Completed'],
  BUY_USDT: ['Quote accepted', 'INR received', 'USDT sent', 'Completed'],
};

const GLYPH: Record<StageStatus, string> = { done: '●', current: '◔', pending: '○', exception: '!' };
const SR: Record<StageStatus, string> = { done: 'done', current: 'in progress', pending: 'not started', exception: 'exception' };

/** Four structural stages (brief "Trade screen"); status carries glyph + text, not colour alone. */
export function TradeProgress({ direction, stages }: { direction: Direction; stages: readonly [TradeStage, TradeStage, TradeStage, TradeStage] }) {
  return (
    <ol className={styles.root} aria-label="Trade progress">
      {stages.map((s, i) => (
        <li key={LABELS[direction][i]} className={cx(styles.stage, styles[s.status])} aria-current={s.status === 'current' ? 'step' : undefined}>
          <span className={styles.glyph} aria-hidden="true">
            {GLYPH[s.status]}
          </span>
          <span className={styles.label}>
            {LABELS[direction][i]}
            <span className="ix-visually-hidden">, {SR[s.status]}</span>
          </span>
          <span className={cx(styles.detail, 'ix-num')}>{s.detail ?? (s.at ? formatIstTime(s.at, { suffix: false }) : s.status === 'current' ? 'in progress' : '')}</span>
        </li>
      ))}
    </ol>
  );
}
