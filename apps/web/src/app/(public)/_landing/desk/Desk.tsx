import type { Direction } from '@inrp2p/kernel';
import { DESK, type DeskActor, type DeskStepCopy } from '../../../../content/site.ts';
import { ByDirection } from '../Story.tsx';
import section from '../section.module.css';
import styles from './desk.module.css';

/**
 * The execution desk: who owns each step of a trade, and what happens at that step when something goes wrong.
 *
 * Set as a matrix — step, who acts, what they do, and the way off the main path — so the page answers "who" in one
 * pass after the execution flow has answered "how". Each step is a list item holding a description list, so it
 * reads as a whole to assistive technology; on a wide screen the terms are drawn once, as column heads, and on a
 * narrow one above each value. Server markup only.
 */

/** Which side an actor is on: the desk is three kinds of actor, the client one. Drawn as a ring or a solid mark. */
const SIDE: Record<DeskActor, 'you' | 'desk'> = { you: 'you', dealer: 'desk', operator: 'desk', system: 'desk' };

const DIRECTIONS = ['BUY_USDT', 'SELL_USDT'] as const satisfies readonly Direction[];

function Actors({ actors }: { actors: readonly DeskActor[] }) {
  return (
    <ul className={styles.actors}>
      {actors.map((a) => (
        <li key={a} className={styles.actor} data-side={SIDE[a]}>
          <span className={styles.actorMark} aria-hidden="true" />
          {DESK.actors[a]}
        </li>
      ))}
    </ul>
  );
}

function StepActors({ actor }: { actor: DeskStepCopy['actor'] }) {
  if (!('BUY_USDT' in actor)) return <Actors actors={actor} />;
  return (
    <>
      {DIRECTIONS.map((d) => (
        <div key={d} data-dir={d}>
          <Actors actors={actor[d]} />
        </div>
      ))}
    </>
  );
}

export function Desk() {
  const { eyebrow, heading, lede, list, columns, steps } = DESK;
  return (
    <section id="execution-desk" className={styles.desk} aria-labelledby="desk-title">
      <div className={section.inner}>
        <header className={section.head}>
          <div>
            <p className={section.eyebrow}>{eyebrow}</p>
            <h2 id="desk-title" className={section.title}>
              {heading}
            </h2>
          </div>
          <p className={section.lede}>{lede}</p>
        </header>

        <div className={styles.matrix}>
          <div className={styles.columns} aria-hidden="true">
            <span />
            <span>{columns.actor}</span>
            <span>{columns.does}</span>
            <span>{columns.exception}</span>
          </div>
          <ol className={styles.steps} aria-label={list}>
            {steps.map((step) => {
              const does = typeof step.does === 'string' ? { BUY_USDT: step.does, SELL_USDT: step.does } : step.does;
              return (
                <li key={step.key} className={styles.step}>
                  <h3 className={styles.name}>{step.name}</h3>
                  <dl className={styles.cells}>
                    <div className={styles.cell}>
                      <dt className={styles.term}>{columns.actor}</dt>
                      <dd className={styles.value}>
                        <StepActors actor={step.actor} />
                      </dd>
                    </div>
                    <div className={styles.cell}>
                      <dt className={styles.term}>{columns.does}</dt>
                      <dd className={`${styles.value} ${styles.does}`}>
                        <ByDirection value={does} />
                      </dd>
                    </div>
                    <div className={`${styles.cell} ${styles.exceptionCell}`}>
                      <dt className={styles.term}>{columns.exception}</dt>
                      <dd className={`${styles.value} ${styles.exception}`}>
                        {step.exception.status ? <span className={styles.status}>{step.exception.status}</span> : null}
                        <span>{step.exception.text}</span>
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
