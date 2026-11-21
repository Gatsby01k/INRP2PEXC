import { traderHome, traderNetworkHome } from '@inrp2p/traders';
import { rememberTraderAcquisition } from '../../../server/acquisition-app.ts';
import { workspacePage } from '../../../server/client.ts';
import { PageHead } from '../_workspace/PageHead.tsx';
import { TradersHome } from './TradersHome.tsx';
import { OnlinePill } from './_ui/HomeParts.tsx';

export const dynamic = 'force-dynamic';

/**
 * Traders — providing INR or USDT capacity to INRP2P. There is no public order board: orders are assigned privately,
 * one trader per order, and a trader sees only its own orders at its own rates. Everything on the screen comes from
 * the trader projection (`@inrp2p/traders` views), which carries nothing about the client on the other side.
 */
export default async function TradersPage() {
  const ctx = await workspacePage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  // Someone who came from `inrp2p.com/traders` and has not applied yet: where they came from is tied to them (migration 0053).
  if (home.state === 'NONE') await rememberTraderAcquisition(ctx.actor.userId);
  const working = home.state === 'APPROVED' || home.state === 'PAUSED';
  const network = home.state === 'NONE' ? null : await traderNetworkHome(ctx.db, ctx.actor.userId);
  const clientName = ctx.access.kind === 'MEMBER' ? ctx.access.member.clientName : null;
  return (
    <>
      {working ? (
        // The working trader's heading: whose desk and its reference above the name, the switch on the right.
        <PageHead eyebrow={[clientName, home.ref].filter(Boolean).join(' · ') || undefined} title="Traders" aside={<OnlinePill home={home} />} />
      ) : (
        <PageHead title="Traders" lede="Provide INR or USDT capacity to INRP2P, and receive matching orders privately." />
      )}
      <TradersHome home={home} network={network} />
    </>
  );
}
