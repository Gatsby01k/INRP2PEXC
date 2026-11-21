import type { ReactNode } from 'react';
import { getImageProps } from 'next/image';
import mark from '../../../../../../brand/inrp2p-mark.png';
import { FOOTER, FOOTER_NOTE, SITE_NAME, TELEGRAM, telegramUrl } from '../../../content/site.ts';
import { TRADERS_PAGE } from '../../../content/traders.ts';
import type { Segment } from '../../../server/acquisition.ts';
import { NavSpy } from '../../(public)/_landing/NavSpy.tsx';
import { Ticker } from '../../(public)/_landing/Ticker.tsx';
import pub from '../../(public)/public.module.css';
import { Glyph } from './glyphs.tsx';
import { TradersIsland } from './TradersIsland.tsx';
import styles from './traders.module.css';

/**
 * The frame of `inrp2p.com/traders`: the public site's room and its floating capsule, but a funnel's, not a site's — the
 * page's own sections in the bar, the market's rate, a sign-in for traders who already have an exchange (it opens their
 * Traders screen in the workspace, which is where `inrp2p.com/traders` used to send everyone), and the one way in. The
 * footer keeps only what a trader needs: INRP2P on Telegram, the way to the client site, and the site's honest notes.
 */
export function TradersShell({
  segment,
  chosen,
  entryHref,
  signInHref,
  children,
}: {
  segment: Segment;
  /** Whether the visitor chose the side (or their link named it), rather than being shown the first one. */
  chosen: boolean;
  entryHref: string;
  signInHref: string;
  children: ReactNode;
}) {
  const { masthead, sticky, footer } = TRADERS_PAGE;
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 32, height: 32 });
  const telegram = [TELEGRAM.ceo, ...TELEGRAM.channels];
  return (
    <div className={`${pub.site} ${styles.page}`} data-traders-page="" data-for={segment} {...(chosen ? { 'data-for-chosen': '' } : {})} data-sticky="off">
      <a className={pub.skip} href="#content">
        Skip to content
      </a>
      <header className={pub.masthead}>
        <div className={pub.capsule}>
          <a href="#content" className={pub.brand} aria-label={`${SITE_NAME} ${masthead.tag}`}>
            <img {...markProps} className={pub.brandMark} />
            <span className={pub.brandName}>{SITE_NAME}</span>
            <span className={styles.brandTag}>{masthead.tag}</span>
          </a>
          <nav className={pub.nav} aria-label="Sections" data-nav="">
            <span className={pub.navThumb} aria-hidden="true" />
            {masthead.nav.map((item) => (
              <a key={item.anchor} href={`#${item.anchor}`} className={pub.navLink} data-section={item.anchor}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className={pub.tools}>
            <Ticker />
            <a className={styles.signIn} href={signInHref} data-signin="masthead">
              <span className={styles.signInLong}>{masthead.signInLong}</span>
              <span className={styles.signInShort}>{masthead.signIn}</span>
            </a>
            <a className={styles.mastCta} href={entryHref} data-cta="masthead">
              {masthead.cta}
              <Glyph name="arrow" size={16} stroke={2} />
            </a>
          </div>
        </div>
        <NavSpy />
      </header>

      <main id="content" className={pub.main} tabIndex={-1}>
        {children}
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerTop}>
            <a href="/" className={pub.brand}>
              <img {...markProps} className={pub.brandMark} />
              <span className={pub.brandName}>{SITE_NAME}</span>
            </a>
            <p className={styles.footerClients}>
              {footer.clients} <a href="/">{footer.clientsLink} →</a>
            </p>
          </div>
          <ul className={styles.footerLinks}>
            {telegram.map((t) => (
              <li key={t.handle}>
                <a href={telegramUrl(t.handle)} target="_blank" rel="noopener" data-contact={`footer_${t.handle.toLowerCase()}`}>
                  {t.label}
                  <small>@{t.handle}</small>
                </a>
              </li>
            ))}
            <li>
              <a href={signInHref} data-signin="footer">
                {masthead.signInLong}
              </a>
            </li>
          </ul>
          <div className={styles.footerNotes}>
            <p className={styles.footerNote}>{FOOTER_NOTE}</p>
            <p className={styles.footerNote}>{FOOTER.risk}</p>
            <p className={styles.footerNote}>{FOOTER.marks}</p>
          </div>
        </div>
      </footer>

      {/* Inert until the island shows it, so a keyboard never lands on a button that is off the screen. */}
      <div className={styles.sticky} data-sticky-bar="" inert>
        <a className={styles.cta} href={entryHref} data-cta="sticky">
          {sticky.cta}
          <Glyph name="arrow" size={18} stroke={2} />
        </a>
        <span className={styles.stickyNote}>{sticky.note}</span>
      </div>
      <TradersIsland />
    </div>
  );
}
