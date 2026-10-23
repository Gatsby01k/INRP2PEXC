import type { ReactNode } from 'react';
import { OWN_DESK, type OwnDeskFeature } from '../../../../content/site.ts';
import { ArrowIcon, CheckIcon } from '../icons.tsx';
import { MASKS } from '../masks.ts';
import { MarkArt } from '../../../../components/MarkArt.tsx';
import section from '../section.module.css';
import styles from './owndesk.module.css';

/** The programme's glyphs, in the kit's hand: one stroke weight, round joins, a 24-unit grid. */
const GLYPHS: Record<OwnDeskFeature | 'arrow', string> = {
  page: 'M12 9.9a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z M12 9.9V6.4 M9.7 14 6.7 15.7 M14.3 14l3 1.7 M12 3.4a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z M5.4 15.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z M18.6 15.6a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  escrow: 'M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2Z M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z M12 8.5v1 M12 14.5v1 M8.5 12h1 M14.5 12h1',
  prices: 'M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2a1 1 0 0 1 0 1.4l-7.8 7.8a1 1 0 0 1-1.4 0Z M8 6.7a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6Z',
  team: 'M9 5.3a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4Z M3 19.5c.7-3.2 3-5 6-5s5.3 1.8 6 5 M15.5 5.6a3.2 3.2 0 0 1 0 5.8 M17.5 14.8c1.8.6 3 2.2 3.5 4.7',
  alerts: 'M20.5 3.5 10 14 M20.5 3.5l-6.5 17-4-6.5-6.5-4Z',
  arrow: 'M5 12h13 M13 7l5 5-5 5',
};

