import { traderOrders } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { OrdersScreen } from './OrdersScreen.tsx';

export const dynamic = 'force-dynamic';

/** The trader's orders: what is open, and what has finished. Only its own, at its own rates. */
export default async function TraderOrdersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const ctx = await memberPage();
  const selected = tab === 'completed' ? 'completed' : 'active';
  const { rows, counts } = await traderOrders(ctx.db, ctx.actor.userId, selected);
  // The robot reports the orders still open whichever tab is shown, so "nothing in progress" is never said over one.
  const open = selected === 'active' ? rows : (await traderOrders(ctx.db, ctx.actor.userId, 'active')).rows;
  return (
    <>
      <PageHead eyebrow="Traders" title="Orders" lede="Every order INRP2P has sent you, with where it stands and what it earned." />
      <OrdersScreen rows={rows} open={open} counts={counts} tab={selected} />
    </>
  );
}
