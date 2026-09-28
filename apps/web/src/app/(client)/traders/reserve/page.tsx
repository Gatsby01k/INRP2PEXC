import { redirect } from 'next/navigation';
import { traderHome } from '@inrp2p/traders';
import { memberPage } from '../../../../server/client.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { ReserveScreen } from './ReserveScreen.tsx';

export const dynamic = 'force-dynamic';

/** The Security Reserve: what is held, what is locked, how to add to it and how to take back what is free. */
export default async function ReservePage() {
  const ctx = await memberPage();
  const home = await traderHome(ctx.db, ctx.actor.userId);
  if (!home.reserve) redirect('/traders');
  return (
    <>
      <PageHead eyebrow="Traders" title="Security Reserve" lede="A USDT reserve, kept separate from your trading capacity. It is locked while you provide liquidity and released after your orders finish." />
      <ReserveScreen home={home} />
    </>
  );
}
