'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArcMotif } from '@inrp2p/ui';
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

/**
 * The desk's navigation, grouped by the job it serves: the work in front of the desk, the money it runs on, the
 * people it trades with, and the books. Items the operator's roles cannot reach are not rendered — a courtesy
 * rather than the control: every page re-checks and every command authorizes itself.
 */
export function Sidebar({ groups, operator }: { groups: readonly NavGroup[]; operator: { name: string; roles: string; economics: boolean } }) {
  const pathname = usePathname();
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  const current = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <aside className={sh.sidebar} aria-label="Desk">
      <div className={sh.brand}>
        <span className={sh.brandMark}>
          <ArcMotif completed={3} size={18} />
        </span>
        <span className={sh.brandText}>
          <span className={sh.brandName}>INRP2P</span>
          <span className={sh.brandSub}>Operator Desk</span>
        </span>
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
          <button
            type="button"
            className={sh.signOut}
            disabled={leaving}
            aria-label="Sign out"
            title="Sign out"
            onClick={async () => {
              setLeaving(true);
              try {
                await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
              } finally {
                router.push('/sign-in');
                router.refresh();
              }
            }}
          >
            <Icon name="signOut" size={14} />
          </button>
        </div>
      </div>
    </aside>
  );
}
