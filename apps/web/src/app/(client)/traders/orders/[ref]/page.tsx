import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type TraderOrderDetail, traderOrderDetail } from '@inrp2p/traders';
import { CopyButton } from '@inrp2p/ui';
import { memberPage } from '../../../../../server/client.ts';
import { protectorForWeb } from '../../../../../server/quotes.ts';
import { PageHead } from '../../../_workspace/PageHead.tsx';
import { OrderPill } from '../../_ui/OrderPill.tsx';
import { usdt } from '../../_ui/format.ts';
import { StateRing } from '../../../_workspace/StateRing.tsx';
import { PhoneBar } from '../../../trades/[tradeRef]/PhoneBar.tsx';
import shell from '../../../shell.module.css';
import workspace from '../../../_workspace/workspace.module.css';
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
  // What the other side said since this trader last wrote: the phone bar's chat badge.
  const messages = detail.p2p?.chat.messages ?? [];
  const waiting = messages.slice(messages.findLastIndex((m) => m.from === 'YOU') + 1).length;
  const chat = detail.p2p !== null && o.status !== 'ACCEPTED' && o.status !== 'OFFERED';
  return (
    <>
      <PhoneBar tradeRef={o.ref} chat={chat} waiting={waiting} back={{ href: '/traders/orders', label: 'Orders' }} />
      {/* The heading says the order as the trader takes it — "Buy 9,732.82 USDT" — and, when the move is the
          trader's, says so in the one orange pill; otherwise the order's own state. */}
      <PageHead
        back={{ href: '/traders/orders', label: 'Orders' }}
        eyebrow={<span className="ix-num">{o.ref}</span>}
        title={
          <>
            {o.side === 'BUY_USDT' ? 'Buy' : 'Sell'} {usdt(o.usdt).replace(' USDT', '')} <span className={shell.unit}>USDT</span>
          </>
        }
        status={
          o.stage === 'YOUR_TURN' ? (
            <span className={workspace.pill} data-tone="turn" data-size="lg">
              <StateRing state="turn" className={workspace.pillIcon} />
              Your move
            </span>
          ) : (
            <OrderPill stage={o.stage} status={o.status} size="lg" />
          )
        }
        aside={
          <span className={shell.refPill}>
            <span className={shell.refPillWord}>Order</span>
            <span className={shell.refPillRef}>{o.ref}</span>
            <CopyButton value={o.ref} label="order reference" />
          </span>
        }
      />
      <OrderScreen detail={detail} canAct={ctx.member.canAcceptQuotes} initial={ctx.member.clientName.trim().charAt(0).toUpperCase()} />
    </>
  );
}
