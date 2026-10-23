import type { ReactNode } from 'react';
import Link from 'next/link';
import { getImageProps } from 'next/image';
import { unreadCount } from '@inrp2p/notifications';
import { payoutsHeld } from '@inrp2p/trades';
import mark from '../../../../../brand/inrp2p-mark.png';
import { workspacePage } from '../../server/client.ts';
import { mailto, siteContacts } from '../../server/site.ts';
import { SoundToggle } from './_assistant/SoundToggle.tsx';
import { AccountMenu } from './_workspace/AccountMenu.tsx';
import { CommandMenu, type CommandEntry } from './_workspace/CommandMenu.tsx';
import { MailIcon } from './_workspace/icons.tsx';
import { NotificationsLink } from './_workspace/NotificationsLink.tsx';
import { ClientNav, type ClientNavEntry } from './Nav.tsx';
import styles from './shell.module.css';

export const dynamic = 'force-dynamic';

const ENTRIES: ClientNavEntry[] = [
  { href: '/exchange', label: 'Exchange' },
  { href: '/history', label: 'History' },
  { href: '/destinations', label: 'Bank & wallets' },
  { href: '/traders', label: 'Traders' },
];

/** A client that provides capacity only, or a trader applicant: Traders is the whole of their workspace. */
const TRADER_ENTRIES: ClientNavEntry[] = [{ href: '/traders', label: 'Traders' }];

/** A trader's own exchange (ADR 0020): its desk comes first, before the programme it trades through. */
const DESK: ClientNavEntry = { href: '/desk', label: 'Desk' };
const DESKS: ClientNavEntry = { href: '/desks', label: 'Desks' };
const withDesk = (entries: ClientNavEntry[]): ClientNavEntry[] => {
  const at = entries.findIndex((e) => e.href === '/traders');
  return [...entries.slice(0, at), DESK, ...entries.slice(at)];
};

/** Signed in with no account yet (D-17): open one for the Exchange, or apply to provide capacity. */
const NEW_ENTRIES: ClientNavEntry[] = [
  { href: '/open-account', label: 'Open account' },
  { href: '/traders', label: 'Traders' },
];

/** The desk's own sections, beside the workspace's in the sidebar and in the command menu. */
const DESK_SECTIONS: ClientNavEntry[] = [
  { href: '/desk', label: 'Today' },
  { href: '/desk/deals', label: 'Deals' },
  { href: '/desk/prices', label: 'Prices' },
  { href: '/desk/clients', label: 'Clients' },
  { href: '/desk/team', label: 'Team' },
  { href: '/desk/settings', label: 'Page' },
];

