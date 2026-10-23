'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from '../desk.module.css';

const TABS = [
  { href: '/desk', label: 'Today' },
  { href: '/desk/deals', label: 'Deals' },
  { href: '/desk/prices', label: 'Prices' },
  { href: '/desk/clients', label: 'Clients' },
  { href: '/desk/team', label: 'Team' },
  { href: '/desk/settings', label: 'Page' },
] as const;

/** The desk's sections under its name. A deal's own page belongs to Deals. `waiting` badges Today with deals on the desk. */
export function DeskTabs({ waiting = 0 }: { waiting?: number }) {
  const pathname = usePathname();
  return (
    <nav className={styles.tabs} aria-label="Desk sections">
      {TABS.map((t) => {
        const current = t.href === '/desk' ? pathname === '/desk' : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} className={styles.tab} {...(current ? { 'aria-current': 'page' as const } : {})}>
            {t.label}
            {t.href === '/desk' && waiting > 0 ? (
              <span className={styles.tabCount} aria-label={`${waiting} waiting on you`}>
                {waiting}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
