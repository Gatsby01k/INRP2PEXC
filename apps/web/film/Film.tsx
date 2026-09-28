import type { CSSProperties } from 'react';
import { HERO, NAV, SITE_NAME, TRADER_ENTRY, WORKSPACE_ENTRY } from '../src/content/site.ts';
import { PointIcon } from '../src/app/(public)/_landing/icons.tsx';
import { QuoteModule } from '../src/app/(public)/_landing/QuoteModule.tsx';
import hero from '../src/app/(public)/_landing/hero.module.css';
import voice from '../src/app/(public)/_landing/voice/voice.module.css';
import site from '../src/app/(public)/public.module.css';
import { ProductColumn } from './panels.tsx';
import { AT, ILLUSTRATIVE, SUPERS, progress, productEase } from './timeline.ts';
import styles from './film.module.css';

/**
 * One frame of the film, as a function of its time: the home page's own first screen, in which the trade is shown.
 *
 * The page is the site's hero — its masthead, its frame, its copy slot, its robot stage, its quote slot — laid out
 * by the site's own CSS. Through the trade the masthead keeps its place unseen, the copy slot carries the film's two
 * lines (the site's own headings) and the quote slot carries the product; for the last shot the page is the home
 * page as it is. The robot is not drawn here: `stage.tsx` draws it where the `.stage` box lands, and the camera
 * (`camera.ts`) moves this layer and the backdrop together.
 */

/** The supplied mark, as supplied (brand/inrp2p-mark-1024.png). */
const mark = new URL('../../../brand/inrp2p-mark-1024.png', import.meta.url).href;

/** Where the client app would be; nothing in the film is followed, so it only has to be well formed. */
const APP = 'https://app.inrp2p.example';

