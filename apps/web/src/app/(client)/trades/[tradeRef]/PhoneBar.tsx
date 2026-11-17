import Link from 'next/link';
import { BackIcon, ChatIcon, SupportIcon } from '../../_workspace/icons.tsx';
import styles from './phone-bar.module.css';

/**
 * A trade on a phone is a page of its own, the way a phone opens one thing: its own bar replaces the workspace's —
 * back to History, the trade's reference, and its chat and support under the thumb — and the section bar steps aside
 * for the deal's one action. On a desk the bar is not drawn; the workspace's own masthead stays.
 *
 * `waiting` counts what the other side said since the viewer last wrote: the chat's badge.
 */
export function PhoneBar({
  tradeRef,
  chat,
  waiting,
  back = { href: '/history', label: 'History' },
}: {
  tradeRef: string;
  chat: boolean;
  waiting: number;
  /** Where the page belongs: History for a trade, Orders for a trader's order. */
  back?: { readonly href: string; readonly label: string };
}) {
  return (
    <nav className={styles.bar} data-phone-bar="" aria-label="Trade">
      <Link href={back.href} className={styles.button} aria-label={`Back to ${back.label}`}>
        <BackIcon />
      </Link>
      <span className={styles.ref}>{tradeRef}</span>
      {chat ? (
        <>
          <a href="#deal-chat" className={styles.button} aria-label={waiting > 0 ? `Chat, ${waiting} new` : 'Chat'}>
            <ChatIcon />
            {waiting > 0 ? <em className={styles.badge}>{waiting}</em> : null}
          </a>
          <a href="#deal-chat" className={styles.button} aria-label="Support, in the chat">
            <SupportIcon />
          </a>
        </>
      ) : null}
    </nav>
  );
}
