import type { Direction } from '@inrp2p/kernel';
import { DESK, type DeskActor, type DeskEntry } from '../../../../content/site.ts';
import { MASKS } from '../masks.ts';
import { ByDirection } from '../Story.tsx';
import section from '../section.module.css';
import { DeskStage } from './DeskStage.tsx';
import styles from './desk.module.css';

/**
 * The execution desk: the timeline one trade leaves behind, from the request to the receipt, set as the log it
 * is — who acted, when, what happened and the status that followed — with the ways off the main path in place.
 *
 * Server markup, complete without script, and read as an ordered list of stages, each an ordered list of
 * entries. One small island (DeskStage.tsx) marks each entry as logged when it comes up the screen, so the spine
 * fills in behind the reader; every word is on the page before and after.
 */

/** Which side an actor is on: the desk is three kinds of actor, the client one. Drawn as a solid or a ring. */
const SIDE: Record<DeskActor, 'you' | 'desk'> = { you: 'you', dealer: 'desk', operator: 'desk', system: 'desk' };

const both = <T,>(value: T): Record<Direction, T> => ({ BUY_USDT: value, SELL_USDT: value });

function Entry({ entry, done }: { entry: DeskEntry; done: boolean }) {
  const actor = typeof entry.actor === 'string' ? both(entry.actor) : entry.actor;
  const event = typeof entry.event === 'string' ? both(entry.event) : entry.event;
  const status = entry.status === undefined ? null : typeof entry.status === 'string' ? both(entry.status) : entry.status;
  const tone = entry.branch ? 'branch' : done ? 'done' : 'progress';
  return (
    <li className={styles.entry} data-side={SIDE[actor.BUY_USDT]} data-branch={entry.branch ? '' : undefined} data-desk-entry="">
      <span className={styles.node} aria-hidden="true" />
      <div className={styles.row}>
        <p className={styles.meta}>
          <span className={styles.actor}>
            <ByDirection value={{ BUY_USDT: DESK.actors[actor.BUY_USDT], SELL_USDT: DESK.actors[actor.SELL_USDT] }} />
          </span>
          {entry.branch ? null : (
            <span className={styles.time} aria-hidden="true">
              {MASKS.time}
            </span>
          )}
        </p>
        <p className={styles.event}>
          <ByDirection value={event} />
        </p>
        {status ? (
          <p className={styles.status} data-tone={tone}>
            <span className="ix-visually-hidden">{DESK.statusLabel} </span>
            <ByDirection value={status} />
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function Desk() {
  const { eyebrow, heading, lede, timeline, legend, stages } = DESK;
  return (
    <section id="execution-desk" className={styles.desk} aria-labelledby="desk-title" data-desk="">
      <div className={section.inner}>
        <div className={styles.layout}>
          <header className={styles.head}>
            <p className={section.eyebrow}>{eyebrow}</p>
            <h2 id="desk-title" className={section.title}>
              {heading}
            </h2>
            <p className={`${section.lede} ${styles.lede}`}>{lede}</p>
            <ul className={styles.legend} aria-hidden="true">
              {(['you', 'desk', 'branch'] as const).map((k) => (
                <li key={k} className={styles.legendItem} data-kind={k}>
                  <span className={styles.legendMark} />
                  {legend[k]}
                </li>
              ))}
            </ul>
          </header>

          <ol className={styles.stages} aria-label={timeline}>
            {stages.map((stage, i) => (
              <li key={stage.key} className={styles.stage}>
                <div className={styles.stageHead}>
                  <span className={styles.stageMark} aria-hidden="true" />
                  <h3 className={styles.stageName}>{stage.name}</h3>
                </div>
                <ol className={styles.entries}>
                  {stage.entries.map((entry, j) => (
                    <Entry key={j} entry={entry} done={i === stages.length - 1} />
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        </div>
        <DeskStage />
      </div>
    </section>
  );
}
