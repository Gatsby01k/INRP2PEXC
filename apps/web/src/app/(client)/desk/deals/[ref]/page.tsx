import { notFound, redirect } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type DeskDeal, type TraderOrderDetail, deskDeal, deskWorkspace, traderOrderDetail } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { memberPage } from '../../../../../server/client.ts';
import { protectorForWeb } from '../../../../../server/quotes.ts';
import { OrderScreen } from '../../../traders/orders/[ref]/OrderScreen.tsx';
import { DeskHead } from '../../_ui/DeskHead.tsx';
import { DealStatus } from '../../_ui/DeskStatus.tsx';
import { inr, rate, usdt } from '../../_ui/format.ts';
import { DealsIcon } from '../../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * One deal of the desk: who it is with and what it comes to — the client's side, the desk's USDT and INRP2P's fee — over
 * the deal's own steps, which are a trader order's (the escrow, the rupees, the confirmation). Another desk's deal is
 * "not found".
 */
export default async function DeskDealPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref: raw } = await params;
  const ref = decodeURIComponent(raw);
  const ctx = await memberPage();
  const ws = await deskWorkspace(ctx.db, ctx.actor.userId);
  if (!ws.desk) redirect('/desk');
  let deal: DeskDeal;
  let detail: TraderOrderDetail;
  try {
    deal = await deskDeal(ctx.db, ctx.actor.userId, ref);
    detail = await traderOrderDetail(ctx.db, ctx.actor.userId, ref, protectorForWeb());
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const sells = deal.direction === 'SELL_USDT';
  return (
    <>
      <DeskHead
        icon={<DealsIcon />}
        eyebrow={`Deal ${deal.ref}${deal.via === 'LINK' ? ' · by link' : ''}`}
        title={deal.clientName}
        status={<DealStatus state={deal.state} yourMove={deal.yourMove} inReview={deal.stage === 'REVIEW'} />}
        lede={
          sells
            ? `Sells you ${usdt(deal.usdt)} at ${rate(deal.rate)} · you pay ${inr(deal.inr)} and receive ${usdt(deal.deskUsdt)} · INRP2P fee ${usdt(deal.fee)} · ${formatIstDateTime(new Date(deal.at))}`
            : `Buys ${usdt(deal.usdt)} at ${rate(deal.rate)} · pays you ${inr(deal.inr)} · you put ${usdt(deal.deskUsdt)} in escrow · INRP2P fee ${usdt(deal.fee)} · ${formatIstDateTime(new Date(deal.at))}`
        }
      />
      <OrderScreen detail={detail} canAct={ctx.member.canAcceptQuotes} />
    </>
  );
}
