import type { ReactNode } from 'react';
import Link from 'next/link';
import { getImageProps } from 'next/image';
import mark from '../../../../../brand/inrp2p-mark.png';
import { CLOSING, FOOTER, FOOTER_NOTE, NAV, SITE_NAME, SITE_PAGES, TAGLINE, WORKSPACE_ENTRY } from '../../content/site.ts';
import { appOrigin, mailto, onboardingHref, siteContacts } from '../../server/site.ts';
import styles from './public.module.css';

/**
 * One footer link. A path on this site goes through `Link` (not prefetched: the masthead already prefetches the
 * pages people go to next, and the footer would only repeat those requests); the client app and a mail address
 * are plain links, because they are somewhere else.
 */
interface FooterLink {
  readonly label: string;
  readonly href: string;
  /** Shown under the label: an address is worth reading before it is clicked. */
  readonly detail?: string;
}

function FooterGroup({ title, links }: { title: string; links: readonly FooterLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className={styles.footerGroup}>
      <h2 className={styles.footerHeading}>{title}</h2>
      <ul className={styles.footerList}>
        {links.map((l) => (
          <li key={l.href}>
            {l.href.startsWith('/') ? (
              <Link href={l.href} className={styles.footerLink} prefetch={false}>
                {l.label}
              </Link>
            ) : (
              <a href={l.href} className={styles.footerLink}>
                {l.label}
                {l.detail ? <span className={styles.footerDetail}>{l.detail}</span> : null}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The masthead entry's glyph, in the execution flow's own drawing: a station on the rail and the line leaving it.
 * The head carries a stub of the line with it, so when it moves along the line reads as running further rather
 * than coming apart. Drawn on a 1:1 grid, with room left at the tip for that move.
 */
function EntryGlyph({ className, headClassName }: { className?: string | undefined; headClassName?: string | undefined }) {
  return (
    <svg className={className} width="22" height="12" viewBox="0 0 22 12" fill="none" aria-hidden="true" focusable="false">
      <circle cx="2" cy="6" r="1.6" fill="currentColor" />
      <path d="M6 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path className={headClassName} d="M11 6h6.5 M14 2.5 17.5 6 14 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The frame every public page is drawn in.
 *
 * A server component with no interactivity of its own. The home page hydrates a few small islands (the hero's
 * quote module, the robot stage and its voice, the execution flow's switch and the controls' reader);
 * everything else on the public site is plain server-rendered HTML, which keeps it fast on a phone on Indian
 * mobile data and keeps its Content-Security-Policy to one nonce.
 */
export function PublicShell({ children, nonce }: { children: ReactNode; nonce?: string | undefined }) {
  const app = appOrigin();
  // The supplied mark is 511px square; it is served resized to the 32px it is shown at (and twice that for dense
  // screens), never redrawn. Props only — no client component — so the shell still ships no script of its own.
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 32, height: 32 });
  const contacts = siteContacts();
  // The home page's sections, reached from any page. Every link leads somewhere that exists; an address that is
  // not configured is left out rather than drawn as a placeholder (server/site.ts).
  const { links, groups } = FOOTER;
  const product: FooterLink[] = [
    { label: links.request, href: `${app}${CLOSING.cta.appPath}` },
    { label: links.signIn, href: `${app}/sign-in` },
    { label: links.flow, href: '/#execution-flow' },
    { label: links.desk, href: '/#execution-desk' },
  ];
  const pages: FooterLink[] = SITE_PAGES.filter((p) => p.path !== '/').map((p) => ({ label: p.h1, href: p.path }));
  const security: FooterLink[] = [
    { label: links.controls, href: '/#controls' },
    ...(contacts.security ? [{ label: links.securityReport, href: mailto(contacts.security), detail: contacts.security }] : []),
  ];
  const onboarding = onboardingHref();
  const contact: FooterLink[] = contacts.desk
    ? [
        ...(onboarding ? [{ label: links.onboarding, href: onboarding }] : []),
        { label: links.deskContact, href: mailto(contacts.desk), detail: contacts.desk },
      ]
    : [];
  return (
    <div className={styles.site} data-nonce-present={nonce ? 'yes' : 'no'}>
      {/* The first thing a keyboard reaches: past the masthead, straight to the page. Seen only when focused. */}
      <a className={styles.skip} href="#content">
        Skip to content
      </a>
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
          {/* The way into the workspace. `data-robot-target` lets the home page's robot glance at it; the shell
              itself still ships no script. */}
          <a className={styles.entry} href={`${app}${WORKSPACE_ENTRY.appPath}`} data-robot-target="entry">
            {WORKSPACE_ENTRY.label}
            <EntryGlyph className={styles.entryGlyph} headClassName={styles.entryHead} />
          </a>
        </div>
      </header>

      <main id="content" className={styles.main} tabIndex={-1}>
        {children}
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <Link href="/" className={styles.brand} prefetch={false}>
              <img {...markProps} className={styles.brandMark} />
              <span className={styles.brandName}>{SITE_NAME}</span>
            </Link>
            <p className={styles.footerTagline}>{TAGLINE}</p>
          </div>
          {/* Every published page, so none depends on the masthead to be reachable. */}
          <nav className={styles.footerNav} aria-label="Footer">
            <FooterGroup title={groups.product} links={product} />
            <FooterGroup title={groups.pages} links={pages} />
            <FooterGroup title={groups.security} links={security} />
            <FooterGroup title={groups.contact} links={contact} />
          </nav>
        </div>
        <div className={styles.footerBase}>
          <p className={styles.footerNote}>{FOOTER_NOTE}</p>
          <p className={styles.footerNote}>{FOOTER.risk}</p>
          <p className={styles.footerNote}>{FOOTER.marks}</p>
        </div>
      </footer>
    </div>
  );
}
