import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArcMotif } from '@inrp2p/ui';
import { unreadCount } from '@inrp2p/notifications';
import { clientPage } from '../../server/client.ts';
import { ClientNav, type ClientNavEntry } from './Nav.tsx';
import { ClientSignOut } from './SignOut.tsx';
import styles from './shell.module.css';

export const dynamic = 'force-dynamic';

const ENTRIES: ClientNavEntry[] = [
  { href: '/exchange', label: 'Exchange' },
  { href: '/history', label: 'History' },
  { href: '/accounts', label: 'Accounts' },
];

/**
 * The client shell. Everything inside it has already been through `clientPage()`, so a page never asks whether
 * someone is signed in — only what their client has. The header carries the one thing a client wants to see
 * without navigating: whether anything has happened since they last looked.
 */
export default async function ClientLayout({ children }: { children: ReactNode }) {
  const ctx = await clientPage();
  const unread = await unreadCount(ctx.db, ctx.access.clientId);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <ArcMotif completed={3} size={18} />
          <span>INRP2P</span>
          <span className={styles.clientName}>{ctx.access.clientName}</span>
        </div>
        <div className={styles.headerActions}>
          <Link href="/notifications" className={styles.bell}>
            Notifications
            {unread > 0 ? (
              <span className={styles.unread} aria-label={`${unread} unread`}>
                {unread}
              </span>
            ) : null}
          </Link>
          <ClientSignOut />
        </div>
      </header>
      <ClientNav entries={ENTRIES} />
      {children}
      <p className={styles.footer}>Questions about a trade? Reply to the desk on your usual channel and quote the trade reference.</p>
    </div>
  );
}
