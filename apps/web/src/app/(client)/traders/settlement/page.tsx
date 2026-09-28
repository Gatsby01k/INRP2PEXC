import { redirect } from 'next/navigation';
import { traderHome } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { SettlementChange } from './SettlementChange.tsx';

export const dynamic = 'force-dynamic';

/**
 * A new bank account or TRC20 wallet, submitted by the trader for the desk to review (TD-24). While an application is
 * under review it replaces the detail the application named; once approved it waits beside the registered one, which
 * keeps settling every order until the desk approves the change.
 */
export default async function SettlementPage() {
  const ctx = await memberPage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  if (!home.canApply || (home.state !== 'UNDER_REVIEW' && home.state !== 'APPROVED' && home.state !== 'PAUSED')) redirect('/traders');
  const working = home.state !== 'UNDER_REVIEW';
  return (
    <>
      <PageHead
        eyebrow="Traders"
        title="New settlement details"
        lede={working ? 'Submit a new bank account or wallet. The desk reviews it; until it approves, your current details keep working.' : 'Replace the bank account or wallet in your application. The desk reviews it before anything settles through it.'}
      />
      <SettlementChange
        working={working}
        current={{ bank: home.application?.bank.label ?? null, wallet: home.application?.wallet.label ?? null }}
        openOrders={home.openOrders}
      />
    </>
  );
}
