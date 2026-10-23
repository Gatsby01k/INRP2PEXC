import { clientInbox } from '@inrp2p/notifications';
import { businessNow } from '@inrp2p/quotes';
import { memberPage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { Inbox } from './Inbox.tsx';
import { BellIcon } from '../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * The client's inbox. Every message here exists because a command wrote a state change and enqueued an event in
 * the same transaction, so nothing in it can be true of a trade that did not happen.
 */
export default async function NotificationsPage() {
  // Every member reads its client's inbox, Exchange or not: a trader's approval and its orders arrive here too.
  const ctx = await memberPage();
  const [rows, now] = await Promise.all([clientInbox(ctx.db, ctx.member.clientId, { limit: 50 }), businessNow(ctx.db)]);

  return (
    <>
      <PageHead icon={<BellIcon />} title="Notifications" lede="What the desk has told you, newest first — quotes, payments, and changes to your bank accounts and wallets." />
      <Inbox rows={rows} now={now.toISOString()} />
    </>
  );
}
