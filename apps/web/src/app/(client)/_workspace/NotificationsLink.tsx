'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BellIcon } from './icons.tsx';

/** The bell in the masthead: how many messages are new, and — while the inbox is open — that this is where you are. */
export function NotificationsLink({ unread, className, iconClassName, badgeClassName }: { unread: number; className: string | undefined; iconClassName: string | undefined; badgeClassName: string | undefined }) {
  const here = usePathname() === '/notifications';
  return (
    <Link href="/notifications" className={className} title="Notifications" {...(here ? { 'aria-current': 'page' as const } : {})}>
      <BellIcon className={iconClassName} />
      <span className="ix-visually-hidden">Notifications</span>
      {unread > 0 ? (
        <span className={badgeClassName} aria-label={`${unread} unread`}>
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  );
}
