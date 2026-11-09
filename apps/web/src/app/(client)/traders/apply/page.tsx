import { redirect } from 'next/navigation';
import { traderApplicationOptions, traderHome } from '@inrp2p/traders';
import { workspacePage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { ApplyFlow } from './ApplyFlow.tsx';
import { UsersIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * The trader application: three short steps, then the review. Open to a person who verified their email
 * through "Open your exchange" (their application creates their client) and to an administrator of an existing client.
 */
export default async function ApplyPage() {
  const ctx = await workspacePage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  if (home.state !== 'NONE' && home.state !== 'REJECTED') redirect('/traders');
  const options = await traderApplicationOptions(ctx.db, ctx.actor.userId);
  if (!options.canApply) redirect('/traders');
  return (
    <>
      <PageHead
        icon={<UsersIcon />}
        eyebrow="Traders"
        title="Apply to trade"
        lede="Three short steps. Then send your Security Reserve from your wallet, and you can start the moment you are approved."
      />
      <ApplyFlow options={options} />
    </>
  );
}
