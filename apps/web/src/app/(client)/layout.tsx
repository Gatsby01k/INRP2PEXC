import type { ReactNode } from 'react';
import Link from 'next/link';
import { getImageProps } from 'next/image';
import { unreadCount } from '@inrp2p/notifications';
import mark from '../../../../../brand/inrp2p-mark.png';
import { workspacePage } from '../../server/client.ts';
import { AssistantRobot } from './_assistant/AssistantRobot.tsx';
import { SoundToggle } from './_assistant/SoundToggle.tsx';
import { BellIcon } from './_workspace/icons.tsx';
import { ClientNav, type ClientNavEntry } from './Nav.tsx';
import { ClientSignOut } from './SignOut.tsx';
import styles from './shell.module.css';

export const dynamic = 'force-dynamic';

const ENTRIES: ClientNavEntry[] = [
  { href: '/exchange', label: 'Exchange' },
  { href: '/history', label: 'History' },
  { href: '/destinations', label: 'Destinations' },
  { href: '/traders', label: 'Traders' },
];

/** A trader applicant, or a client that provides capacity only: the Exchange is not theirs until the desk opens it. */
const TRADER_ENTRIES: ClientNavEntry[] = [{ href: '/traders', label: 'Traders' }];

/**
 * The client workspace. Everything inside it has already been through `workspacePage()`, so a page never asks whether
 * someone is signed in — only what their client has. One sign-in reaches it, and what it offers follows from the
 * account: a client with the Exchange sees all four sections; a trader applicant, or a client that provides capacity
 * only, sees Traders. The masthead is one row — who the client is, the sections,
 * and the things a client wants without navigating: whether anything has happened since they last looked, and
 * whether the workspace may make a sound when it does.
 *
 * The robot lives here rather than in a page, so it stays through navigation; each page reports its own state to
 * it (`_assistant/AssistantPanel.tsx`) and lays itself out around it — its heading across the top, its work on the
 * left, its status under the robot on the right (`shell.module.css`).
 */
export default async function ClientLayout({ children }: { children: ReactNode }) {
  const ctx = await workspacePage();
  const member = ctx.access.kind === 'MEMBER' ? ctx.access.member : null;
  const unread = member ? await unreadCount(ctx.db, member.clientId) : 0;
  const { props: markProps } = getImageProps({ src: mark, alt: '', width: 28, height: 28 });

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.mastheadInner}>
          <div className={styles.identity}>
            <Link href={member?.exchangeAccess ? '/exchange' : '/traders'} className={styles.brand} aria-label="INRP2P workspace">
              <img {...markProps} className={styles.brandMark} />
              <span className={styles.brandName}>INRP2P</span>
            </Link>
            <span className={styles.rule} aria-hidden="true" />
            <span className={styles.clientName}>{member?.clientName ?? ctx.access.email}</span>
          </div>
          <ClientNav entries={member?.exchangeAccess ? ENTRIES : TRADER_ENTRIES} />
          <div className={styles.headerActions}>
            <SoundToggle className={styles.sound} iconClassName={styles.bellIcon} labelClassName={styles.soundText} />
            {member ? (
              <Link href="/notifications" className={styles.bell}>
                <BellIcon className={styles.bellIcon} />
                <span className={styles.bellText}>Notifications</span>
                {unread > 0 ? (
                  <span className={styles.unread} aria-label={`${unread} unread`}>
                    {unread}
                  </span>
                ) : null}
              </Link>
            ) : null}
            <span className={styles.rule} aria-hidden="true" />
            <ClientSignOut className={styles.signOut} />
          </div>
        </div>
      </header>

      <div className={styles.workspace} data-robot-scope="">
        {children}
        <div className={styles.robot} aria-hidden="true">
          <AssistantRobot />
        </div>
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>Questions about a trade? Reply to the desk on your usual channel and quote the trade reference.</span>
          <span>INRP2P Exchange · USDT ↔ INR</span>
        </div>
      </footer>
    </div>
  );
}
