import { traderHome } from '@inrp2p/traders';
import { workspacePage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { TradersHome } from './TradersHome.tsx';

export const dynamic = 'force-dynamic';

/**
 * Traders — providing INR or USDT capacity to INRP2P. There is no public order board: orders are assigned privately,
 * one trader per order, and a trader sees only its own orders at its own rates. Everything on the screen comes from
 * the trader projection (`@inrp2p/traders` views), which carries nothing about the client on the other side.
 */
export default async function TradersPage() {
  const ctx = await workspacePage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  const working = home.state === 'APPROVED' || home.state === 'PAUSED';
  return (
    <>
      <PageHead
        title="Traders"
        lede={working ? `Your capacity, your rates and your orders${home.ref ? ` · ${home.ref}` : ''}.` : 'Provide INR or USDT capacity to INRP2P, and receive matching orders privately.'}
      />
      <TradersHome home={home} />
    </>
  );
}