/** The masthead entry's glyph, as the site draws it (PublicShell's EntryGlyph). */
function EntryGlyph() {
  return (
    <svg className={site.entryGlyph} width="22" height="12" viewBox="0 0 22 12" fill="none" aria-hidden="true" focusable="false">
      <circle cx="2" cy="6" r="1.6" fill="currentColor" />
      <path d="M6 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path className={site.entryHead} d="M11 6h6.5 M14 2.5 17.5 6 14 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The site's masthead (PublicShell), with the supplied mark as supplied. */
function Masthead({ shown }: { shown: boolean }) {
  return (
    <header className={site.masthead} style={shown ? undefined : { visibility: 'hidden' }}>
      <div className={site.mastheadInner}>
        <a href="/" className={site.brand}>
          <img src={mark} width={32} height={32} alt="" className={site.brandMark} />
          <span className={site.brandName}>{SITE_NAME}</span>
        </a>
        <nav className={site.nav} aria-label="Pages">
          {NAV.map((item) => (
            <a key={item.path} href={item.path} className={site.navLink}>
              {item.label}
            </a>
          ))}
        </nav>
        <a className={site.traderEntry} href={`${APP}${TRADER_ENTRY.appPath}`}>
          {TRADER_ENTRY.label}
        </a>
        <a className={site.entry} href={`${APP}${WORKSPACE_ENTRY.appPath}`} data-robot-target="entry">
          {WORKSPACE_ENTRY.label}
          <EntryGlyph />
        </a>
      </div>
    </header>
  );
}

/** A line of the film's, in the hero's headline slot: the site's eyebrow and heading, rising in as the hero's words do. */
function SuperLine({ t }: { t: number }) {
  const line = SUPERS.find((s) => t >= s.from && t < s.to + 0.25);
  if (!line) return null;
  const rise = progress(t, line.from, line.from + 0.72, productEase);
  const leave = progress(t, line.to, line.to + 0.22, productEase);
  const style: CSSProperties = { opacity: rise * (1 - leave), transform: `translateY(${(1 - rise) * 10}px)` };
  return (
    <div className={styles.super} style={style}>
      <p className={hero.eyebrow}>{line.eyebrow}</p>
      <p className={`${hero.title} ${styles.superTitle}`}>{line.text}</p>
    </div>
  );
}

/** The voice control under the module, as it stands while the robot speaks: on. */
function VoiceOn() {
  const { voice: copy } = HERO;
  return (
    <button type="button" className={voice.control} data-available="true" aria-pressed="true" title={copy.on}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
        <path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M10.6 5.8a3 3 0 0 1 0 4.4 M12.4 4.2a5.3 5.3 0 0 1 0 7.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span>{copy.control}</span>
      <span className={voice.state} aria-hidden="true">
        {copy.state.on}
      </span>
    </button>
  );
}

/** The page at `t`: the trade in the hero's frame, or — for the last shot — the home page's first screen as it is. */
function Page({ t }: { t: number }) {
  const home = t >= AT.hero;
  const { eyebrow, headline, lede, points, quote } = HERO;
  return (
    <div className={`${site.site} ${styles.page}`}>
      <Masthead shown={home} />
      <main className={site.main}>
        <section className={`${hero.hero} ${styles.hero}`} data-film="hero">
          {/* Keyed by which page it is, so the home page's own entrance plays as its shot begins. */}
          <div key={home ? 'home' : 'trade'} className={`${hero.frame} ${home ? '' : styles.tradeFrame}`}>
            {home ? (
              <>
                <div className={hero.copy}>
                  <p className={hero.eyebrow}>{eyebrow}</p>
                  <h1 className={hero.title}>
                    <span className={hero.line}>{headline.lead}</span>{' '}
                    <span className={hero.line}>
                      <span className={hero.accent}>{headline.accent}</span> {headline.tail}
                    </span>
                  </h1>
                  <p className={hero.lede}>{lede}</p>
                </div>
                <ul className={hero.points}>
                  {points.map((p) => (
                    <li key={p.label} className={hero.point}>
                      <PointIcon name={p.icon} className={hero.pointIcon} />
                      <span>{p.label}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className={hero.copy}>
                <SuperLine t={t} />
              </div>
            )}
            <div className={hero.stage} data-film="robot" aria-hidden="true" />
            <div className={hero.quote} data-film="column">
              {home ? (
                <>
                  <QuoteModule appOrigin={APP} onboarding={null} copy={quote} />
                  <VoiceOn />
                </>
              ) : (
                <ProductColumn t={t} />
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

/** The client's pointer, over the product: placed by `stage.tsx`, which knows where "Accept quote" is. */
function Cursor() {
  return (
    <svg className={styles.cursor} data-film="cursor" width="22" height="30" viewBox="0 0 22 30" aria-hidden="true">
      <path d="M2 2v22.5l5.6-5.3 3.6 8.4 3.9-1.7-3.6-8.2H19L2 2Z" fill="#fff" stroke="#121317" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** The fixed parts of the frame, over everything the camera moves: the illustrative tag, and the logo card. */
function Overlay({ t }: { t: number }) {
  const tag = progress(t, ILLUSTRATIVE.from, ILLUSTRATIVE.from + 0.3) * (1 - progress(t, ILLUSTRATIVE.to - 0.3, ILLUSTRATIVE.to));
  const logo = t >= AT.logo && t < AT.hero;
  return (
    <>
      {tag > 0 ? (
        <p className={styles.tag} style={{ opacity: tag }}>
          Illustrative trade
        </p>
      ) : null}
      {logo ? (
        <div className={styles.logoCard} data-film="logo-card">
          {/* The supplied mark, exactly as supplied: placed and scaled only, on its own field. */}
          <img src={mark} alt="" className={styles.logo} data-film="logo" />
        </div>
      ) : null}
    </>
  );
}

/**
 * The frame: backdrop, the page and its pointer (both moved by the camera), and what stays fixed over them. The
 * robot's canvas lies between the backdrop and the page, outside React, so no render ever touches its GL context.
 */
export function Film({ t }: { t: number }) {
  return (
    <>
      <div className={styles.backdrop} data-film="backdrop">
        <div className={styles.light} data-film="light" />
        <div className={styles.evening} data-film="evening" />
      </div>
      <div className={styles.content} data-film="content" data-robot-scope="">
        <Page t={t} />
        <Cursor />
      </div>
      <Overlay t={t} />
    </>
  );
}
