import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArcMotif } from '@inrp2p/ui';
import { FOOTER_NOTE, SITE_NAME, SITE_PAGES } from '../../content/site.ts';
import { appOrigin } from '../../server/site.ts';
import styles from './public.module.css';

/**
 * The frame every public page is drawn in.
 *
 * Deliberately a server component with no interactivity: the public site ships no JavaScript of its own, which
 * keeps it fast on a phone on Indian mobile data and keeps its Content-Security-Policy down to one nonced
 * script — the structured data — rather than a framework's worth of them.
 */
export function PublicShell({ children, nonce }: { children: ReactNode; nonce?: string | undefined }) {
  const app = appOrigin();
  return (
    <div className={styles.site} data-nonce-present={nonce ? 'yes' : 'no'}>
      <header className={styles.masthead}>
        <Link href="/" className={styles.brand}>
          <ArcMotif completed={3} size={18} />
          <span className={styles.brandName}>{SITE_NAME}</span>
        </Link>
        <nav className={styles.nav} aria-label="Pages">
          {SITE_PAGES.filter((p) => p.path !== '/').map((p) => (
            <Link key={p.path} href={p.path} className={styles.navLink}>
              {p.h1}
            </Link>
          ))}
        </nav>
        <a className={styles.signIn} href={`${app}/sign-in`}>
          Client sign in
        </a>
      </header>

      <main className={styles.main}>{children}</main>

      <footer className={styles.footer}>
        <p className={styles.footerNote}>{FOOTER_NOTE}</p>
        <p className={styles.footerMeta}>
          {SITE_NAME} · USDT is a token issued by Tether; TRON and TRC20 are names of the network it is sent on. Neither is affiliated with this desk.
        </p>
      </footer>
    </div>
  );
}
