import { getImageProps } from 'next/image';
import { OWN_DESK, TRADER_TERMS, withTerms } from '../../../content/site.ts';
import { TRADERS_PAGE } from '../../../content/traders.ts';
import { Led } from '../../(public)/_landing/led/Led.tsx';
import { Earnings } from '../../(public)/_landing/owndesk/Earnings.tsx';
import { DeskBento } from '../../(public)/_landing/owndesk/OwnDesk.tsx';
import robotNone from '../../(client)/_assistant/stills/robot-none.webp';
import wave from '../../(public)/_landing/robot/stills/robot-wave.webp';
import wink from '../../(public)/_landing/robot/stills/robot-wink.webp';
import { Glyph, type GlyphName, Orbits, TelegramGlyph } from './glyphs.tsx';
import styles from './traders.module.css';

/** A section's heading block: its number and name in the kicker, the heading, and a line under it. */
function Head({ index, eyebrow, title, lede, id, centered = false }: { index: string; eyebrow: string; title: string; lede?: string; id: string; centered?: boolean }) {
  return (
    <header className={`${styles.head} ${centered ? styles.headCentered : ''}`}>
      <p className={styles.kicker}>
        <span className={styles.kickerIndex}>{index}</span>
        {eyebrow}
      </p>
      <h2 id={id} className={styles.h2}>
        {title}
      </h2>
      {lede ? <p className={styles.sub}>{withTerms(lede)}</p> : null}
    </header>
  );
}

const PROOF_GLYPH: Record<(typeof TRADERS_PAGE.proof)[number]['key'], GlyphName> = { escrow: 'escrow', bank: 'bank', refused: 'refused', ceo: 'ceo' };

