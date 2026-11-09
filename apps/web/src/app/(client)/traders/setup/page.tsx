import { redirect } from 'next/navigation';
import { traderHome } from '@inrp2p/traders';
import { workspacePage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { UsersIcon } from '../../_workspace/icons.tsx';
import { SetupFlow } from './SetupFlow.tsx';

export const dynamic = 'force-dynamic';

/**
 * The first start of an approved trader (ADR 0028): its prices for both sides on one screen, then online. Anyone not yet
 * approved is sent back to Traders, where the way there is.
 */
export default async function SetupPage() {
  const ctx = await workspacePage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  if ((home.state !== 'APPROVED' && home.state !== 'PAUSED') || home.blocks.length === 0) redirect('/traders');
  return (
    <>
      <PageHead icon={<UsersIcon />} eyebrow="Traders" title="Set your prices" lede="Follow the market by your own margin, and say how much you take on. A minute for both sides." />
      <SetupFlow home={home} />
    </>
  );
}
