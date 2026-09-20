import type { ReactNode } from 'react';
import { deskQueue } from '@inrp2p/desk';
import { ArcMotif } from '@inrp2p/ui';
import { can, operatorPage } from '../../server/operator.ts';
import { CommandBarHost } from '../../components/CommandBarHost.tsx';
import { Nav, type NavEntry } from './Nav.tsx';
import { SignOut } from './SignOut.tsx';
import styles from './shell.module.css';

export const dynamic = 'force-dynamic';

/**
 * The operator shell. Everything inside it has already been through `operatorPage()`, so a page never has to
 * ask whether someone is signed in — only what they are allowed to see.
 */
export default async function OperatorLayout({ children }: { children: ReactNode }) {
  const ctx = await operatorPage();
  const groups = await deskQueue(ctx.db, ctx.access, { limitPerGroup: 50 });
  const actionable = groups
    .filter((g) => g.key === 'needs_action' || g.key === 'exception')
    .reduce((n, g) => n + g.rows.length, 0);

  const entries: NavEntry[] = [
    { href: '/', label: 'Desk', count: actionable },
    { href: '/orders', label: 'Orders' },
    { href: '/rates', label: 'Rates' },
    { href: '/inr', label: 'INR' },
    { href: '/usdt', label: 'USDT' },
    { href: '/clients', label: 'Clients' },
    // Not rendered without `pnl:view`, because the page itself is not found without it: a settlement operator
    // who can see a link to the desk's margin has already been told the desk has one.
    ...(can(ctx, 'pnl:view') ? [{ href: '/pnl', label: 'P&L' }] : []),
  ];

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          {/* Drawn, not typed: ◗ is not in Geist, so as text it falls back to whatever font the machine has
              (VISUAL_BASELINES §4) — the mark would differ on every desk and in every baseline. */}
          <ArcMotif completed={3} size={18} />
          <span className={styles.brandName}>INRP2P Desk</span>
        </div>
        <Nav entries={entries} />
        <div className={styles.sidebarFoot}>
          <span className={styles.roles}>{ctx.actor.roles.join(' · ') || 'No role'}</span>
          <span>{can(ctx, 'economics:view') ? 'Economics visible' : 'Economics hidden'}</span>
          <SignOut />
        </div>
      </aside>
      <div className={styles.workspace}>{children}</div>
      <CommandBarHost />
    </div>
  );
}
