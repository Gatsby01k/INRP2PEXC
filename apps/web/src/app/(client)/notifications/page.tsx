import { clientInbox } from '@inrp2p/notifications';
import { clientPage } from '../../../server/client.ts';
import { Inbox } from './Inbox.tsx';
import styles from '../shell.module.css';

export const dynamic = 'force-dynamic';

/**
 * The client's inbox. Every message here exists because a command wrote a state change and enqueued an event in
 * the same transaction, so nothing in it can be true of a trade that did not happen.
 */
export default async function NotificationsPage() {
  const ctx = await clientPage();
  const rows = await clientInbox(ctx.db, ctx.access.clientId, { limit: 50 });

  return (
    <main className={styles.content}>
      <h1 className={styles.pageTitle}>Notifications</h1>
      <Inbox rows={rows} />
    </main>
  );
}
