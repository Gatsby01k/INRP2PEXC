'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ClientNotification } from '@inrp2p/notifications';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { markNotificationsReadAction } from '../../../server/actions/client.ts';
import { AssistantPanel } from '../_assistant/AssistantPanel.tsx';
import type { AssistantState } from '../_assistant/model.ts';
import { ArrowIcon } from '../_workspace/icons.tsx';
import shell from '../shell.module.css';
import styles from './inbox.module.css';

/** The robot on the inbox says only how much of it is new — the messages say the rest. */
function inboxAssistant(total: number, unread: number): AssistantState {
  if (total === 0) return { mood: 'none', label: 'Up to date', title: 'Nothing to report', body: 'You will hear from the desk here when a quote is ready or a payment goes out.' };
  if (unread === 0) return { mood: 'none', label: 'Up to date', title: 'You have read everything', body: 'New messages from the desk appear at the top.' };
  return { mood: 'none', label: `${unread} new`, title: unread === 1 ? 'One message since you last looked' : `${unread} messages since you last looked`, body: 'Each links to the quote or trade it is about.' };
}

export function Inbox({ rows }: { rows: readonly ClientNotification[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unread = rows.filter((r) => !r.read);

  return (
    <>
      <main className={shell.main}>
        {rows.length === 0 ? (
          <section className={shell.card}>
            <p className={shell.cardTitle}>Nothing to report</p>
            <p className={shell.muted}>You will hear from us when a quote is ready or a payment goes out.</p>
          </section>
        ) : (
          <>
            {unread.length > 0 ? (
              <div className={styles.toolbar}>
                <button
                  type="button"
                  className={shell.secondaryAction}
                  disabled={busy}
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
                  {busy ? <ArcLoader size="sm" label="Marking as read" tone="inherit" /> : null}
                  Mark all as read
                </button>
              </div>
            ) : null}
            <ul className={styles.list} aria-label="Notifications">
              {rows.map((n) => (
                <li key={n.id} className={styles.item} data-unread={!n.read || undefined}>
                  <span className={styles.dot} aria-hidden="true" />
                  <div className={styles.body}>
                    <div className={styles.head}>
                      <strong>
                        {n.title}
                        {!n.read ? <span className="ix-visually-hidden"> (new)</span> : null}
                      </strong>
                      <span className={shell.muted}>{formatIstDateTime(new Date(n.createdAt))}</span>
                    </div>
                    <p>{n.body}</p>
                    {n.href ? (
                      <Link className={shell.textAction} href={n.href}>
                        {n.subjectRef ? `Open ${n.subjectRef}` : 'Open'}
                        <ArrowIcon className={styles.arrow} />
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
      <AssistantPanel state={inboxAssistant(rows.length, unread.length)} size="compact" />
    </>
  );
}
