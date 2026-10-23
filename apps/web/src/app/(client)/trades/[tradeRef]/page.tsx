import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type PortalTrade, portalTrade } from '@inrp2p/portal';
import { clientPage } from '../../../../server/client.ts';
import { protectorForWeb } from '../../../../server/quotes.ts';
import { at } from '../../_assistant/model.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { StatusPill } from '../../_workspace/StatusPill.tsx';
import { TradeScreen } from './TradeScreen.tsx';
import { SwapIcon } from '../../_workspace/icons.tsx';

export const dynamic = 'force-dynamic';

/**
 * One trade, as its client sees it (UX_FLOWS F1 step 6).
 *
 * The trade is found by the reference the client already has, and only within their own client — another
 * client's reference is "not found", never "forbidden", so this page tells nobody what else exists.
 */
export default async function TradePage({ params, searchParams }: { params: Promise<{ tradeRef: string }>; searchParams: Promise<{ opened?: string | string[] }> }) {
  const [{ tradeRef }, { opened }] = await Promise.all([params, searchParams]);
  const ctx = await clientPage();
  let view: PortalTrade;
  try {
    view = await portalTrade(ctx.db, ctx.access.clientId, decodeURIComponent(tradeRef), { protector: protectorForWeb() });
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }

  return (
    <>
      <PageHead
        icon={<SwapIcon />}
        eyebrow={view.trade.direction === 'SELL_USDT' ? 'Trade · Sell USDT' : 'Trade · Buy USDT'}
        title={view.trade.ref}
        status={<StatusPill status={view.trade.status} onHold={view.onHold} size="lg" />}
        lede={`Started ${at(view.trade.openedAt)}${view.completedAt ? ` · settled ${at(view.completedAt)}` : ''}`}
      />
      <TradeScreen view={view} justOpened={opened === '1' && view.trade.status !== 'CANCELLED'} />
    </>
  );
}
