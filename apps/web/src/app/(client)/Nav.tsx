'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './shell.module.css';

export interface ClientNavEntry {
  readonly href: string;
  readonly label: string;
}

/**
 * The workspace's three sections: ask for a price, look back, and see where money may land. A trade's own page
 * belongs to History, where it is found — so History stays marked while one is open.
 */
export function ClientNav({ entries }: { entries: readonly ClientNavEntry[] }) {
  const pathname = usePathname();
  const section = pathname.startsWith('/trades/') ? '/history' : pathname;
  return (
    <nav className={styles.nav} aria-label="Sections">
      {entries.map((e) => {
        const current = section === e.href || section.startsWith(`${e.href}/`);
        return (
          <Link key={e.href} href={e.href} className={styles.navItem} {...(current ? { 'aria-current': 'page' as const } : {})}>
            {e.label}
          </Link>
        );
      })}
    </nav>
  );
}
