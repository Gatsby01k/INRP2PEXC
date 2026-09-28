import { redirect } from 'next/navigation';
import { traderApplicationOptions, traderHome } from '@inrp2p/traders';
import { clientPage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { ApplyFlow } from './ApplyFlow.tsx';

export const dynamic = 'force-dynamic';

/** The trader application: five short steps, then the desk reviews it. Only for someone who may apply. */
export default async function ApplyPage() {
  const ctx = await clientPage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  if (home.state !== 'NONE' && home.state !== 'REJECTED') redirect('/traders');
  const options = await traderApplicationOptions(ctx.db, ctx.actor.userId);
  if (!options.canApply) redirect('/traders');
  return (
    <>
      <PageHead eyebrow="Traders" title="Become a trader" lede="Tell INRP2P what you can provide and how you settle. The desk reviews it before any order is sent to you." />
      <ApplyFlow options={options} />
    </>
  );
}
