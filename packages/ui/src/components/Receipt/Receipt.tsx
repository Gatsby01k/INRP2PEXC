import type { ClientRate, Direction, Money } from '@inrp2p/kernel';
import { formatInr, formatRate, formatUsdt } from '../../format/money.ts';
import { formatDuration, formatIstDateTime, formatIstTime } from '../../format/time.ts';
import { ArcMotif } from '../ArcMotif/ArcMotif.tsx';
import styles from './Receipt.module.css';

export interface ReceiptLeg {
  amount: Money<'INR'>;
  /** Full UTR on the client's own receipt (D-09). */
  utr: string;
  confirmedAt: Date;
}

export interface ReceiptProps {
  tradeRef: string;
  direction: Direction;
  base: Money<'USDT'>;
  inr: Money<'INR'>;
  rate: ClientRate;
  network: 'TRC20';
  txHash: string;
  legs: readonly ReceiptLeg[];
  fees?: Money<'INR'>;
  acceptedAt: Date;
  completedAt: Date;
}

/** Settlement receipt from immutable trade data. Warm white, near-black, restrained orange; prints in grayscale. */
export function Receipt(p: ReceiptProps) {
  const sell = p.direction === 'SELL_USDT';
  return (
    <article className={styles.paper} aria-label={`Settlement receipt ${p.tradeRef}`}>
      <header className={styles.head}>
        <div>
          <p className={styles.brand}>INRP2P Exchange</p>
          <p className={styles.docType}>Settlement receipt</p>
        </div>
        <p className={styles.settled}>
          <ArcMotif completed={3} size={28} tone="brand" />
          <span>SETTLED</span>
        </p>
      </header>

      <dl className={styles.facts}>
        <div>
          <dt>Trade ID</dt>
          <dd className="ix-num">{p.tradeRef}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd className="ix-num">{formatIstDateTime(p.acceptedAt)}</dd>
        </div>
        <div>
          <dt>Direction</dt>
          <dd>{sell ? 'Sell USDT · receive INR' : 'Buy USDT · pay INR'}</dd>
        </div>
        <div>
          <dt>{sell ? 'USDT sold' : 'USDT received'}</dt>
          <dd className="ix-num">{formatUsdt(p.base, { precision: 'exact' })}</dd>
        </div>
        <div>
          <dt>{sell ? 'INR received' : 'INR paid'}</dt>
          <dd className="ix-num">{formatInr(p.inr, { fraction: 'always' })}</dd>
        </div>
        <div>
          <dt>Executed rate</dt>
          <dd className="ix-num">{formatRate(p.rate, { unit: true })}</dd>
        </div>
        <div>
          <dt>Network</dt>
          <dd>USDT · {p.network}</dd>
        </div>
        <div className={styles.wide}>
          <dt>Blockchain tx</dt>
          <dd className={styles.mono}>{p.txHash}</dd>
        </div>
        <div>
          <dt>Fees</dt>
          <dd className="ix-num">{p.fees ? formatInr(p.fees, { fraction: 'always' }) : 'None'}</dd>
        </div>
        <div>
          <dt>Settlement duration</dt>
          <dd>{formatDuration(p.completedAt.getTime() - p.acceptedAt.getTime())}</dd>
        </div>
      </dl>

      <table className={styles.legs}>
        <caption className={styles.legsCaption}>INR settlement</caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">UTR</th>
            <th scope="col">Confirmed</th>
            <th scope="col" className={styles.right}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {p.legs.map((l, i) => (
            <tr key={l.utr}>
              <td className="ix-num">{i + 1}</td>
              <td className={styles.mono}>{l.utr}</td>
              <td className="ix-num">{formatIstTime(l.confirmedAt)}</td>
              <td className={`${styles.right} ix-num`}>{formatInr(l.amount, { fraction: 'always' })}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              Total
            </th>
            <td className={`${styles.right} ix-num`}>{formatInr(p.inr, { fraction: 'always' })}</td>
          </tr>
        </tfoot>
      </table>

      <footer className={styles.foot}>
        <span className="ix-num">Completed {formatIstDateTime(p.completedAt)}</span>
        <span>Generated from the immutable trade record.</span>
      </footer>
    </article>
  );
}
