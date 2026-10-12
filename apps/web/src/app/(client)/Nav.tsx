'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BankIcon, ClockIcon, SwapIcon, UserIcon, UsersIcon } from './_workspace/icons.tsx';
import styles from './shell.module.css';

export interface ClientNavEntry {
  readonly href: string;
  readonly label: string;
}

/** The glyph each section carries in the phone's tab bar, where a word alone is too small a target to find. */
const ICONS: Record<string, typeof SwapIcon> = {
  '/exchange': SwapIcon,
  '/history': ClockIcon,
  '/destinations': BankIcon,
  '/traders': UsersIcon,
  '/open-account': UserIcon,
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
          <Link key={e.href} href={e.href} className={styles.navItem} {...(current ? { 'aria-current': 'page' as const } : {})}>
            {Icon ? <Icon className={styles.navIcon} /> : null}
            {e.label}
          </Link>
        );
      })}
    </nav>
  );
}