function Glyph({ name, className }: { name: keyof typeof GLYPHS; className?: string | undefined }) {
  return (
    <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d={GLYPHS[name]} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const FEATURE = Object.fromEntries(OWN_DESK.features.map((f) => [f.key, f])) as Record<OwnDeskFeature, (typeof OWN_DESK.features)[number]>;

/** One tile of the bento: its glyph, words, and the piece of the product it is about, drawn beside them. */
function Tile({ feature, className, children }: { feature: OwnDeskFeature; className: string | undefined; children: ReactNode }) {
  const f = FEATURE[feature];
  return (
    <article className={`${styles.tile} ${className ?? ''}`} data-feature={feature}>
      <div className={styles.tileText}>
        <span className={styles.tileGlyph}>
          <Glyph name={feature} />
        </span>
        <h3 className={styles.tileTitle}>{f.title}</h3>
        <p className={styles.tileBody}>{f.body}</p>
      </div>
      <div className={styles.mock} aria-hidden="true">
        {children}
      </div>
    </article>
  );
}

const rate = `${MASKS.rate}`;

/**
 * "Your own exchange, on INRP2P": the desk programme (ADR 0020) for the traders and brokers who would run one — a
 * page, deal links, escrow, prices, a team and alerts — set as a bento of the product's own surfaces, drawn in markup
 * with every figure masked. Server markup only; the tiles rise into place as they scroll in where the browser can
 * tie an animation to scrolling, and simply stand there where it cannot.
 */
export function OwnDesk({ appOrigin, host }: { appOrigin: string; host: string }) {
  const { eyebrow, heading, lede, mock, steps, cta } = OWN_DESK;
  return (
    <section id="own-desk" className={styles.ownDesk} aria-labelledby="own-desk-title">
      <div className={section.inner}>
        <header className={section.head}>
          <div>
            <p className={section.eyebrow}>{eyebrow}</p>
            <h2 id="own-desk-title" className={section.title}>
              {heading}
            </h2>
          </div>
          <p className={section.lede}>{lede}</p>
        </header>

        <div className={styles.bento}>
          <Tile feature="page" className={styles.wide}>
            <div className={styles.browser}>
              <div className={styles.browserBar}>
                <span className={styles.dots}>
                  <i />
                  <i />
                  <i />
                </span>
                <span className={styles.address}>
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
                    <path d="M5 7V5.5a3 3 0 0 1 6 0V7 M4.5 7h7a1 1 0 0 1 1 1v4.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                  </svg>
                  {host}/<b>{mock.handle}</b>
                </span>
              </div>
              <div className={styles.store}>
                <div className={styles.storeHead}>
                  <span className={styles.storeMark}>{mock.deskName.charAt(0)}</span>
                  <span className={styles.storeName}>{mock.deskName}</span>
                  <span className={styles.livePill}>
                    <span className={styles.liveDot} />
                    {mock.taking}
                  </span>
                </div>
                <div className={styles.rates}>
                  <span className={styles.rate} data-on="">
                    <span className={styles.rateLabel}>{mock.sell}</span>
                    <span className={styles.rateValue}>{rate}</span>
                    <span className={styles.rateUnit}>{mock.perUsdt}</span>
                  </span>
                  <span className={styles.rate}>
                    <span className={styles.rateLabel}>{mock.buy}</span>
                    <span className={styles.rateValue}>{rate}</span>
                    <span className={styles.rateUnit}>{mock.perUsdt}</span>
                  </span>
                </div>
                <span className={styles.storeCta}>
                  {mock.ask}
                  <ArrowIcon />
                </span>
              </div>
            </div>
          </Tile>

          <Tile feature="link" className={styles.narrow}>
            <div className={styles.phone}>
              <div className={styles.phoneNotch} />
              <div className={styles.bubble}>{mock.chat}</div>
              <div className={styles.linkCard}>
                <span className={styles.linkTop}>
                  <span className={styles.linkMark}>{mock.deskName.charAt(0)}</span>
                  {mock.linkTitle}
                </span>
                <span className={styles.linkAmount}>
                  {MASKS.amount} <small>{mock.linkMeta}</small> {rate}
                </span>
                <span className={styles.linkHeld}>
                  <span className={styles.ring} />
                  {mock.held} {MASKS.time}
                </span>
                <span className={styles.linkTake}>{mock.take}</span>
              </div>
            </div>
          </Tile>

          <Tile feature="escrow" className={styles.third}>
            <ol className={styles.escrow}>
              {mock.escrow.map((step, i) => (
                <li key={step} className={styles.escrowStep} data-state={i < 2 ? 'done' : 'now'}>
                  <span className={styles.escrowNode}>{i < 2 ? <CheckIcon /> : <Glyph name="escrow" />}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </Tile>

          <Tile feature="prices" className={styles.third}>
            <div className={styles.prices}>
              {[mock.youBuy, mock.youSell].map((label) => (
                <span key={label} className={styles.priceRow}>
                  <span className={styles.priceText}>
                    <span className={styles.priceLabel}>{label}</span>
                    <span className={styles.priceValue}>{rate}</span>
                  </span>
                  <span className={styles.toggle} data-on="">
                    <span />
                  </span>
                </span>
              ))}
              <span className={styles.holds}>
                <span className={styles.holdsLabel}>{mock.holdFor}</span>
                {mock.holds.map((h, i) => (
                  <span key={h} className={styles.hold} {...(i === 1 ? { 'data-on': '' } : {})}>
                    {h}
                  </span>
                ))}
              </span>
            </div>
          </Tile>

          <Tile feature="alerts" className={styles.third}>
            <div className={styles.alerts}>
              {mock.alerts.map((a, i) => (
                <span key={a.title} className={styles.alert} style={{ ['--i' as string]: i }}>
                  <span className={styles.alertBot}>
                    <Glyph name="alerts" />
                  </span>
                  <span className={styles.alertText}>
                    <span className={styles.alertFrom}>{mock.bot}</span>
                    <b>{a.title}</b>
                    <span>{a.body}</span>
                  </span>
                </span>
              ))}
            </div>
          </Tile>

          <Tile feature="team" className={styles.narrow}>
            <ul className={styles.team}>
              {mock.team.map((m, i) => (
                <li key={m.name} className={styles.member}>
                  <span className={styles.memberMark} data-hue={i}>
                    {m.name.charAt(0)}
                  </span>
                  <span className={styles.memberName}>{m.name}</span>
                  <span className={styles.role} data-admin={i === 0 ? '' : undefined}>
                    {m.role}
                  </span>
                </li>
              ))}
            </ul>
          </Tile>

          <article className={`${styles.tile} ${styles.wide} ${styles.ctaTile}`}>
            <MarkArt className={styles.ctaArt} live />
            <div className={styles.ctaHead}>
              <h3 className={styles.ctaTitle}>{cta.title}</h3>
              <div className={styles.ctaActions}>
                <a className={styles.ctaButton} href={`${appOrigin}${cta.appPath}`}>
                  {cta.label}
                  <ArrowIcon className={styles.ctaArrow} />
                </a>
                <a className={styles.ctaLink} href={`${appOrigin}${cta.signedInPath}`}>
                  {cta.signedIn}
                </a>
              </div>
            </div>
            <div className={styles.flow} aria-hidden="true">
              {mock.flow.map((label, i) => (
                <span key={label} className={styles.flowPart}>
                  {i > 0 ? <span className={styles.flowLine} /> : null}
                  <span className={styles.flowNode} data-middle={i === 1 ? '' : undefined}>
                    <span className={styles.flowOrb}>{i === 1 ? <Glyph name="escrow" /> : <Glyph name={i === 0 ? 'team' : 'page'} />}</span>
                    <span className={styles.flowLabel}>{label}</span>
                  </span>
                </span>
              ))}
            </div>
            <ol className={styles.steps}>
              {steps.map((s, i) => (
                <li key={s.title} className={styles.step}>
                  <span className={styles.stepIndex} aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className={styles.stepTitle}>{s.title}</span>
                  <span className={styles.stepBody}>{s.body}</span>
                </li>
              ))}
            </ol>
          </article>
        </div>
      </div>
    </section>
  );
}
