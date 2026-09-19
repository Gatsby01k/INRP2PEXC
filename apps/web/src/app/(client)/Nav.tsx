'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './shell.module.css';

export interface ClientNavEntry {
  readonly href: string;
  readonly label: string;
}

/** The four places a client goes: trade, watch, look back, and manage where their money lands. */
export function ClientNav({ entries }: { entries: readonly ClientNavEntry[] }) {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="Sections">
      {entries.map((e) => {
        const current = pathname === e.href || pathname.startsWith(`${e.href}/`);
        return (
          <Link key={e.href} href={e.href} className={styles.navItem} {...(current ? { 'aria-current': 'page' as const } : {})}>
            {e.label}
          </Link>
        );
      })}
    </nav>
  );
}
