import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type TraderOrderDetail, traderOrderDetail } from '@inrp2p/traders';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { memberPage } from '../../../../../server/client.ts';
import { protectorForWeb } from '../../../../../server/quotes.ts';
import { PageHead } from '../../../_workspace/PageHead.tsx';
import { OrderPill } from '../../_ui/OrderPill.tsx';
import { sideTitle, usdt } from '../../_ui/format.ts';
import { OrderScreen } from './OrderScreen.tsx';

export const dynamic = 'force-dynamic';

/** One order, as its trader sees it. Another trader's reference is "not found", never "forbidden". */
export default async function TraderOrderPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const ctx = await memberPage();
  let detail: TraderOrderDetail;
  try {
    detail = await traderOrderDetail(ctx.db, ctx.actor.userId, decodeURIComponent(ref), protectorForWeb());
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const o = detail.order;
  return (
    <>
      <PageHead
        eyebrow={`Order · ${sideTitle(o.side)}`}
        title={o.ref}
        status={<OrderPill stage={o.stage} status={o.status} size="lg" />}
        lede={`${o.side === 'BUY_USDT' ? 'Buy' : 'Sell'} ${usdt(o.usdt)} · offered ${formatIstDateTime(new Date(o.offeredAt))}`}
      />
      <OrderScreen detail={detail} canAct={ctx.member.canAcceptQuotes} />
    </>
  );
}
