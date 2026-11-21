import type { Direction } from '@inrp2p/kernel';
import { Rate } from '@inrp2p/kernel';
import { formatIstDateTime, formatIstTime, groupDigits } from '@inrp2p/ui/format';
import { formatRate } from '@inrp2p/ui/format';
import { GUIDES, RATE_TABLE } from '../../../../content/site.ts';
import { marketReading } from '../../../../server/market.ts';
import styles from './guide.module.css';

/** A whole number of minor units as a grouped decimal with two places (D-11: no Intl, no floating point). */
function decimal2(hundredths: bigint): string {
  const whole = hundredths / 100n;
  const cents = (hundredths % 100n).toString().padStart(2, '0');
  return `${groupDigits(whole.toString())}.${cents}`;
}

/** Rupees, to the paisa, that `usdt` whole USDT come to at `rateMicro` micro-rupees per USDT. */
const rupeesFor = (usdt: number, rateMicro: bigint): string => `₹${decimal2((BigInt(usdt) * rateMicro + 5_000n) / 10_000n)}`;

/** USDT, to the cent, that `inr` whole rupees buy at `rateMicro` micro-rupees per USDT. */
const usdtFor = (inr: number, rateMicro: bigint): string => `${decimal2((BigInt(inr) * 100_000_000n + rateMicro / 2n) / rateMicro)} USDT`;

/** The rate of a direction as the reading has it, or null. */
function rateOf(direction: Direction, reading: Awaited<ReturnType<typeof marketReading>>): Rate<'REFERENCE'> | null {
  const value = reading?.[direction];
  if (!value) return null;
  try {
    return Rate.parse(value, 'REFERENCE');
  } catch {
    return null;
  }
}

/**
 * Under a rate guide's lede: the market's rate as the page was opened, in the HTML itself — the figure the search was
 * for, readable before any script runs. Nothing is drawn without a fresh reference; the live card beside the robot
 * (MarketCard) keeps it current while the page is read.
 */
export async function RateLine({ direction }: { direction: Direction }) {
  const reading = await marketReading();
  const rate = rateOf(direction, reading);
  if (!reading || !rate) return null;
  return (
    <p className={styles.rateLine}>
      <i className={styles.live} aria-hidden="true" />
      <span className={styles.rateLabel}>{GUIDES.now.label}</span>
      <b className={styles.rateFigure} data-rate={rate.toDecimalString()}>
        {formatRate(rate)}
      </b>
      <span className={styles.rateUnit}>{GUIDES.now[direction]}</span>
      <time className={styles.rateAt} dateTime={reading.at.toISOString()}>
        {formatIstTime(reading.at)}
      </time>
    </p>
  );
}

/**
 * A rate guide's table: the amounts people search for ("100 USDT to INR") at the market's rate now, as a real table so
 * it reads the same to a person, a screen reader and a search engine. Absent without a fresh reference.
 */
export async function RateTable({ direction }: { direction: Direction }) {
  const reading = await marketReading();
  const rate = rateOf(direction, reading);
  if (!reading || !rate) return null;
  const copy = GUIDES.table[direction];
  const rows = RATE_TABLE[direction].map((amount) =>
    direction === 'SELL_USDT'
      ? { from: `${groupDigits(String(amount))} USDT`, to: rupeesFor(amount, rate.micro) }
      : { from: `₹${groupDigits(String(amount))}`, to: usdtFor(amount, rate.micro) },
  );
  return (
    <section className={styles.block} aria-labelledby="guide-table">
      <h2 id="guide-table" className={styles.blockTitle}>
        {copy.title}
      </h2>
      <div className={styles.tableCard}>
        <table className={styles.table}>
          <caption className={styles.tableCaption}>
            {formatRate(rate, { unit: true })} · {formatIstDateTime(reading.at)}
          </caption>
          <thead>
            <tr>
              <th scope="col">{copy.from}</th>
              <th scope="col">{copy.to}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.from}>
                <th scope="row">{row.from}</th>
                <td>{row.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.tableNote}>{GUIDES.table.note}</p>
      </div>
    </section>
  );
}
