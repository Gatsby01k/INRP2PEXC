'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LazyMotion, MotionConfig, domMax, m } from 'framer-motion';
import { CommandGlyph, Icon, type IconName } from './icons.tsx';
import { openPalette, openShortcuts } from './events.ts';
import sh from '../shell.module.css';

export interface NavEntry {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  /** The key after `g` that jumps here. */
  readonly key: string;
  readonly count?: number;
  /** `alert` for work that is blocked, `action` for work waiting on the desk. */
  readonly tone?: 'alert' | 'action';
}

export interface NavGroup {
  readonly label: string;
  readonly entries: readonly NavEntry[];
}

/** The pill under the current section slides to the next one on a spring — the client workspace's own motion. */
const SPRING = { type: 'spring', stiffness: 520, damping: 40, mass: 0.9 } as const;

/**
 * The desk's navigation, grouped by the job it serves: the work in front of the desk, the money it runs on, the
 * people it trades with, and the books. Items the operator's roles cannot reach are not rendered — a courtesy
 * rather than the control: every page re-checks and every command authorizes itself.
 *
 * On paper, in the brand's room: the mark and the name at the top, the section you are on on a pill of the mark's
 * orange. Below 900px the rail folds into a masthead with the mark, search and a menu that slides the same
 * navigation in from the left.
 */
export function Sidebar({ groups, operator, mark }: { groups: readonly NavGroup[]; operator: { name: string; roles: string; economics: boolean }; mark: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [open, setOpen] = useState(false);

  const current = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));
  const here = groups.flatMap((g) => g.entries).find((e) => current(e.href));
  const waiting = groups.flatMap((g) => g.entries).reduce((n, e) => n + (e.tone && e.count ? e.count : 0), 0);
  const alert = groups.flatMap((g) => g.entries).some((e) => e.tone === 'alert' && (e.count ?? 0) > 0);

  // A section opened from the menu closes it; so does Escape, and the page behind does not scroll while it is open.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = async () => {
    setLeaving(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } finally {
      router.push('/sign-in');
      router.refresh();
    }
  };

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <header className={sh.mobileBar}>
          <Link href="/" className={sh.mobileBrand} aria-label="INRP2P operator desk">
            <img src={mark} alt="" width={30} height={30} className={sh.brandMark} />
            <span className={sh.mobileTitle}>
              INRP2P <span className={sh.mobileSub}>{here && here.href !== '/' ? here.label : 'Operator desk'}</span>
            </span>
          </Link>
          <button type="button" className={sh.barButton} onClick={() => openPalette()} aria-label="Search and jump">
            <Icon name="search" size={16} />
          </button>
          <button type="button" className={sh.barButton} onClick={() => setOpen(true)} aria-label="Open the menu" aria-expanded={open}>
            <Icon name="menu" size={16} />
            {waiting > 0 ? (
              <span className={sh.barCount} data-tone={alert ? 'alert' : 'action'}>
                {waiting}
              </span>
            ) : null}
          </button>
        </header>

        <aside className={sh.sidebar} aria-label="Desk" {...(open ? { 'data-open': '' } : {})}>
          <div className={sh.brandRow}>
            <Link href="/" className={sh.brand} aria-label="INRP2P operator desk">
              <img src={mark} alt="" width={34} height={34} className={sh.brandMark} />
              <span className={sh.brandText}>
                <span className={sh.brandName}>INRP2P</span>
                <span className={sh.brandSub}>Operator desk</span>
              </span>
            </Link>
            <button type="button" className={sh.closeButton} onClick={() => setOpen(false)} aria-label="Close the menu">
              <Icon name="close" size={16} />
            </button>
          </div>

          <button type="button" className={sh.search} onClick={() => openPalette()} aria-label="Search and jump (Command K)">
            <Icon name="search" size={14} />
            <span className={sh.searchText}>Search or jump to…</span>
            <span className={sh.searchKeys} aria-hidden="true">
              <CommandGlyph size={10} />K
            </span>
          </button>

          <nav className={sh.nav} aria-label="Desk sections">
            {groups.map((g) => (
              <div key={g.label} className={sh.navGroup}>
                <span className={sh.navGroupLabel}>{g.label}</span>
                {g.entries.map((e) => {
                  const on = current(e.href);
                  return (
                    <Link
                      key={e.href}
                      href={e.href}
                      className={sh.navItem}
                      title={`${e.label} (g then ${e.key})`}
                      {...(on ? { 'aria-current': 'page' as const } : {})}
                    >
                      {on ? <m.span layoutId="ix-desk-nav-pill" className={sh.navPill} transition={SPRING} aria-hidden="true" /> : null}
                      <Icon name={e.icon} size={16} className={sh.navIcon} />
                      <span className={sh.navLabel}>{e.label}</span>
                      {e.count !== undefined && e.count > 0 ? (
                        <span className={sh.navCount} data-tone={e.tone ?? 'plain'} aria-label={`${e.count} ${e.tone === 'alert' ? 'blocked' : 'waiting'}`}>
                          {e.count}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className={sh.foot}>
            <button type="button" className={sh.footButton} onClick={() => openShortcuts()}>
              <Icon name="keyboard" size={14} />
              <span className={sh.navLabel}>Keyboard shortcuts</span>
              <span className={sh.footKey} aria-hidden="true">
                ?
              </span>
            </button>
            <div className={sh.operator}>
              <span className={sh.avatar} aria-hidden="true">
                {operator.name.slice(0, 1).toUpperCase()}
              </span>
              <span className={sh.operatorText}>
                <span className={sh.operatorName}>{operator.name}</span>
                <span className={sh.operatorRoles}>
                  {operator.roles}
                  {operator.economics ? '' : ' · economics hidden'}
                </span>
              </span>
              <button type="button" className={sh.signOut} disabled={leaving} aria-label="Sign out" title="Sign out" onClick={signOut}>
                <Icon name="signOut" size={14} />
              </button>
            </div>
          </div>
        </aside>
        {open ? <button type="button" className={sh.scrim} aria-label="Close the menu" onClick={() => setOpen(false)} /> : null}
      </MotionConfig>
    </LazyMotion>
  );
}
