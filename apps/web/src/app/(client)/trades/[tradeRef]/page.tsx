import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type PortalTrade, portalTrade } from '@inrp2p/portal';
import { clientPage } from '../../../../server/client.ts';
import { at } from '../../_assistant/model.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { StatusPill } from '../../_workspace/StatusPill.tsx';
import { TradeScreen } from './TradeScreen.tsx';

export const dynamic = 'force-dynamic';

/**
 * One trade, as its client sees it (UX_FLOWS F1 step 6).
 *
 * The trade is found by the reference the client already has, and only within their own client — another
 * client's reference is "not found", never "forbidden", so this page tells nobody what else exists.
 */
export default async function TradePage({ params }: { params: Promise<{ tradeRef: string }> }) {
  const { tradeRef } = await params;
  const ctx = await clientPage();
  let view: PortalTrade;
  try {
    view = await portalTrade(ctx.db, ctx.access.clientId, decodeURIComponent(tradeRef));
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }

  return (
    <>
      <PageHead
        eyebrow={view.trade.direction === 'SELL_USDT' ? 'Trade · Sell USDT' : 'Trade · Buy USDT'}
        title={view.trade.ref}
        lede={`Started ${at(view.trade.openedAt)}`}
        aside={<StatusPill status={view.trade.status} onHold={view.onHold} />}
      />
      <TradeScreen view={view} />
    </>
  );
}
