import type { CurrencyCode, Direction } from '@inrp2p/kernel';
import { FLOW, FLOW_STATIONS, type FlowStation } from '../../../../content/site.ts';
import { ArrowIcon, CheckIcon, RupeeMark, StationIcon, type StationMark } from '../icons.tsx';
import { MASKS } from '../masks.ts';
import { ByDirection } from '../Story.tsx';
import { FlowStage } from './FlowStage.tsx';
import styles from './flow.module.css';

/**
 * The execution flow: the five stations every trade passes, drawn as one rail from the currency a client brings
 * to the currency they receive.
 *
 * Rendered on the server and complete without script: every station's words are in the list, in both
 * directions (Story.tsx shows one). One small island (FlowStage.tsx) turns it into a scene — it pins the rail
 * while the page scrolls, runs the trade along it, and fills in the ticket as each station is passed — and holds
 * the switch between directions. Everything it moves is drawing; nothing a reader needs is only in the motion.
 */

/** The ends of the rail are the two currencies, and each flips to the other when the direction does. */
const COIN_FACES: Partial<Record<FlowStation, readonly [front: CurrencyCode, back: CurrencyCode]>> = {
  source: ['INR', 'USDT'],
  destination: ['USDT', 'INR'],
};

const MARKS: Partial<Record<FlowStation, StationMark>> = { quote: 'quote', execution: 'execution', settlement: 'settlement' };

function CoinFace({ currency, back }: { currency: CurrencyCode; back?: boolean }) {
  return (
    <span className={back ? `${styles.face} ${styles.faceBack}` : styles.face}>
      {currency === 'INR' ? <RupeeMark className={styles.faceRupee} /> : <span className={styles.faceText}>{currency}</span>}
    </span>
  );
}

function Node({ station }: { station: FlowStation }) {
  const faces = COIN_FACES[station];
  if (faces) {
    return (
      <span className={styles.coin}>
        <span className={styles.coinBody}>
          <CoinFace currency={faces[0]} />
          <CoinFace currency={faces[1]} back />
        </span>
      </span>
    );
  }
  const mark = MARKS[station];
  return <span className={styles.disc}>{mark ? <StationIcon name={mark} /> : null}</span>;
}

/** "INR → USDT": the two ends' names for a direction, with a drawn arrow between them. */
function Ends({ direction }: { direction: Direction }) {
  const [source, destination] = [FLOW.stations[0]!, FLOW.stations.at(-1)!];
  return (
    <>
      {source.name[direction]}
      <ArrowIcon className={styles.endsArrow} />
      {destination.name[direction]}
    </>
  );
}

/** The trade as it travels: what it holds so far, and its status as it leaves the station it is at. */
function Ticket() {
  const { status, rows } = FLOW.ticket;
  return (
    <div className={styles.ticket} data-flow-ticket="" aria-hidden="true">
      <div className={styles.ticketHead}>
        <span className={styles.ticketEnds}>
          <span data-dir="BUY_USDT">
            <Ends direction="BUY_USDT" />
          </span>
          <span data-dir="SELL_USDT">
            <Ends direction="SELL_USDT" />
          </span>
        </span>
        <span className={styles.ticketStatus}>
          {FLOW_STATIONS.map((key) => (
            <span key={key} className={styles.status} data-when={key}>
              {status[key]}
            </span>
          ))}
        </span>
      </div>
      <dl className={styles.ticketRows}>
        {rows.map((row) => (
          <div key={row.label} className={styles.ticketRow} data-at={row.at}>
            <dt>{row.label}</dt>
            <dd>
              <span className={styles.pending} />
              {typeof row.value === 'string' ? (
                <span className={styles.value}>
                  <CheckIcon className={styles.check} />
                  {row.value}
                </span>
              ) : (
                <span className={`${styles.value} ${styles.mask}`}>{MASKS[row.value.mask]}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Flow() {
  const { eyebrow, heading, lede, direction, stations } = FLOW;
  const [source, destination] = [stations[0]!, stations.at(-1)!];
  return (
    <section id="execution-flow" className={styles.flow} aria-labelledby="flow-title" data-flow="">
      <div className={styles.stage}>
        <div className={styles.inner}>
          <header className={styles.head}>
            <div>
              <p className={styles.eyebrow}>{eyebrow}</p>
              <h2 id="flow-title" className={styles.title}>
                {heading}
              </h2>
            </div>
            <div className={styles.aside}>
              <p className={styles.lede}>{lede}</p>
              <FlowStage copy={direction} ends={{ from: source.name, to: destination.name }} />
            </div>
          </header>

          <div className={styles.diagram} data-flow-diagram="">
            <Ticket />
            <span className={styles.leader} data-flow-leader="" aria-hidden="true" />
            <span className={styles.track} aria-hidden="true" />
            <span className={styles.fill} data-flow-fill="" aria-hidden="true" />
            <span className={styles.signal} data-flow-signal="" aria-hidden="true" />

            <ol className={styles.stations}>
              {stations.map((s) => (
                <li key={s.key} className={styles.station} data-flow-station={s.key}>
                  <span className={styles.node} data-flow-node="" aria-hidden="true">
                    <Node station={s.key} />
                  </span>
                  <div className={styles.text}>
                    <p className={styles.name}>
                      <ByDirection value={s.name} />
                    </p>
                    <h3 className={styles.stationTitle}>
                      <ByDirection value={s.title} />
                    </h3>
                    <p className={styles.stationBody}>
                      <ByDirection value={s.body} />
                    </p>
                    <p className={styles.record}>
                      <span className={styles.recordMark} aria-hidden="true" />
                      <span>
                        <ByDirection value={s.record} />
                      </span>
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
