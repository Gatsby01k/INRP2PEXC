import { redirect } from 'next/navigation';
import { traderHome, traderNetworkHome } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { NetworkScreen } from './NetworkScreen.tsx';
import { BoltIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/** The network deposit: the TRX that pays TRON for the USDT sent on this trader's orders, and how it was spent. */
export default async function NetworkDepositPage() {
  const ctx = await memberPage();
  const network = await traderNetworkHome(ctx.db, ctx.actor.userId);
  if (!network) redirect('/traders');
  const home = await traderHome(ctx.db, ctx.actor.userId);
  return (
    <>
      <PageHead icon={<BoltIcon />} eyebrow="Traders" title="Network deposit" lede="TRX that pays TRON for the USDT sent on your orders. Kept apart from your Security Reserve; what client prices cover comes back to you in INR." />
      <NetworkScreen network={network} canAct={home.canAct} />
    </>
  );
}
