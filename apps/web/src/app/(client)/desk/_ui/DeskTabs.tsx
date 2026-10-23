'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LazyMotion, MotionConfig, domMax, m } from 'framer-motion';
import { DealsIcon, GaugeIcon, GlobeIcon, TagIcon, UserIcon, UsersIcon } from '../../_workspace/icons.tsx';
import styles from '../desk.module.css';

const TABS = [
  { href: '/desk', label: 'Today', Icon: GaugeIcon },
  { href: '/desk/deals', label: 'Deals', Icon: DealsIcon },
  { href: '/desk/prices', label: 'Prices', Icon: TagIcon },
  { href: '/desk/clients', label: 'Clients', Icon: UserIcon },
  { href: '/desk/team', label: 'Team', Icon: UsersIcon },
  { href: '/desk/settings', label: 'Page', Icon: GlobeIcon },
] as const;

const SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.9 } as const;

/**
 * The desk's sections under its name, as one segmented pill: the section you are on is filled in ink, and moving
 * to another slides it there. A deal's own page belongs to Deals. `waiting` badges Today with deals on the desk.
 */
export function DeskTabs({ waiting = 0 }: { waiting?: number }) {
  const pathname = usePathname();
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <nav className={styles.tabs} aria-label="Desk sections">
          {TABS.map(({ href, label, Icon }) => {
            const current = href === '/desk' ? pathname === '/desk' : pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link key={href} href={href} className={styles.tab} {...(current ? { 'aria-current': 'page' as const } : {})}>
                {current ? <m.span layoutId="ix-desk-pill" className={styles.tabPill} transition={SPRING} aria-hidden="true" /> : null}
                <Icon className={styles.tabIcon} />
                {label}
                {href === '/desk' && waiting > 0 ? (
                  <span className={styles.tabCount} aria-label={`${waiting} waiting on you`}>
                    {waiting}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
      </MotionConfig>
    </LazyMotion>
  );
}
