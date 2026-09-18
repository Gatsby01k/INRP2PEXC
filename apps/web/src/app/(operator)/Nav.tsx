'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './shell.module.css';

export interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly count?: number;
}

/**
 * The desk's own navigation (UX_FLOWS §2). Items the operator's roles cannot reach are not rendered at all,
 * which is a courtesy rather than the control: every page re-checks, and every command authorizes itself.
 */
export function Nav({ entries }: { entries: readonly NavEntry[] }) {
  const pathname = usePathname();
  return (
    <nav className={styles.nav} aria-label="Desk sections">
      {entries.map((e) => {
        const current = e.href === '/' ? pathname === '/' : pathname.startsWith(e.href);
        return (
          <Link key={e.href} href={e.href} className={styles.navItem} {...(current ? { 'aria-current': 'page' as const } : {})}>
            <span className={styles.navLabel}>{e.label}</span>
            {e.count !== undefined && e.count > 0 ? <span className={styles.navCount}>{e.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
