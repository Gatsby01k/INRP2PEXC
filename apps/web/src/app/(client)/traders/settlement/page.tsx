import { redirect } from 'next/navigation';
import { clientDestinations } from '@inrp2p/portal';
import { traderHome, traderProgram } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { SettlementChange } from './SettlementChange.tsx';
import { UpiIdsCard } from '../../destinations/UpiIds.tsx';
import { BankIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * A new bank account or TRC20 wallet, submitted by the trader (TD-24). While an application is under review it replaces
 * the detail the application named; once approved it waits beside the registered one — through the programme's hold,
 * with every member told — which keeps settling every order until the change takes effect (ADR 0024).
 */
export default async function SettlementPage() {
  const ctx = await memberPage();
  const [home, program, destinations] = await Promise.all([traderHome(ctx.db, ctx.actor.userId), traderProgram(ctx.db), clientDestinations(ctx.db, ctx.member.clientId)]);
  if (!home.canApply || (home.state !== 'UNDER_REVIEW' && home.state !== 'APPROVED' && home.state !== 'PAUSED')) redirect('/traders');
  const working = home.state !== 'UNDER_REVIEW';
  return (
    <>
      <PageHead
        icon={<BankIcon />}
        eyebrow="Traders"
        title="Settlement details"
        lede={working ? 'Your UPI IDs, and a new bank account or wallet. Your current details keep working until a change takes effect.' : 'Replace the bank account or wallet in your application. It is checked before anything settles through it.'}
      />
      <SettlementChange
        working={working}
        current={{ bank: home.application?.bank.label ?? null, wallet: home.application?.wallet.label ?? null }}
        openOrders={home.openOrders}
        holdHours={program.settlementChangeHoldHours}
      >
        {/* ADR 0029: the UPI IDs buyers pay this trader to — added any time, each checked by a person before it is used. */}
        <UpiIdsCard
          upiIds={destinations.upiIds}
          isAdmin={ctx.member.role === 'CLIENT_ADMIN'}
          holderName={destinations.banks.find((b) => b.status === 'ACTIVE')?.holderName ?? ctx.member.clientName}
          clientName={ctx.member.clientName}
        />
      </SettlementChange>
    </>
  );
}
