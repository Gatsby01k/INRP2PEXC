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

/** Signed in with no account yet (D-17): open one for the Exchange, or apply to provide capacity. */
const NEW_ENTRIES: ClientNavEntry[] = [
  { href: '/open-account', label: 'Open account' },
  { href: '/traders', label: 'Traders' },
];

const ROLE: Record<string, string> = { CLIENT_ADMIN: 'Administrator', CLIENT_TRADER: 'Trader', CLIENT_VIEWER: 'Viewer' };

/**
 * The client workspace. Everything inside it has already been through `workspacePage()`, so a page never asks whether
 * someone is signed in — only what their client has. One sign-in reaches it, and what it offers follows from the
 * account: a client with the Exchange sees all four sections; a trader applicant, or a client that provides capacity
 * only, sees Traders.
 *
 * The masthead is one quiet row: the mark, the sections, and the three things a client wants without navigating —
 * whether sound is on, whether anything has happened since they last looked, and who they are signed in as (with
 * their account, security and sign-out behind it). Below it each page lays out its own work: a heading, the work,
 * and — where the page has one — a column of context beside it (`shell.module.css`).
 */
export default async function ClientLayout({ children }: { children: ReactNode }) {
  const ctx = await workspacePage();
  const member = ctx.access.kind === 'MEMBER' ? ctx.access.member : null;
  const unread = member ? await unreadCount(ctx.db, member.clientId) : 0;
  // After a database recovery the workspace may ask for a payment that was already made; it says so, in plain words
  // and without the internals, until the desk has reconciled (migration 0034, RUNBOOKS `restore-fence`).
  const { held } = await payoutsHeld(ctx.db);
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 28, height: 28 });
  const { desk } = siteContacts();
  const home = member?.exchangeAccess ? '/exchange' : member ? '/traders' : '/open-account';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.mastheadInner}>
          <Link href={home} className={styles.brand} aria-label="INRP2P workspace">
            <img {...markProps} className={styles.brandMark} />
            <span className={styles.brandName}>INRP2P</span>
          </Link>
          <ClientNav entries={member?.exchangeAccess ? ENTRIES : member ? TRADER_ENTRIES : NEW_ENTRIES} />
          <div className={styles.headerActions}>
            <SoundToggle className={styles.iconButton} iconClassName={styles.toolIcon} labelClassName="ix-visually-hidden" />
            {member ? (
              <NotificationsLink unread={unread} className={styles.iconButton} iconClassName={styles.toolIcon} badgeClassName={styles.unread} />
            ) : null}
            <AccountMenu
              name={member?.clientName ?? ctx.access.email}
              email={ctx.access.email}
              role={member ? (ROLE[member.role] ?? 'Viewer') : null}
              hasAccount={member !== null}
            />
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
          <span>INRP2P Exchange · USDT ↔ INR</span>
          {desk ? (
            <a className={styles.footerLink} href={mailto(desk, 'Question from the workspace')}>
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
