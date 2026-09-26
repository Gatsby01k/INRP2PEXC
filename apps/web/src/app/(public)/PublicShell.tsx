import type { ReactNode } from 'react';
import Link from 'next/link';
import { getImageProps } from 'next/image';
import mark from '../../../../../brand/inrp2p-mark.png';
import { FOOTER_NOTE, NAV, SITE_NAME, SITE_PAGES } from '../../content/site.ts';
import { appOrigin } from '../../server/site.ts';
import styles from './public.module.css';

/**
 * The frame every public page is drawn in.
 *
 * A server component with no interactivity of its own. The home page hydrates a few small islands (the hero's
 * quote module and robot stage, the execution flow's switch and the controls' reader below it); everything else
 * on the public site is plain server-rendered HTML, which keeps it fast on a phone on Indian mobile data and keeps
 * its Content-Security-Policy to one nonce.
 */
export function PublicShell({ children, nonce }: { children: ReactNode; nonce?: string | undefined }) {
  const app = appOrigin();
  // The supplied mark is 511px square; it is served resized to the 32px it is shown at (and twice that for dense
  // screens), never redrawn. Props only — no client component — so the shell still ships no script of its own.
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 32, height: 32 });
  return (
    <div className={styles.site} data-nonce-present={nonce ? 'yes' : 'no'}>
      <header className={styles.masthead}>
        <div className={styles.mastheadInner}>
          <Link href="/" className={styles.brand}>
            {/* The supplied mark, as supplied; its circular composition is shown in a circular field. */}
            <img {...markProps} className={styles.brandMark} />
            <span className={styles.brandName}>{SITE_NAME}</span>
          </Link>
          <nav className={styles.nav} aria-label="Pages">
            {NAV.map((item) => (
              <Link key={item.path} href={item.path} className={styles.navLink}>
                {item.label}
              </Link>
            ))}
          </nav>
          <a className={styles.signIn} href={`${app}/sign-in`}>
            Client sign in
          </a>
        </div>
      </header>

      <main className={styles.main}>{children}</main>

      <footer className={styles.footer}>
        {/* Every published page, so none depends on the masthead to be reachable. Not prefetched: the masthead
            already prefetches the pages people go to next, and this row would only repeat those requests. */}
        <nav className={styles.footerNav} aria-label="All pages">
          {SITE_PAGES.map((p) => (
            <Link key={p.path} href={p.path} className={styles.footerLink} prefetch={false}>
              {p.path === '/' ? SITE_NAME : p.h1}
            </Link>
          ))}
        </nav>
        <p className={styles.footerNote}>{FOOTER_NOTE}</p>
        <p className={styles.footerMeta}>
          {SITE_NAME} · USDT is a token issued by Tether; TRON and TRC20 are names of the network it is sent on. Neither is affiliated with this desk.
        </p>
      </footer>
    </div>
  );
}
