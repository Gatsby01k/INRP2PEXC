import { redirect } from 'next/navigation';
import { traderApplicationOptions, traderHome } from '@inrp2p/traders';
import { workspacePage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { ApplyFlow } from './ApplyFlow.tsx';

export const dynamic = 'force-dynamic';

/**
 * The trader application: six short steps, then the desk reviews it. Open to a person who verified their email
 * through "Become a trader" (their application creates their client) and to an administrator of an existing client.
 */
export default async function ApplyPage() {
  const ctx = await workspacePage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  if (home.state !== 'NONE' && home.state !== 'REJECTED') redirect('/traders');
  const options = await traderApplicationOptions(ctx.db, ctx.actor.userId);
  if (!options.canApply) redirect('/traders');
  return (
    <>
      <PageHead eyebrow="Traders" title="Become a trader" lede="Tell INRP2P who you are, what you can provide and how you settle. The desk reviews it before any order is sent to you." />
      <ApplyFlow options={options} />
    </>
  );
}
