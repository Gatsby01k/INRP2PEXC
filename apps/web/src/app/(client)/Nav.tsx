'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BankIcon, ClockIcon, DealsIcon, GaugeIcon, GlobeIcon, StoreIcon, SwapIcon, TagIcon, UserIcon, UsersIcon } from './_workspace/icons.tsx';
import styles from './shell.module.css';

export interface ClientNavEntry {
  readonly href: string;
  readonly label: string;
}

/** The glyph each section carries — in the sidebar beside its word, and in the phone's tab bar above it. */
const ICONS: Record<string, typeof SwapIcon> = {
  '/exchange': SwapIcon,
  '/history': ClockIcon,
  '/destinations': BankIcon,
  '/desk': StoreIcon,
  '/desks': StoreIcon,
  '/traders': UsersIcon,
  '/open-account': UserIcon,
};

const DESK_ICONS: Record<string, typeof SwapIcon> = {
  '/desk': GaugeIcon,
  '/desk/deals': DealsIcon,
  '/desk/prices': TagIcon,
  '/desk/clients': UserIcon,
  '/desk/team': UsersIcon,
  '/desk/settings': GlobeIcon,
};

/**
 * The workspace's sections: ask for a price, look back, see where money may land, and — for a client that provides
 * capacity — Traders. A trade's own page belongs to History, where it is found, so History stays marked while one
 * is open; a trader's order pages belong to Traders; Account belongs to nothing in the row.
 */
export function ClientNav({ entries }: { entries: readonly ClientNavEntry[] }) {
  const pathname = usePathname();
  const section = pathname.startsWith('/trades/') ? '/history' : pathname;
  return (
    <nav className={styles.nav} aria-label="Sections">
      {entries.map((e) => {
        const current = section === e.href || section.startsWith(`${e.href}/`);
        const Icon = ICONS[e.href];
        return (
          <Link key={e.href} href={e.href} className={styles.navItem} title={e.label} {...(current ? { 'aria-current': 'page' as const } : {})}>
            {Icon ? (
              <span className={styles.navGlyph} aria-hidden="true">
                <Icon className={styles.navIcon} />
              </span>
            ) : null}
            <span className={styles.navText}>{e.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The desk's own sections, under the workspace's in the sidebar: the trader runs its exchange from here. On a phone
 * the sidebar is folded away and the desk's pages carry these as tabs under their heading instead (`DeskTabs`).
 */
export function DeskNav({ entries }: { entries: readonly ClientNavEntry[] }) {
  const pathname = usePathname();
  return (
    <nav className={styles.deskNav} aria-label="Your desk">
      {entries.map((e) => {
        const current = e.href === '/desk' ? pathname === '/desk' : pathname === e.href || pathname.startsWith(`${e.href}/`);
        const Icon = DESK_ICONS[e.href];
        return (
          <Link key={e.href} href={e.href} className={styles.navItem} data-sub="" title={e.label} {...(current ? { 'aria-current': 'page' as const } : {})}>
            {Icon ? (
              <span className={styles.navGlyph} aria-hidden="true">
                <Icon className={styles.navIcon} />
              </span>
            ) : null}
            <span className={styles.navText}>{e.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
