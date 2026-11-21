import type { ReactNode } from 'react';
import { getImageProps } from 'next/image';
import { OWN_DESK, type OwnDeskFeature, TRADER_TERMS, withTerms } from '../../../../content/site.ts';
import { ArrowIcon } from '../icons.tsx';
import { groupDigits } from '@inrp2p/ui/format';
import { LiveRate } from '../LiveRate.tsx';
import { MarkArt } from '../../../../components/MarkArt.tsx';
import still from '../../../(client)/_assistant/stills/robot-none.webp';
import { Earnings } from './Earnings.tsx';
import section from '../section.module.css';
import styles from './owndesk.module.css';

/** The programme's glyphs, in the kit's hand: one stroke weight, round joins, a 24-unit grid. */
const GLYPHS: Record<OwnDeskFeature | 'escrow' | 'arrow', string> = {
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

/** The example a deal link is drawn with: an amount, never a rate of ours. */
const LINK_USDT = '5000';

/** A sentence with a term in it, the term set apart: `{fee}` drawn bold, the rest as written. */
function Termed({ text, term, className }: { text: string; term: '{fee}' | '{margin}'; className?: string | undefined }) {
  const [before = '', after = ''] = text.split(term);
  return (
    <>
      {before}
      <b className={className}>{withTerms(term)}</b>
      {after}
    </>
  );
}

/**
 * "For traders": the desk programme (ADR 0020) told money first. It opens on a stage — the margin a trader works at as a
 * monument, INRP2P's fee beside it, and an example they set themselves (Earnings.tsx) with the robot wearing their margin
 * on its visor — then what stops costing them, then the exchange itself as a bento of the product's own surfaces, drawn
 * in markup with the market's own figures. Server markup but for the example; the tiles rise into place as they scroll
 * in where the browser can tie an animation to scrolling, and simply stand there where it cannot.
 */
export function OwnDesk({ appOrigin, host }: { appOrigin: string; host: string }) {
  const { eyebrow, heading, headline, fee, lede, earnings, stops, tools, mock, steps, cta } = OWN_DESK;
  const { low, high } = TRADER_TERMS.margin;
  const { props: robot } = getImageProps({ src: still, alt: '', width: 300, height: 300, sizes: '(max-width: 1099px) 200px, 300px' });
  return (
    <section id="own-desk" className={styles.ownDesk} aria-labelledby="own-desk-title">
      <div className={styles.stage}>
        {/* The room's light: a warm sun behind the monument and the field's dotted orbits — texture, never the mark. */}
        <svg className={styles.orbits} viewBox="0 0 1200 1200" fill="none" aria-hidden="true" focusable="false">
          <g stroke="currentColor" strokeLinecap="round" strokeWidth="2">
            <circle cx="600" cy="600" r="330" strokeDasharray="2 13" />
            <circle cx="600" cy="600" r="450" strokeDasharray="2 17" opacity="0.7" />
            <circle cx="600" cy="600" r="570" strokeDasharray="2 22" opacity="0.45" />
          </g>
          <circle cx="366.7" cy="833.3" r="7" fill="currentColor" />
          <circle cx="918" cy="282" r="6" fill="currentColor" opacity="0.8" />
        </svg>
        <div className={`${section.inner} ${styles.stageInner}`}>
          <div className={styles.pitch}>
            <p className={section.eyebrow}>
              <span className={section.index}>04</span>
              {eyebrow}
            </p>
            {/* One sentence for whoever reads it ("Earn 5–7% on every USDT you sell."), drawn as the margin's monument. */}
            <h2 id="own-desk-title" className={styles.monument} aria-label={withTerms(heading)}>
              <span className={styles.monumentLead}>{headline.lead}</span>{' '}
              <span className={styles.figure}>
                {low}
                <span className={styles.figureDash}>–</span>
                {high}
                <span className={styles.figurePct}>%</span>
              </span>{' '}
              <span className={styles.monumentTail}>{headline.tail}</span>
            </h2>
            <p className={styles.fee}>
              <Termed text={fee} term="{fee}" />
            </p>
            <p className={styles.pitchLede}>{lede}</p>
            <div className={styles.pitchActions}>
              <a className={section.cta} href={`${appOrigin}${cta.appPath}`}>
                {cta.label}
                <ArrowIcon />
              </a>
              <a className={styles.pitchLink} href={`${appOrigin}${cta.signedInPath}`}>
                {cta.signedIn}
              </a>
            </div>
          </div>
          <Earnings copy={earnings} robot={robot} />
        </div>

        <div className={`${section.inner} ${styles.stopsInner}`}>
          <h3 className={styles.stopsTitle}>{stops.title}</h3>
          <ul className={styles.stops}>
            {stops.items.map((item, i) => (
              <li key={item.cost} className={styles.stop} style={{ ['--i' as string]: i }}>
                <s className={styles.cost}>
                  <span>{item.cost}</span>
                </s>
                <span className={styles.fix}>{item.fix}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className={section.inner}>
        <header className={`${section.head} ${styles.toolsHead}`}>
          <h3 className={styles.toolsTitle}>{tools.title}</h3>
          <p className={section.lede}>{tools.lede}</p>
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
                    <LiveRate direction="SELL_USDT" fallback={mock.market} className={styles.rateValue} />
                    <span className={styles.rateUnit}>{mock.perUsdt}</span>
                  </span>
                  <span className={styles.rate}>
                    <span className={styles.rateLabel}>{mock.buy}</span>
                    <LiveRate direction="BUY_USDT" fallback={mock.market} className={styles.rateValue} />
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
                  {groupDigits(LINK_USDT)} <small>{mock.linkMeta}</small> <LiveRate direction="BUY_USDT" fallback={mock.market} />
                </span>
                <span className={styles.linkHeld}>
                  <span className={styles.ring} />
                  {mock.held}
                </span>
                <span className={styles.linkTake}>{mock.take}</span>
              </div>
            </div>
          </Tile>

          <Tile feature="prices" className={styles.half}>
            <div className={styles.prices}>
              {[mock.youBuy, mock.youSell].map((label) => (
                <span key={label} className={styles.priceRow}>
                  <span className={styles.priceText}>
                    <span className={styles.priceLabel}>{label}</span>
                    <LiveRate direction={label === mock.youBuy ? 'SELL_USDT' : 'BUY_USDT'} fallback={mock.followMarket} className={styles.priceValue} />
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

          <Tile feature="alerts" className={styles.half}>
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