/** Four facts under the hero, for the visitor who is deciding whether to believe the rest. */
export function Proof({ ceoHref, ceoHandle }: { ceoHref: string; ceoHandle: string }) {
  return (
    <section className={styles.proof} aria-label="Why it is safe">
      <ul className={styles.proofList}>
        {TRADERS_PAGE.proof.map((p) => (
          <li key={p.key} className={styles.proofItem}>
            <span className={styles.proofGlyph}>
              <Glyph name={PROOF_GLYPH[p.key]} />
            </span>
            <h3 className={styles.proofTitle}>{p.title}</h3>
            <p className={styles.proofBody}>
              {p.body}
              {p.key === 'ceo' ? (
                <>
                  {' '}
                  <a href={ceoHref} target="_blank" rel="noopener" data-contact="ceo_proof">
                    @{ceoHandle}
                  </a>
                </>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The money, on the page's one orange field: the margin as a monument, INRP2P's fee beside it, the two ways deals reach
 * a trader, and the earnings example (shared with the home page) to set at their own figures.
 */
export function Money() {
  const { money, hero } = TRADERS_PAGE;
  const { low, high } = TRADER_TERMS.margin;
  const { props: robot } = getImageProps({ src: robotNone, alt: '', width: 300, height: 300, sizes: '(max-width: 1099px) 200px, 300px' });
  const [marginTerm, feeTerm] = hero.terms;
  return (
    <section id="money" className={styles.money} aria-labelledby="money-title">
      <Orbits className={styles.moneyOrbits} />
      <div className={`${styles.inner} ${styles.moneyInner}`}>
        <div className={styles.moneyCopy}>
          <p className={styles.kicker}>
            <span className={styles.kickerIndex}>01</span>
            {money.eyebrow}
          </p>
          <h2 id="money-title" className={styles.h2}>
            {money.heading}
          </h2>
          <div className={styles.figures}>
            <div className={styles.figure}>
              <span className={styles.figureValue} aria-label={withTerms('{margin}')}>
                {low}–{high}%
              </span>
              <span className={styles.figureLabel}>{marginTerm?.label}</span>
            </div>
            <div className={`${styles.figure} ${styles.figureSmall}`}>
              <span className={styles.figureValue}>{withTerms('{fee}')}</span>
              <span className={styles.figureLabel}>{feeTerm?.label}</span>
            </div>
          </div>
          <p className={styles.moneyLede}>{withTerms(money.lede)}</p>
          <div className={styles.streams}>
            {money.streams.map((s, i) => (
              <div key={s.title} className={styles.stream}>
                <h3 className={styles.streamTitle}>
                  <Glyph name={i === 0 ? 'clients' : 'flow'} size={20} />
                  {s.title}
                </h3>
                <p className={styles.streamBody}>{s.body}</p>
              </div>
            ))}
          </div>
        </div>
        <div className={styles.calc} data-estimate="">
          <Earnings copy={OWN_DESK.earnings} robot={robot} />
        </div>
      </div>
    </section>
  );
}

/** Why INRP2P, as the trader would put it: what a P2P board costs them, and what changes here. */
export function Compare() {
  const { compare } = TRADERS_PAGE;
  return (
    <section id="why" aria-labelledby="why-title">
      <div className={styles.inner}>
        <Head index="02" eyebrow={compare.eyebrow} title={compare.heading} lede={compare.lede} id="why-title" />
        <div className={styles.compare} role="table" aria-labelledby="why-title">
          <div className={`${styles.compareRow} ${styles.compareHead}`} role="row">
            <span className={styles.topic} role="columnheader">
              <span className="ix-visually-hidden">Topic</span>
            </span>
            <span className={styles.them} role="columnheader">
              {compare.them}
            </span>
            <span className={styles.us} role="columnheader">
              <span className={styles.check} aria-hidden="true">
                <Glyph name="check" size={13} stroke={2.6} />
              </span>
              {compare.us}
            </span>
          </div>
          {compare.rows.map((r) => (
            <div key={r.topic} className={styles.compareRow} role="row">
              <span className={styles.topic} role="rowheader">
                {r.topic}
              </span>
              <span className={styles.them} role="cell">
                <Glyph name="cross" size={18} stroke={2} className={styles.cross} />
                <span className={styles.themText}>{r.them}</span>
              </span>
              <span className={styles.us} role="cell">
                <span className={styles.check} aria-hidden="true">
                  <Glyph name="check" size={13} stroke={2.6} />
                </span>
                <span>{r.us}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** How to start: four steps, what to have ready, and the way in — the qualification, said before the application. */
export function Start({ entryHref }: { entryHref: string }) {
  const { start, sticky } = TRADERS_PAGE;
  return (
    <section id="start" className={styles.start} aria-labelledby="start-title">
      <div className={styles.inner}>
        <Head index="03" eyebrow={start.eyebrow} title={start.heading} lede={start.lede} id="start-title" />
        <ol className={styles.steps}>
          {start.steps.map((s, i) => (
            <li key={s.title} className={styles.step}>
              <span className={styles.stepNode} aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className={styles.stepTitle}>{s.title}</h3>
              <p className={styles.stepBody}>{s.body}</p>
            </li>
          ))}
        </ol>
        <div className={styles.ready}>
          <div>
            <h3 className={styles.readyTitle}>{start.ready.title}</h3>
            <ul className={styles.readyList}>
              {start.ready.items.map((item) => (
                <li key={item} className={styles.readyItem}>
                  <Glyph name="check" size={20} stroke={2} className={styles.tick} />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.readyAction}>
            <a className={styles.cta} href={entryHref} data-cta="start">
              {start.cta}
              <Glyph name="arrow" size={20} stroke={2} />
            </a>
            <span className={styles.readyNote}>{sticky.note}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The exchange a trader gets, drawn as the product's own surfaces (shared with the home page). */
export function Product({ host, entryHref, signInHref }: { host: string; entryHref: string; signInHref: string }) {
  const { product } = TRADERS_PAGE;
  return (
    <section id="exchange" aria-labelledby="exchange-title">
      <div className={styles.inner}>
        <Head index="04" eyebrow={product.eyebrow} title={product.heading} lede={product.lede} id="exchange-title" />
        <DeskBento host={host} ctaHref={entryHref} signedInHref={signInHref} ctaData={{ 'data-cta': 'product' }} closing={{ title: product.closing, steps: false }} />
      </div>
    </section>
  );
}

/** The questions a trader asks before giving anyone their email, and a person to ask the rest. */
export function Faq({ ceoHref }: { ceoHref: string }) {
  const { faq } = TRADERS_PAGE;
  const { props: robot } = getImageProps({ src: wink, alt: '', width: 148, height: 148 });
  return (
    <section id="questions" aria-labelledby="questions-title">
      <div className={`${styles.inner} ${styles.faqGrid}`}>
        <div className={styles.faqAside}>
          <Head index="05" eyebrow={faq.eyebrow} title={faq.heading} lede={faq.lede} id="questions-title" />
          <div className={styles.faqRobot}>
            <img {...robot} alt="" className={styles.faqRobotImg} loading="lazy" decoding="async" />
            <div className={styles.bubble}>
              <p className={styles.bubbleTitle}>{faq.ask.title}</p>
              <p className={styles.bubbleBody}>{faq.ask.body}</p>
              <a className={styles.bubbleLink} href={ceoHref} target="_blank" rel="noopener" data-contact="ceo_faq">
                <TelegramGlyph className={styles.telegram} size={18} />
                {faq.ask.label}
              </a>
            </div>
          </div>
        </div>
        <div className={styles.faqList}>
          {faq.items.map((item, i) => (
            <details key={item.question} className={styles.faqItem} name="traders-faq" data-faq={`q${i + 1}`}>
              <summary className={styles.faqQ}>
                {item.question}
                <span className={styles.faqPlus} aria-hidden="true" />
              </summary>
              <p className={styles.faqA}>{withTerms(item.answer)}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The last word: the way in, once more, with the robot waving under it. */
export function Closing({ entryHref, signInHref, channelHref }: { entryHref: string; signInHref: string; channelHref: string }) {
  const { closing } = TRADERS_PAGE;
  const { props: robot } = getImageProps({ src: wave, alt: '', width: 300, height: 300, sizes: '(max-width: 767px) 220px, 300px' });
  return (
    <section id="closing" className={styles.closing} aria-labelledby="closing-title">
      <div className={styles.closingInner}>
        <h2 id="closing-title" className={styles.closingTitle}>
          {closing.heading}
        </h2>
        <p className={styles.closingBody}>{closing.body}</p>
        <div className={styles.closingActions}>
          <a className={styles.cta} href={entryHref} data-cta="closing">
            {closing.cta}
            <Glyph name="arrow" size={20} stroke={2} />
          </a>
          <a className={styles.ghost} href={channelHref} target="_blank" rel="noopener" data-contact="channel_closing">
            <TelegramGlyph className={styles.telegram} size={22} />
            {TRADERS_PAGE.footer.channel}
          </a>
        </div>
        <a className={styles.closingSignIn} href={signInHref} data-signin="closing">
          {closing.signIn}
        </a>
        <div className={styles.closingRobot} aria-hidden="true">
          <img {...robot} alt="" loading="lazy" decoding="async" />
          <span className={styles.closingVisor}>
            <Led text={`${closing.robot} →`} mode="marquee" pitch={5} rows={15} speed={14} className={styles.closingVisorLed} />
          </span>
        </div>
      </div>
    </section>
  );
}
