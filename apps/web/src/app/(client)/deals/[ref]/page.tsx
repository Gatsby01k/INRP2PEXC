import { notFound } from 'next/navigation';
import { isDomainError } from '@inrp2p/kernel';
import { type TraderOrderDetail, traderOrderDetail } from '@inrp2p/traders';
import { CopyButton } from '@inrp2p/ui';
import { memberPage } from '../../../../server/client.ts';
import { protectorForWeb } from '../../../../server/quotes.ts';
import { PageHead } from '../../_workspace/PageHead.tsx';
import { OrderPill } from '../../traders/_ui/OrderPill.tsx';
import { usdt } from '../../traders/_ui/format.ts';
import { StateRing } from '../../_workspace/StateRing.tsx';
import { PhoneBar } from '../../trades/[tradeRef]/PhoneBar.tsx';
import { OrderScreen } from '../../traders/orders/[ref]/OrderScreen.tsx';
import shell from '../../shell.module.css';
import workspace from '../../_workspace/workspace.module.css';

export const dynamic = 'force-dynamic';

/**
 * ADR 0033: a client's deal as the other side of a meeting — another client took its price, and it is the route of that
 * one deal through its personal side. The deal's steps, payments, chat and dispute are the P2P deal's own; this page only
 * names it as the client's deal and leads back to the Exchange. Someone else's reference is "not found", never "forbidden".
 */
export default async function PeerDealPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const ctx = await memberPage();
  let detail: TraderOrderDetail;
  try {
    detail = await traderOrderDetail(ctx.db, ctx.actor.userId, decodeURIComponent(ref), protectorForWeb());
  } catch (e) {
    if (isDomainError(e) && e.code === 'NOT_FOUND') notFound();
    throw e;
  }
  const personal = await ctx.db.selectFrom('trader_order as o').innerJoin('trader_profile as t', 't.id', 'o.trader_id').select('t.status')
    .where('o.ref', '=', detail.order.ref).executeTakeFirst();
  if (personal?.status !== 'PERSONAL') notFound();
  const o = detail.order;
  const messages = detail.p2p?.chat.messages ?? [];
  const waiting = messages.slice(messages.findLastIndex((m) => m.from === 'YOU') + 1).length;
  const chat = detail.p2p !== null && o.status !== 'ACCEPTED' && o.status !== 'OFFERED';
  return (
    <>
      <PhoneBar tradeRef={o.ref} chat={chat} waiting={waiting} back={{ href: '/exchange', label: 'Exchange' }} />
      <PageHead
        back={{ href: '/exchange', label: 'Exchange' }}
        eyebrow={<span>With another INRP2P client</span>}
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
            <span className={shell.refPillWord}>Deal</span>
            <span className={shell.refPillRef}>{o.ref}</span>
            <CopyButton value={o.ref} label="deal reference" />
          </span>
        }
      />
      <OrderScreen detail={detail} canAct={ctx.member.canAcceptQuotes} initial={ctx.member.clientName.trim().charAt(0).toUpperCase()} personal />
    </>
  );
}
