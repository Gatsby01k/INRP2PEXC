import { clientInbox } from '@inrp2p/notifications';
import { clientPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { Inbox } from './Inbox.tsx';

export const dynamic = 'force-dynamic';

/**
 * The client's inbox. Every message here exists because a command wrote a state change and enqueued an event in
 * the same transaction, so nothing in it can be true of a trade that did not happen.
 */
export default async function NotificationsPage() {
  const ctx = await clientPage();
  const rows = await clientInbox(ctx.db, ctx.access.clientId, { limit: 50 });

  return (
    <>
      <PageHead title="Notifications" lede="What the desk has told you, newest first — quotes, payments and changes to your destinations." />
      <Inbox rows={rows} />
    </>
  );
}
