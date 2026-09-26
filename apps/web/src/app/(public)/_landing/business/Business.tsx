import { BUSINESS } from '../../../../content/site.ts';
import section from '../section.module.css';
import styles from './business.module.css';

/**
 * Large-volume execution: the four terms that change when the amount is large — pricing, authority, payout,
 * records — set as a term sheet across the page. Server markup only.
 */
export function Business() {
  const { eyebrow, heading, lede, terms } = BUSINESS;
  return (
    <section className={styles.business} aria-labelledby="business-title">
      <div className={section.inner}>
        <header className={section.head}>
          <div>
            <p className={section.eyebrow}>{eyebrow}</p>
            <h2 id="business-title" className={section.title}>
              {heading}
            </h2>
          </div>
          <p className={section.lede}>{lede}</p>
        </header>

        <dl className={styles.terms}>
          {terms.map((t) => (
            <div key={t.label} className={styles.term}>
              <dt className={styles.label}>{t.label}</dt>
              <dd className={styles.definition}>
                <p className={styles.termTitle}>{t.title}</p>
                <p className={styles.termBody}>{t.body}</p>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
