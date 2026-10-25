import { FAQ } from '../../../../content/site.ts';
import { mailto, siteContacts } from '../../../../server/site.ts';
import { ArrowIcon } from '../icons.tsx';
import section from '../section.module.css';
import styles from './faq.module.css';

/**
 * Questions before a first deal: the heading and a way to ask the desk on the left (on a phone, the way to ask
 * comes after the answers), the answers on the right as native disclosure widgets — one open at a time where the
 * browser groups them by name, readable and searchable without script everywhere. The way to ask is drawn only when
 * an address to write to is configured.
 */
export function Faq() {
  const { eyebrow, heading, lede, items, ask } = FAQ;
  const { desk } = siteContacts();
  return (
    <section id="faq" className={styles.faq} aria-labelledby="faq-title">
      <div className={section.inner}>
        <div className={styles.layout}>
          <div className={styles.side}>
            <header className={styles.head}>
              <p className={section.eyebrow}>{eyebrow}</p>
              <h2 id="faq-title" className={section.title}>
                {heading}
              </h2>
              <p className={`${section.lede} ${styles.lede}`}>{lede}</p>
            </header>
            {desk ? (
              <a className={styles.ask} href={mailto(desk)}>
                <span className={styles.askTitle}>{ask.title}</span>
                <span className={styles.askBody}>{ask.body}</span>
                <span className={styles.askAddress}>
                  {desk}
                  <ArrowIcon className={styles.askArrow} />
                </span>
              </a>
            ) : null}
          </div>

          <div className={styles.list}>
            {items.map((item, i) => (
              <details key={item.question} className={styles.item} name="faq" open={i === 0}>
                <summary className={styles.question}>
                  <span>{item.question}</span>
                  <span className={styles.toggle} aria-hidden="true" />
                </summary>
                <div className={styles.answer}>
                  <p>{item.answer}</p>
                  {item.more ? (
                    <a className={styles.more} href={`#${item.more.anchor}`}>
                      {item.more.label}
                      <ArrowIcon className={styles.moreArrow} />
                    </a>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
