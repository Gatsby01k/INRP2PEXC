import { notFound } from 'next/navigation';
import { Money, isDomainError } from '@inrp2p/kernel';
import { type PortalTrade, portalTrade } from '@inrp2p/portal';
import { clientPage } from '../../../../server/client.ts';
import { protectorForWeb } from '../../../../server/quotes.ts';
import { CopyButton } from '@inrp2p/ui';
import { formatUsdtHeadline } from '@inrp2p/ui/format';
import { StateRing } from '../../_workspace/StateRing.tsx';
import shell from '../../shell.module.css';
import workspace from '../../_workspace/workspace.module.css';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { StatusPill } from '../../_workspace/StatusPill.tsx';
import { TradeScreen } from './TradeScreen.tsx';
import { PhoneBar } from './PhoneBar.tsx';

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

  // The heading says the trade as the client made it — "Sell 8,000 USDT" — and, when the next move is theirs, says so in
  // the one orange pill; otherwise the trade's own state. The deal's own word for whose move it is decides (ADR 0019).
  const sell = view.trade.direction === 'SELL_USDT';
  const usdt = formatUsdtHeadline(Money.parse(view.trade.base.amount, 'USDT'), { unit: false });
  const disputed = view.p2p?.dispute?.status === 'OPEN';
  const yours = !view.onHold && !disputed && (view.p2p ? view.p2p.turn === (sell ? 'SELLER' : 'BUYER') : view.trade.status === 'AWAITING_FIRST_LEG');

  // What the other side said since this client last wrote: the phone bar's chat badge.
  const messages = view.p2p?.chat.messages ?? [];
  const waiting = messages.slice(messages.findLastIndex((m) => m.from === 'YOU') + 1).length;

  return (
    <>
      <PhoneBar tradeRef={view.trade.ref} chat={view.p2p !== null} waiting={waiting} />
      <PageHead
        back={{ href: '/history', label: 'History' }}
        eyebrow={<span className="ix-num">{view.trade.ref}</span>}
        title={
          <>
            {sell ? 'Sell' : 'Buy'} {usdt} <span className={shell.unit}>USDT</span>
          </>
        }
        status={
          yours ? (
            <span className={workspace.pill} data-tone="turn" data-size="lg">
              <StateRing state="turn" className={workspace.pillIcon} />
              Your move
            </span>
          ) : (
            <StatusPill status={view.trade.status} onHold={view.onHold} size="lg" />
          )
        }
        aside={
          <span className={shell.refPill}>
            <span className={shell.refPillWord}>Trade</span>
            <span className={shell.refPillRef}>{view.trade.ref}</span>
            <CopyButton value={view.trade.ref} label="trade reference" />
          </span>
        }
      />
      <TradeScreen view={view} justOpened={opened === '1' && view.trade.status !== 'CANCELLED'} initial={ctx.access.clientName.trim().charAt(0).toUpperCase()} />
    </>
  );
}
