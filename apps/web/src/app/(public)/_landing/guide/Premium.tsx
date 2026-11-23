import { Rate } from '@inrp2p/kernel';
import { formatIstTime, formatRate, groupDigits } from '@inrp2p/ui/format';
import { ACTIONS, GUIDES } from '../../../../content/site.ts';
import { PREMIUM_LICENSE_URL, type PremiumDay, premiumReading } from '../../../../server/premium.ts';
import { extraRupees, formatDay, formatPremium, toPaisa } from '../../../../server/premium-math.ts';
import { appOrigin } from '../../../../server/site.ts';
import { PREMIUM_CSV_PATH } from '../../../../server/surface.ts';
import styles from './guide.module.css';

/** The amount the "over the dollar rate" figure is worked out on: USDT worth this many dollars. */
const EXTRA_DOLLARS = 1_000;
/** The days the table lists, newest first; the chart and the CSV carry every day there is. */
const TABLE_DAYS = 14;

const rupees = (micro: bigint): string => formatRate(Rate.ofMicro(toPaisa(micro), 'REFERENCE'));

function signedRupees(whole: bigint): string {
  const abs = whole < 0n ? -whole : whole;
  return `${whole < 0n ? '−' : '+'}₹${groupDigits(abs.toString())}`;
}

/**
 * Under the premium page's lede: the premium now, in the HTML itself — the figure a search for India's USDT premium is
 * for, readable before any script runs. Nothing is drawn without a fresh market rate and a dollar to measure it against.
 */
export async function PremiumLine() {
  const reading = await premiumReading();
  const now = reading?.now;
  if (!now) return null;
  return (
    <p className={styles.rateLine}>
      <i className={styles.live} aria-hidden="true" />
      <span className={styles.rateLabel}>{GUIDES.premium.now}</span>
      <b className={`${styles.rateFigure} ${styles.premiumFigure}`} data-premium={now.hundredths.toString()}>
        {formatPremium(now.hundredths)}
      </b>
      <span className={styles.rateUnit}>{GUIDES.premium.over}</span>
      <time className={styles.rateAt} dateTime={now.at.toISOString()}>
        {formatIstTime(now.at)}
      </time>
    </p>
  );
}

/** The days as bars, zero at the foot (or across the middle, should the premium ever go under the dollar). */
function Chart({ days }: { days: readonly PremiumDay[] }) {
  const values = days.map((d) => Number(d.hundredths));
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const width = 100;
  const height = 40;
  const step = width / days.length;
  const bar = Math.max(step * 0.62, 0.4);
  const zero = (top / span) * height;
  const high = days.reduce((a, b) => (b.hundredths > a.hundredths ? b : a));
  const low = days.reduce((a, b) => (b.hundredths < a.hundredths ? b : a));
  const first = days[0]!;
  const last = days[days.length - 1]!;
  return (
    <figure className={styles.premiumChart}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${GUIDES.premium.chart}: ${formatDay(first.day, true)} to ${formatDay(last.day, true)}, high ${formatPremium(high.hundredths)}, low ${formatPremium(low.hundredths)}`}
      >
        {days.map((d, i) => {
          const v = Number(d.hundredths);
          const h = Math.max((Math.abs(v) / span) * height, 0.3);
          return (
            <rect
              key={d.day}
              className={i === days.length - 1 ? styles.premiumBarLast : styles.premiumBar}
              x={i * step + (step - bar) / 2}
              y={v >= 0 ? zero - h : zero}
              width={bar}
              height={h}
              rx={Math.min(bar / 2, 0.8)}
            />
          );
        })}
      </svg>
      <figcaption className={styles.premiumAxis}>
        <span>{formatDay(first.day)}</span>
        <span>
          {GUIDES.premium.chart} · ↑ {formatPremium(high.hundredths)} · ↓ {formatPremium(low.hundredths)}
        </span>
        <span>{formatDay(last.day)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * The premium page's figures, after its first screen: the premium now with what it is made of — USDT in India, the
 * dollar, and what the difference comes to on a round amount — then every recorded day as a chart and the last fortnight
 * as a table, how it is measured, and the CSV to cite it from. All of it from the market's reference and the ECB; nothing
 * is drawn that has no figure behind it.
 */
export async function PremiumBoard() {
  const reading = await premiumReading();
  if (!reading) return null;
  const copy = GUIDES.premium;
  const { now, days } = reading;
  const recent = [...days].reverse().slice(0, TABLE_DAYS);
  return (
    <section className={styles.block} aria-labelledby="premium-title">
      <h2 id="premium-title" className={styles.blockTitle}>
        {copy.title}
      </h2>
      <div className={styles.premiumCard}>
        {now ? (
          <dl className={styles.premiumFacts}>
            <div className={styles.premiumLead}>
              <dt>{copy.now}</dt>
              <dd>{formatPremium(now.hundredths)}</dd>
              <small>{copy.over}</small>
            </div>
            <div>
              <dt>{copy.usdt}</dt>
              <dd>{rupees(now.usdtMicro)}</dd>
              <small>{copy.usdtNote}</small>
            </div>
            <div>
              <dt>{copy.dollar}</dt>
              <dd>{rupees(now.dollar.micro)}</dd>
              <small>
                {copy.dollarNote} · {formatDay(now.dollar.date)}
              </small>
            </div>
            <div>
              <dt>{copy.extra}</dt>
              <dd>{signedRupees(extraRupees(now.usdtMicro, now.dollar.micro, EXTRA_DOLLARS))}</dd>
              <small>{copy.extraNote}</small>
            </div>
          </dl>
        ) : null}

        {days.length > 1 ? <Chart days={days} /> : null}

        {recent.length > 0 ? (
          <table className={`${styles.table} ${styles.premiumTable}`}>
            <caption className={styles.tableCaption}>{copy.table.caption}</caption>
            <thead>
              <tr>
                <th scope="col">{copy.table.day}</th>
                <th scope="col">{copy.table.usdt}</th>
                <th scope="col">{copy.table.dollar}</th>
                <th scope="col">{copy.table.premium}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((d) => (
                <tr key={d.day}>
                  <th scope="row">
                    <time dateTime={d.day}>{formatDay(d.day, true)}</time>
                  </th>
                  <td>{rupees(d.usdtMicro)}</td>
                  <td>{rupees(d.dollar.micro)}</td>
                  <td>{formatPremium(d.hundredths)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <div className={styles.premiumFoot}>
          <p className={styles.tableNote}>
            {copy.note} {copy.cite}{' '}
            {/* `rel="license"`: the licence as Creative Commons asks it to be marked, the same one the data names. */}
            <a className={styles.premiumCsv} href={PREMIUM_LICENSE_URL} rel="license">
              {copy.license}
            </a>
            .{' '}
            <a className={styles.premiumCsv} href={PREMIUM_CSV_PATH} download>
              {copy.csv}
            </a>
          </p>
          <a className={styles.premiumCta} href={`${appOrigin()}${ACTIONS[0]!.appPath}`}>
            {copy.sell}
          </a>
        </div>
      </div>
    </section>
  );
}
