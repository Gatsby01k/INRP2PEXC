import type { ReactNode } from 'react';
import Link from 'next/link';
import { getImageProps } from 'next/image';
import { deskBadges } from '@inrp2p/desk';
import { payoutsHeld } from '@inrp2p/trades';
import mark from '../../../../../brand/inrp2p-mark.png';
import { can, operatorPage } from '../../server/operator.ts';
import { ClockProvider } from './_desk/clock.tsx';
import { CommandPalette } from './_desk/CommandPalette.tsx';
import { nowOf, queueOf } from './_desk/reads.ts';
import { GlobalKeys, Toaster } from './_desk/Keyboard.tsx';
import { type NavGroup, Sidebar } from './_desk/Sidebar.tsx';
import styles from './shell.module.css';

export const dynamic = 'force-dynamic';

const ROLE_WORD: Record<string, string> = {
  OWNER: 'Owner',
  DEALER: 'Dealer',
  SETTLEMENT_OPERATOR: 'Settlement',
  FINANCE: 'Finance',
  SUPPORT: 'Support',
  READ_ONLY: 'Read only',
};

/**
 * The operator shell. Everything inside it has already been through `operatorPage()`, so a page never has to ask
 * whether someone is signed in — only what they are allowed to see. The navigation is built here from the same
 * permissions the pages check, so a section an operator cannot open is not offered (P&L without `pnl:view`,
 * Traders without `traders:view`, System without `economics:view`).
 */
export default async function OperatorLayout({ children }: { children: ReactNode }) {
  const ctx = await operatorPage();
  const [groups, badges, now, hold] = await Promise.all([queueOf(ctx), deskBadges(ctx.db), nowOf(ctx), payoutsHeld(ctx.db)]);
  const me = ctx.operator;
  const actionable = groups.filter((g) => g.key === 'needs_action' || g.key === 'exception').reduce((n, g) => n + g.rows.length, 0);
  const onHold = groups.find((g) => g.key === 'exception')?.rows.length ?? 0;
  const approver = can(ctx, 'adjustment:approve') || can(ctx, 'refund:approve');
  const caseCount = badges.openCases + (approver ? badges.approvals : 0);

  const nav: NavGroup[] = [
    {
      label: 'Work',
      entries: [
        { href: '/', label: 'Desk', icon: 'desk', key: 'd', count: actionable, tone: onHold > 0 ? 'alert' : 'action' },
        { href: '/exceptions', label: 'Exceptions', icon: 'exceptions', key: 'e', count: caseCount, tone: badges.blockingCases > 0 ? 'alert' : 'action' },
        { href: '/orders', label: 'Orders', icon: 'orders', key: 'o' },
      ],
    },
    {
      label: 'Liquidity',
      entries: [
        { href: '/rates', label: 'Rates', icon: 'rates', key: 'r' },
        { href: '/inr', label: 'INR accounts', icon: 'inr', key: 'i' },
        { href: '/usdt', label: 'USDT treasury', icon: 'usdt', key: 'u' },
        ...(can(ctx, 'network:view') ? [{ href: '/network', label: 'Network budget', icon: 'network' as const, key: 'n', ...(badges.sendsWaiting > 0 ? { count: badges.sendsWaiting, tone: badges.sendsBlocked > 0 ? ('alert' as const) : ('action' as const) } : {}) }] : []),
        // A trader's rate is a route rate: the page is not found without `traders:view`, so neither is the link.
        ...(can(ctx, 'traders:view') ? [{ href: '/trader-desk', label: 'Traders', icon: 'traders' as const, key: 't' }] : []),
        ...(can(ctx, 'desks:view') ? [{ href: '/desk-ops', label: 'Desks', icon: 'desks' as const, key: 'k', ...(badges.desksToReview > 0 ? { count: badges.desksToReview, tone: 'action' as const } : {}) }] : []),
      ],
    },
    {
      label: 'Book',
      entries: [
        { href: '/clients', label: 'Clients', icon: 'clients', key: 'c' },
        // Not rendered without `pnl:view`, because the page itself is not found without it: a settlement operator who
        // can see a link to the desk's margin has already been told the desk has one.
        ...(can(ctx, 'pnl:view') ? [{ href: '/pnl', label: 'P&L', icon: 'pnl' as const, key: 'p' }, { href: '/revenue', label: 'Revenue', icon: 'revenue' as const, key: 'v' }] : []),
        ...(can(ctx, 'economics:view') ? [{ href: '/system', label: 'System health', icon: 'system' as const, key: 's' }] : []),
      ],
    },
  ];

  const roles = ctx.actor.roles.map((r) => ROLE_WORD[r] ?? r).join(' · ') || 'No role';
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 34, height: 34 });
  return (
    <ClockProvider serverNow={now}>
      <div className={styles.shell}>
        {/* The client workspace's own room: light from above, a fine grid of points fading into the paper, one warm
            glow of the mark's orange, and a grain. */}
        <div className={styles.backdrop} aria-hidden="true">
          <span className={styles.glow} />
        </div>
        <Sidebar groups={nav} operator={{ name: me.name || me.email || 'Operator', roles, economics: ctx.access.economics }} mark={markProps.src} />
        <main className={styles.workspace}>
          {hold.held ? (
            // Every page, not only System: whoever is about to pay someone must see this first (RUNBOOKS `restore-fence`).
            <p className={styles.holdBanner} role="alert" data-testid="payouts-held">
              <strong>Outgoing payments are held{hold.ref ? ` (${hold.ref})` : ''}.</strong> The database was recovered, failed over or moved: check every payment since against the
              bank and the chain before anything is sent again. Recording a payment already made is still open.{' '}
              {can(ctx, 'economics:view') ? <Link href="/system">Reconcile and release on System health</Link> : null}
            </p>
          ) : null}
          {children}
        </main>
        <CommandPalette groups={nav} />
        <GlobalKeys groups={nav} />
        <Toaster />
      </div>
    </ClockProvider>
  );
}
