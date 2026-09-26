import { AUDIENCE } from '../../../../content/site.ts';
import section from '../section.module.css';
import styles from './audience.module.css';

/**
 * Who the desk is for: three kinds of counterparty, one line each.
 *
 * Plain server markup, and nothing to load. Each row is a name set large beside what fits it, under a rule that
 * draws itself in as the row arrives — in CSS, where the browser can tie it to the scroll; elsewhere the rule is
 * simply drawn. Nothing a reader needs moves.
 */
export function Audience() {
  const { eyebrow, heading, lede, groups } = AUDIENCE;
  return (
    <section className={styles.audience} aria-labelledby="audience-title">
      <div className={section.inner}>
        <header className={section.head}>
          <div>
            <p className={section.eyebrow}>{eyebrow}</p>
            <h2 id="audience-title" className={section.title}>
              {heading}
            </h2>
          </div>
          <p className={section.lede}>{lede}</p>
        </header>

        <ul className={styles.groups}>
          {groups.map((g) => (
            <li key={g.key} className={styles.group}>
              <h3 className={styles.name}>{g.name}</h3>
              <div className={styles.text}>
                <p className={styles.situation}>{g.situation}</p>
                <p className={styles.fit}>{g.fit}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
