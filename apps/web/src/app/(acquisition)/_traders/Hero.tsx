import { getImageProps } from 'next/image';
import { TRADER_TERMS, withTerms } from '../../../content/site.ts';
import { TRADERS_PAGE } from '../../../content/traders.ts';
import { SEGMENTS, type Segment } from '../../../server/acquisition.ts';
import { Led } from '../../(public)/_landing/led/Led.tsx';
import robotStill from '../../(client)/_assistant/stills/robot-none.webp';
import { Glyph, Orbits, TelegramGlyph } from './glyphs.tsx';
import { RateBoard } from './RateBoard.tsx';
import styles from './traders.module.css';

/**
 * The first screen — what a stranger from a Telegram post must get before they scroll: what this is (their own USDT
 * exchange), the money (their margin, INRP2P's fee), why it is safer (the escrow in the middle), and the one thing to do.
 *
 * The words for each kind of trader are all in the markup; the switch shows one side's (the island does the switching, and
 * without it the side the address named is the one shown). The headline is the same for all three and is the page's
 * largest paint, so nothing about it waits for a script or an animation.
 */
export function Hero({ segment, entryHref, ceoHref }: { segment: Segment; entryHref: string; ceoHref: string }) {
  const { hero } = TRADERS_PAGE;
  const { props: robot } = getImageProps({ src: robotStill, alt: '', width: 360, height: 360, sizes: '(max-width: 767px) 220px, 360px' });
  return (
    <section className={styles.hero} aria-labelledby="traders-title">
      <div className={styles.heroInner}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>
            <span className={styles.eyebrowNode} aria-hidden="true" />
            {hero.eyebrow}
          </p>
          <h1 id="traders-title" className={styles.title}>
            <span className={styles.titleLead}>{hero.title.lead}</span>{' '}
            <span className={styles.titleAccent}>{hero.title.accent}</span>
          </h1>

          <div className={styles.switch} role="radiogroup" aria-label={hero.switchLabel} data-segment-switch="" style={{ ['--at' as string]: SEGMENTS.indexOf(segment) }}>
            <span className={styles.switchThumb} aria-hidden="true" />
            {SEGMENTS.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={s === segment}
                tabIndex={s === segment ? 0 : -1}
                className={styles.switchOption}
                data-segment={s}
              >
                {hero.segments[s].tab}
              </button>
            ))}
          </div>
          {SEGMENTS.map((s) => (
            <p key={s} className={styles.lede} data-seg={s} aria-live="polite">
              {withTerms(hero.segments[s].lede)}
            </p>
          ))}

          <div className={styles.actions} id="hero-actions">
            <a className={styles.cta} href={entryHref} data-cta="hero">
              {hero.cta}
              <Glyph name="arrow" size={20} stroke={2} />
            </a>
            <a className={styles.ghost} href={ceoHref} target="_blank" rel="noopener" data-contact="ceo_hero">
              <TelegramGlyph className={styles.telegram} size={22} />
              {hero.ceo}
            </a>
          </div>
          <ul className={styles.assurances}>
            {hero.assurances.map((a) => (
              <li key={a} className={styles.assurance}>
                <Glyph name="check" size={18} stroke={2.2} className={styles.tick} />
                {a}
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.stage}>
          <span className={styles.sun} aria-hidden="true" />
          <Orbits className={styles.orbits} />
          {/* The robot wears the programme's typical margin on its visor; the board says what it is a margin over. */}
          <div className={styles.robot} aria-hidden="true">
            <img {...robot} alt="" className={styles.robotImg} decoding="async" />
            <span className={styles.visor}>
              <Led text={`+${TRADER_TERMS.margin.typical}%`} pitch={7} rows={13} className={styles.visorLed} />
            </span>
          </div>

          <div className={styles.deal}>
            <p className={styles.dealTitle}>
              <Glyph name="escrow" size={16} />
              {hero.deal.title}
            </p>
            {SEGMENTS.map((s) => (
              <ol key={s} className={styles.dealSteps} data-seg={s}>
                {hero.deal.steps[s].map((step, i) => (
                  <li key={step} className={styles.dealStep} style={{ ['--i' as string]: i }}>
                    <span className={styles.ring} aria-hidden="true">
                      <Glyph name="check" size={13} stroke={2.6} />
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            ))}
          </div>

          <RateBoard copy={hero.board} />
        </div>
      </div>
    </section>
  );
}
