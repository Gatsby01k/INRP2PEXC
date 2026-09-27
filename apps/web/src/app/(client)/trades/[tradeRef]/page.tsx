import { notFound } from 'next/navigation';
import { Money, Rate, isDomainError } from '@inrp2p/kernel';
import { formatInr, formatRate, formatUsdtHeadline } from '@inrp2p/ui/format';
import { type PortalTrade, portalTrade } from '@inrp2p/portal';
import { clientPage } from '../../../../server/client.ts';
import { at } from '../../_assistant/model.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { StatusPill } from '../../_workspace/StatusPill.tsx';
import { TradeScreen } from './TradeScreen.tsx';

/** What was agreed, in one line: what leaves the client, what reaches them, at what rate. */
function agreed(view: PortalTrade): string {
  const usdt = formatUsdtHeadline(Money.parse(view.trade.base.amount, 'USDT'));
  const inr = formatInr(Money.parse(view.trade.inr.amount, 'INR'));
  const rate = formatRate(Rate.parse(view.trade.clientRate, 'CLIENT'));
  return view.trade.direction === 'SELL_USDT' ? `${usdt} → ${inr} at ${rate}` : `${inr} → ${usdt} at ${rate}`;
}

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
        status={<StatusPill status={view.trade.status} onHold={view.onHold} size="lg" />}
        lede={`${agreed(view)} · started ${at(view.trade.openedAt)}`}
      />
      <TradeScreen view={view} />
    </>
  );
}
