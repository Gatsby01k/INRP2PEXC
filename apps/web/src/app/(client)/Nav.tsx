'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LazyMotion, MotionConfig, domMax, m } from 'framer-motion';
import { DealsIcon, DesksIcon, ExchangeIcon, HistoryIcon, ShieldIcon, UserIcon, UsersIcon, WalletIcon } from './_workspace/icons.tsx';
import styles from './shell.module.css';

export interface ClientNavEntry {
  readonly href: string;
  readonly label: string;
  /** Only in the phone's tab bar, where a trader's orders and reserve are a thumb away (on a desk they are on the page). */
  readonly phone?: boolean;
}

/** The glyph each section carries — lit beside its word where the section is the current one, and above it in the phone's bar. */
const ICONS: Record<string, typeof ExchangeIcon> = {
  '/exchange': ExchangeIcon,
  '/history': HistoryIcon,
  '/destinations': WalletIcon,
  '/desk': DesksIcon,
  '/desks': DesksIcon,
  '/traders': UsersIcon,
  '/traders/orders': DealsIcon,
  '/traders/reserve': ShieldIcon,
  '/open-account': UserIcon,
};

/** The tab bar has room for one word: each section's short name there, its full name everywhere else. */
const SHORT: Record<string, string> = {
  '/destinations': 'Wallets',
  '/open-account': 'Open',
};

/** The visor behind the current section moves to the next one on a spring, quickly and without overshoot. */
const SPRING = { type: 'spring', stiffness: 640, damping: 48, mass: 0.8 } as const;

/**
 * The workspace's sections: ask for a price, look back, see where money may land, and — for a client that provides
 * capacity — Traders. A trade's own page belongs to History, where it is found, so History stays marked while one
 * is open; a trader's order pages belong to Traders; Account belongs to nothing in the row.
 *
 * The section you are on is a visor — the robot's black glass, its node lit; moving to another, the visor slides there.
 */
export function ClientNav({ entries }: { entries: readonly ClientNavEntry[] }) {
  const pathname = usePathname();
  const section = pathname.startsWith('/trades/') ? '/history' : pathname;
  // The most particular section wins: an order's page is Orders' where Orders is in the bar, Traders' otherwise.
  const within = (href: string) => section === href || section.startsWith(`${href}/`);
  const currentHref = entries.filter((e) => within(e.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <nav className={styles.nav} aria-label="Sections">
          {entries.map((e) => {
            const current = e.href === currentHref;
            const Icon = ICONS[e.href];
            return (
              <Link
                key={e.href}
                href={e.href}
                className={styles.navItem}
                aria-label={e.label}
                data-short={SHORT[e.href] ?? e.label}
                data-phone={e.phone || undefined}
                {...(current ? { 'aria-current': 'page' as const } : {})}
              >
                {current ? <m.span layoutId="ix-nav-pill" className={styles.navPill} transition={SPRING} aria-hidden="true" /> : null}
                {Icon ? <Icon className={styles.navIcon} /> : null}
                <span className={styles.navText}>{e.label}</span>
              </Link>
            );
          })}
        </nav>
      </MotionConfig>
    </LazyMotion>
  );
}
