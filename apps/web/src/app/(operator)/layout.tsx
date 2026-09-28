import type { ReactNode } from 'react';
import { deskBadges, deskNow, deskQueue } from '@inrp2p/desk';
import { can, operatorPage } from '../../server/operator.ts';
import { ClockProvider } from './_desk/clock.tsx';
import { CommandPalette } from './_desk/CommandPalette.tsx';
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
  const [groups, badges, now, me] = await Promise.all([
    deskQueue(ctx.db, ctx.access, { limitPerGroup: 50 }),
    deskBadges(ctx.db),
    deskNow(ctx.db),
    ctx.db.selectFrom('auth_user').select(['name', 'email']).where('id', '=', ctx.actor.userId).executeTakeFirst(),
  ]);
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
        // A trader's rate is a route rate: the page is not found without `traders:view`, so neither is the link.
        ...(can(ctx, 'traders:view') ? [{ href: '/trader-desk', label: 'Traders', icon: 'traders' as const, key: 't' }] : []),
      ],
    },
    {
      label: 'Book',
      entries: [
        { href: '/clients', label: 'Clients', icon: 'clients', key: 'c' },
        // Not rendered without `pnl:view`, because the page itself is not found without it: a settlement operator who
        // can see a link to the desk's margin has already been told the desk has one.
        ...(can(ctx, 'pnl:view') ? [{ href: '/pnl', label: 'P&L', icon: 'pnl' as const, key: 'p' }] : []),
        ...(can(ctx, 'economics:view') ? [{ href: '/system', label: 'System health', icon: 'system' as const, key: 's' }] : []),
      ],
    },
  ];

  const roles = ctx.actor.roles.map((r) => ROLE_WORD[r] ?? r).join(' · ') || 'No role';
  return (
    <ClockProvider serverNow={now}>
      <div className={styles.shell}>
        <Sidebar groups={nav} operator={{ name: me?.name || me?.email || 'Operator', roles, economics: ctx.access.economics }} />
        <main className={styles.workspace}>{children}</main>
        <CommandPalette groups={nav} />
        <GlobalKeys groups={nav} />
        <Toaster />
      </div>
    </ClockProvider>
  );
}
