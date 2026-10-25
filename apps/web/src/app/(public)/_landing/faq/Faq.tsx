import { getImageProps } from 'next/image';
import { FAQ, TELEGRAM, telegramUrl } from '../../../../content/site.ts';
import { ArrowIcon, TelegramIcon } from '../icons.tsx';
import wink from '../robot/stills/robot-wink.webp';
import section from '../section.module.css';
import styles from './faq.module.css';

/**
 * Questions before a first deal: the heading, and the robot winking with the way to ask anything else as what it
 * says — the CEO on Telegram — on the left (on a phone, after the answers); the answers on the right as native
 * disclosure widgets — one open at a time where the browser groups them by name, readable and searchable without
 * script everywhere.
 */
export function Faq() {
  const { eyebrow, heading, lede, items, ask } = FAQ;
  const { ceo } = TELEGRAM;
  const { props: robot } = getImageProps({ src: wink, alt: '', width: 200, height: 200, sizes: '200px' });
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
            <div className={styles.helper}>
              <img {...robot} className={styles.robot} loading="lazy" decoding="async" aria-hidden="true" />
              <a className={styles.ask} href={telegramUrl(ceo.handle)} target="_blank" rel="noopener">
                <span className={styles.askTitle}>{ask.title}</span>
                <span className={styles.askBody}>{ask.body}</span>
                <span className={styles.askAddress}>
                  <TelegramIcon />@{ceo.handle}
                  <ArrowIcon className={styles.askArrow} />
                </span>
              </a>
            </div>
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
