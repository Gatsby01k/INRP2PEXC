'use client';

import Link from 'next/link';
import type { DeskOrderRow, DeskTraderDetail } from '@inrp2p/traders';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { releaseOrderAction } from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { dateTime, inr, rate, titleCase, usdt } from '../../_desk/format.ts';
import { Chip, Empty, Notice, Side } from '../../_desk/ui.tsx';
import type { TraderPerms } from './TraderControls.tsx';
import d from '../../_desk/desk.module.css';
import t from '../../_trade/trade.module.css';

const TONE: Record<string, 'brand' | 'warning' | 'success' | 'muted' | 'neutral'> = { OFFERED: 'brand', ACCEPTED: 'warning', IN_PROGRESS: 'warning', COMPLETED: 'success' };

/**
 * One order's USDT, as the chain has it: the trader's into the deal's escrow and, once the rupees are confirmed, the signer's
 * out to the trader (ADR 0019). Nothing here is the desk's to record: the chain settles these, and a payment INRP2P has to
 * decide is on the trade itself.
 */
function OrderSettlement({ order }: { order: DeskOrderRow }) {
  if (order.settlements.length === 0) return null;
  return (
    <ul className={d.stackTight} style={{ margin: 0, padding: 0, listStyle: 'none', gap: 4 }}>
      {order.settlements.map((s) => (
        <li key={s.id} className={d.row}>
          <strong className={d.num}>{s.asset === 'INR' ? inr(s.amount) : usdt(s.amount, { exact: true })}</strong>
          <span className={d.muted}>
            {s.side === 'ROUTE_DELIVERS' ? 'from the trader' : 'to the trader'} · {s.ref}
            {s.reference ? ` · ${s.asset === 'INR' ? `UTR ${maskUtr(s.reference)}` : `tx ${shortenHash(s.reference)}`}` : ''}
          </span>
          <Chip tone={s.status === 'CONFIRMED' ? 'success' : s.status === 'FAILED' ? 'danger' : 'warning'}>{s.status.toLowerCase()}</Chip>
        </li>
      ))}
    </ul>
  );
}

/** Every order of the trader, newest first: open and unresolved ones with their settlement controls. */
export function TraderOrders({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  if (detail.orders.length === 0) return <Empty title="No orders yet" body="Orders appear here when the desk routes a request to this trader." />;
  return (
    <ul className={t.legs}>
      {detail.orders.map((o) => (
        <li key={o.orderId} className={t.leg} {...(o.status === 'IN_PROGRESS' || o.status === 'OFFERED' ? { 'data-attention': '' } : {})}>
          <div className={t.legHead}>
            <span className={d.row}>
              <Side direction={o.side} />
              <span className={t.legAmount}>
                {usdt(o.usdt)} · {inr(o.inr)}
              </span>
              <span className={d.muted}>at {rate(o.rate)}</span>
            </span>
            <Chip tone={TONE[o.status] ?? 'neutral'}>{titleCase(o.status)}</Chip>
          </div>
          <div className={t.legMeta}>
            <span>{o.ref}</span>
            <span>{o.requestRef}</span>
            {o.tradeRef ? (
              <span>
                <Link href={`/orders/${encodeURIComponent(o.tradeRef)}`} className={d.link}>
                  {o.tradeRef}
                </Link>{' '}
                {(o.tradeState ?? '').toLowerCase().replace(/_/g, ' ')}
              </span>
            ) : null}
            <span>{dateTime(o.startedAt ?? o.offeredAt)}</span>
          </div>
          {o.status === 'IN_PROGRESS' ? (
            <Notice>
              Trader owes {o.traderOwes ? (o.side === 'BUY_USDT' ? inr(o.traderOwes) : usdt(o.traderOwes, { exact: true })) : 'nothing'} · INRP2P owes{' '}
              {o.inrp2pOwes ? (o.side === 'BUY_USDT' ? usdt(o.inrp2pOwes, { exact: true }) : inr(o.inrp2pOwes)) : 'nothing'}
              {o.deliveryAddress ? ` · delivery address ${o.deliveryAddress}` : ''}
            </Notice>
          ) : null}
          {o.closeNote ? <Notice>{o.closeNote}</Notice> : null}
          <OrderSettlement order={o} />
          {(o.status === 'OFFERED' || o.status === 'ACCEPTED') && perms.assign ? (
            <GuardedAction
              label={o.status === 'OFFERED' ? 'Withdraw offer' : 'Release order'}
              trigger="ghost"
              tone="danger"
              busy={cmd.busy}
              consequence={o.status === 'OFFERED' ? 'The offer is withdrawn; the request goes back to the desk to quote or route again.' : 'The trader’s hold ends and the request goes back to the desk. Nothing has moved yet.'}
              reasonLabel="Reason"
              onConfirm={async (reason) => (await cmd.run(`Release ${o.ref}`, (key) => releaseOrderAction({ orderId: o.orderId, reason }, key))).ok}
            />
          ) : null}
        </li>
      ))}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </ul>
  );
}