const ROLE: Record<string, string> = { CLIENT_ADMIN: 'Administrator', CLIENT_TRADER: 'Trader', CLIENT_VIEWER: 'Viewer' };
const DESK_STATE: Record<string, { label: string; tone: 'live' | 'paused' | 'neutral' }> = {
  LIVE: { label: 'Live', tone: 'live' },
  PAUSED: { label: 'Paused', tone: 'paused' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUSPENDED: { label: 'Suspended', tone: 'paused' },
};

/**
 * The client workspace. Everything inside it has already been through `workspacePage()`, so a page never asks whether
 * someone is signed in — only what their client has. One sign-in reaches it, and what it offers follows from the
 * account: a client with the Exchange sees all four sections; a trader applicant, or a client that provides capacity
 * only, sees Traders.
 *
 * The masthead is the home page's own: the mark and the name on the left, the sections in a floating pill in the
 * middle — the one you are on filled in the mark's orange, sliding to the next as you move — and search (⌘K), sound,
 * notifications and the account on the right. On a phone the sections drop to a floating bar under the thumb. Below
 * it each page lays out its own work: a heading, the work, and — where the page has one — a column of context beside
 * it (`shell.module.css`).
 */
export default async function ClientLayout({ children }: { children: ReactNode }) {
  const ctx = await workspacePage();
  const member = ctx.access.kind === 'MEMBER' ? ctx.access.member : null;
  const unread = member ? await unreadCount(ctx.db, member.clientId) : 0;
  // After a database recovery the workspace may ask for a payment that was already made; it says so, in plain words
  // and without the internals, until the desk has reconciled (migration 0034, RUNBOOKS `restore-fence`).
  const { held } = await payoutsHeld(ctx.db);
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 32, height: 32 });
  const { desk } = siteContacts();
  // A trader runs a desk: approved or paused, or already with one open.
  const trader = member
    ? await ctx.db.selectFrom('trader_profile').select(['id', 'status']).where('client_id', '=', member.clientId).executeTakeFirst()
    : undefined;
  const desks = trader !== undefined && (trader.status === 'APPROVED' || trader.status === 'PAUSED');
  const ownDesk = desks && trader ? await ctx.db.selectFrom('desk').select(['display_name', 'status']).where('trader_id', '=', trader.id).executeTakeFirst() : undefined;
  const home = member?.exchangeAccess ? '/exchange' : desks ? '/desk' : member ? '/traders' : '/open-account';
  // A client that deals with independent desks (ADR 0020) finds them beside the Exchange.
  const dealsWithDesks = member ? Boolean(await ctx.db.selectFrom('desk_client').select('id').where('client_id', '=', member.clientId).limit(1).executeTakeFirst()) : false;
  const base = member?.exchangeAccess ? ENTRIES : member ? TRADER_ENTRIES : NEW_ENTRIES;
  const withDesks = dealsWithDesks && member?.exchangeAccess ? [base[0]!, DESKS, ...base.slice(1)] : base;
  const entries = desks ? withDesk(withDesks) : withDesks;
  const name = member?.clientName ?? ctx.access.email;
  const deskState = ownDesk ? DESK_STATE[ownDesk.status] : undefined;

  const commands: CommandEntry[] = [
    ...entries.map((e) => ({ href: e.href, label: e.label, group: 'Go to' })),
    ...(ownDesk ? DESK_SECTIONS.map((e) => ({ href: e.href, label: e.label, group: 'Your desk', hint: ownDesk.display_name })) : []),
    ...(member ? [{ href: '/notifications', label: 'Notifications', group: 'Account', ...(unread > 0 ? { hint: `${unread} unread` } : {}) }] : []),
    ...(member ? [{ href: '/account', label: 'Account & security', group: 'Account' }] : []),
    ...(member && desks ? [{ href: '/account/team', label: 'Team', group: 'Account' }] : []),
  ];

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.mastheadInner}>
          <Link href={home} className={styles.brand} aria-label="INRP2P workspace">
            <img {...markProps} className={styles.brandMark} />
            <span className={styles.brandName}>
              INRP2P <span className={styles.brandSub}>Exchange</span>
            </span>
          </Link>
          <ClientNav entries={entries} />
          <div className={styles.headerActions}>
            <CommandMenu entries={commands} />
            <SoundToggle className={styles.iconButton} iconClassName={styles.toolIcon} labelClassName="ix-visually-hidden" />
            {member ? (
              <NotificationsLink unread={unread} className={styles.iconButton} iconClassName={styles.toolIcon} badgeClassName={styles.unread} />
            ) : null}
            <AccountMenu name={name} email={ctx.access.email} role={member ? (ROLE[member.role] ?? 'Viewer') : null} hasAccount={member !== null} />
          </div>
        </div>
      </header>

      {held ? (
        <p className={styles.holdNotice} role="status" data-testid="payments-reconciling">
          We are reconciling recent payments. If you have already sent a payment, please do not send it again — it will be matched to your trade or order.
        </p>
      ) : null}

      <div className={styles.workspace} data-robot-scope="">
        {children}
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerBrand}>
            <img {...markProps} className={styles.footerMark} />
            INRP2P Exchange · USDT ↔ INR
            {deskState && ownDesk ? (
              <span className={styles.deskState} data-tone={deskState.tone}>
                <span className={styles.deskStateDot} />
                {ownDesk.display_name} · {deskState.label}
              </span>
            ) : null}
          </span>
          {desk ? (
            <a className={styles.footerLink} href={mailto(desk, 'Question from the workspace')}>
              <MailIcon className={styles.footerIcon} />
              Contact the desk — quote your trade reference
            </a>
          ) : (
            <span>Questions about a trade? Quote its reference when you contact the desk.</span>
          )}
        </div>
      </footer>
    </div>
  );
}
