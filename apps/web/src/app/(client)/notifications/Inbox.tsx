'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClientNotification } from '@inrp2p/notifications';
import { Button, EmptyState, formatIstDateTime } from '@inrp2p/ui';
import { markNotificationsReadAction } from '../../../server/actions/client.ts';
import styles from '../shell.module.css';

export function Inbox({ rows }: { rows: readonly ClientNotification[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unread = rows.filter((r) => !r.read);

  if (rows.length === 0) {
    return <EmptyState title="Nothing to report" body="You will hear from us when a quote is ready or a payment goes out." />;
  }

  return (
    <>
      {unread.length > 0 ? (
        <Button
          intent="ghost"
          size="sm"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await markNotificationsReadAction(unread.map((r) => r.id));
              router.refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          Mark all as read
        </Button>
      ) : null}
      <ul className="ix-stack" aria-label="Notifications">
        {rows.map((n) => (
          <li key={n.id} className={styles.panel}>
            <div className={styles.row}>
              <strong>{n.title}</strong>
              <span className={styles.muted}>{formatIstDateTime(new Date(n.createdAt))}</span>
            </div>
            <p>{n.body}</p>
            {n.href ? <Link href={n.href}>{n.subjectRef ? `Open ${n.subjectRef}` : 'Open'}</Link> : null}
          </li>
        ))}
      </ul>
    </>
  );
}
