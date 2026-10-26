import { redirect } from 'next/navigation';
import { traderApplicationOptions, traderHome } from '@inrp2p/traders';
import { workspacePage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { ApplyFlow } from './ApplyFlow.tsx';
import { UsersIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * The trader application: six short steps, then the desk reviews it. Open to a person who verified their email
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
        eyebrow="Your exchange"
        title="Open your exchange"
        lede="Tell INRP2P who you are, what you can provide and how you settle. Once INRP2P approves you, your page, prices and clients open here."
      />
      <ApplyFlow options={options} />
    </>
  );
}
