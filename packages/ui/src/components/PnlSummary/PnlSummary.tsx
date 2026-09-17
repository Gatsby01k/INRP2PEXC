import { divRound, formatMinorToDecimal, type Money } from '@inrp2p/kernel';
import { formatInr, formatUsdtHeadline } from '../../format/money.ts';
import { groupDigits } from '../../format/number.ts';
import styles from './PnlSummary.module.css';

export interface PnlSummaryProps {
  periodLabel: string;
  realizedMargin: Money<'INR'>;
  completedVolume: Money<'USDT'>;
  completedTrades: number;
  /** Open trades' expected margin — always separate, never added to realized. */
  openExpectedMargin: Money<'INR'>;
  openTrades: number;
}

/** Average margin per USDT to 4 dp, exact bigint with HALF_EVEN display rounding (FINANCIAL_INVARIANTS §4). */
export function averageMarginPerUsdt(margin: Money<'INR'>, volume: Money<'USDT'>): string {
  if (!volume.isPositive()) return '—';
  const negative = margin.isNegative();
  const abs = negative ? -margin.minor : margin.minor;
  // paise / micro-USDT → rupees per USDT scaled 10⁴: paise × 10⁸ / micro
  const scaled = divRound(abs * 100_000_000n, volume.minor, 'HALF_EVEN');
  const [whole = '0', frac = ''] = formatMinorToDecimal(scaled, 4).split('.');
  return `${negative ? '−' : ''}₹${groupDigits(whole)}.${frac}`;
}

export function PnlSummary(p: PnlSummaryProps) {
  return (
    <section className={styles.root} aria-label={`P&L ${p.periodLabel}`}>
      <h2 className={styles.period}>{p.periodLabel}</h2>
      <dl className={styles.realized}>
        <div className={styles.primary}>
          <dt>Realized gross margin</dt>
          <dd className="ix-num">{formatInr(p.realizedMargin, { sign: 'always' })}</dd>
        </div>
        <div>
          <dt>Completed volume</dt>
          <dd className="ix-num">{formatUsdtHeadline(p.completedVolume)}</dd>
        </div>
        <div>
          <dt>Average margin / USDT</dt>
          <dd className="ix-num">{averageMarginPerUsdt(p.realizedMargin, p.completedVolume)}</dd>
        </div>
        <div>
          <dt>Completed trades</dt>
          <dd className="ix-num">{p.completedTrades}</dd>
        </div>
      </dl>
      <div className={styles.expected}>
        <span className={styles.expectedLabel}>Open trades · expected, not realized</span>
        <span className="ix-num">
          {formatInr(p.openExpectedMargin, { sign: 'always' })} across {p.openTrades} open trade{p.openTrades === 1 ? '' : 's'}
        </span>
      </div>
    </section>
  );
}
