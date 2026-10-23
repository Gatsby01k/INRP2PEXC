'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LazyMotion, MotionConfig, domMax, m } from 'framer-motion';
import { BankIcon, ClockIcon, StoreIcon, SwapIcon, UserIcon, UsersIcon } from './_workspace/icons.tsx';
import styles from './shell.module.css';

export interface ClientNavEntry {
  readonly href: string;
  readonly label: string;
}

/** The glyph each section carries — beside its word in the masthead's pill, and above it in the phone's bar. */
const ICONS: Record<string, typeof SwapIcon> = {
  '/exchange': SwapIcon,
  '/history': ClockIcon,
  '/destinations': BankIcon,
  '/desk': StoreIcon,
  '/desks': StoreIcon,
  '/traders': UsersIcon,
  '/open-account': UserIcon,
};

/** The pill under the current section moves to the next one on a spring, the way a thumb would slide it. */
const SPRING = { type: 'spring', stiffness: 520, damping: 38, mass: 0.9 } as const;

/**
 * The workspace's sections: ask for a price, look back, see where money may land, and — for a client that provides
 * capacity — Traders. A trade's own page belongs to History, where it is found, so History stays marked while one
 * is open; a trader's order pages belong to Traders; Account belongs to nothing in the row.
 *
 * The section you are on sits on a pill in the mark's orange; moving to another, the pill slides there.
 */
export function ClientNav({ entries }: { entries: readonly ClientNavEntry[] }) {
  const pathname = usePathname();
  const section = pathname.startsWith('/trades/') ? '/history' : pathname;
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <nav className={styles.nav} aria-label="Sections">
          {entries.map((e) => {
            const current = section === e.href || section.startsWith(`${e.href}/`);
            const Icon = ICONS[e.href];
            return (
              <Link key={e.href} href={e.href} className={styles.navItem} title={e.label} {...(current ? { 'aria-current': 'page' as const } : {})}>
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
