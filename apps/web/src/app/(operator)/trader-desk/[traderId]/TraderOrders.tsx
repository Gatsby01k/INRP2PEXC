'use client';

import Link from 'next/link';
import type { DeskOrderRow, DeskTraderDetail } from '@inrp2p/traders';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { releaseOrderAction } from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { dateTime, inr, rate, titleCase, usdt } from '../../_desk/format.ts';
import { Chip, Empty, Side } from '../../_desk/ui.tsx';
import { bookStyles as b } from '../../_book/parts.tsx';
import type { TraderPerms } from '../words.tsx';
import d from '../../_desk/desk.module.css';

const TONE: Record<string, 'brand' | 'warning' | 'success' | 'muted' | 'neutral'> = { OFFERED: 'brand', ACCEPTED: 'warning', IN_PROGRESS: 'warning', COMPLETED: 'success', RELEASED: 'muted', EXPIRED: 'muted', DECLINED: 'muted' };
const GLYPH: Record<string, 'done' | 'partial' | 'pending' | 'closed'> = { OFFERED: 'pending', ACCEPTED: 'partial', IN_PROGRESS: 'partial', COMPLETED: 'done' };

/** What one side still owes the other on an order, in the asset it owes. */
function owed(o: DeskOrderRow, who: 'trader' | 'inrp2p'): string | null {
  const v = who === 'trader' ? o.traderOwes : o.inrp2pOwes;
  if (!v) return null;
  const inrSide = (who === 'trader') === (o.side === 'BUY_USDT');
  return inrSide ? inr(v) : usdt(v, { exact: true });
}

/**
 * One order's money, as the chain and the bank have it: the trader's into the deal's escrow and, once the rupees are
 * confirmed, the signer's out to the trader (ADR 0019). Nothing here is the desk's to record.
 */
function Legs({ order }: { order: DeskOrderRow }) {
  if (order.settlements.length === 0) return null;
  return (
    <ul className={b.legs}>
      {order.settlements.map((s) => (
        <li key={s.id}>
          <strong>{s.asset === 'INR' ? inr(s.amount) : usdt(s.amount, { exact: true })}</strong>
          <span>
            {s.side === 'ROUTE_DELIVERS' ? 'from the trader' : 'to the trader'} · {s.ref}
            {s.reference ? ` · ${s.asset === 'INR' ? `UTR ${maskUtr(s.reference)}` : `tx ${shortenHash(s.reference)}`}` : ''}
          </span>
          <Chip tone={s.status === 'CONFIRMED' ? 'success' : s.status === 'FAILED' ? 'danger' : 'warning'}>{s.status.toLowerCase()}</Chip>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every order of the trader, newest first, as one ledger: the side, the amounts and the rate, which request and trade it
 * belongs to, its state — and, under an open one, what each side still owes, its legs and the desk's one control on it.
 */
export function TraderOrders({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  if (detail.orders.length === 0) return <Empty title="No orders yet" body="Orders appear here when a request is routed to this trader." />;
  return (
    <ul className={b.ledger}>
      {detail.orders.map((o) => {
        const traderOwes = owed(o, 'trader');
        const inrp2pOwes = owed(o, 'inrp2p');
        const live = o.status === 'IN_PROGRESS' || o.status === 'ACCEPTED' || o.status === 'OFFERED';
        const releasable = (o.status === 'OFFERED' || o.status === 'ACCEPTED') && perms.assign;
        const more = (o.status === 'IN_PROGRESS' && (traderOwes || inrp2pOwes)) || o.closeNote || o.settlements.length > 0 || releasable;
        return (
          <li key={o.orderId} className={b.order} {...(traderOwes ? { 'data-owed': '' } : live ? { 'data-attention': '' } : {})}>
            <Side direction={o.side} />
            <span className={b.orderAmounts}>
              <span className={b.orderFigure}>
                {usdt(o.usdt)} <span>· {inr(o.inr)}</span>
              </span>
              <span className={b.rowSub}>
                at {rate(o.rate)} · {dateTime(o.startedAt ?? o.offeredAt)}
              </span>
            </span>
            <span className={b.orderRefs}>
              <span>
                {o.tradeRef ? (
                  <Link href={`/orders/${encodeURIComponent(o.tradeRef)}`} className={d.link}>
                    {o.tradeRef}
                  </Link>
                ) : (
                  <span className={d.secondary}>{o.requestRef}</span>
                )}
                {o.tradeState ? ` · ${o.tradeState.toLowerCase().replace(/_/g, ' ')}` : ''}
              </span>
              <span className={d.mono}>{o.tradeRef ? `${o.ref} · ${o.requestRef}` : o.ref}</span>
            </span>
            <span className={b.orderEnd}>
              <Chip tone={TONE[o.status] ?? 'neutral'} {...(GLYPH[o.status] ? { glyph: GLYPH[o.status] } : {})}>
                {titleCase(o.status)}
              </Chip>
            </span>
            {more ? (
              <div className={b.orderMore}>
                {o.status === 'IN_PROGRESS' && (traderOwes || inrp2pOwes) ? (
                  <p className={b.owes}>
                    <span>
                      Trader owes <b>{traderOwes ?? 'nothing'}</b>
                    </span>
                    <span>
                      INRP2P owes <b>{inrp2pOwes ?? 'nothing'}</b>
                    </span>
                    {o.deliveryAddress ? <span className={d.mono}>escrow {shortenHash(o.deliveryAddress)}</span> : null}
                  </p>
                ) : null}
                {o.closeNote ? <p className={b.quiet}>{o.closeNote}</p> : null}
                <Legs order={o} />
                {releasable ? (
                  <div className={d.actions}>
                    <GuardedAction
                      label={o.status === 'OFFERED' ? 'Withdraw offer' : 'Release order'}
                      trigger="ghost"
                      tone="danger"
                      busy={cmd.busy}
                      consequence={o.status === 'OFFERED' ? 'The offer is withdrawn; the request goes back to the desk to quote or route again.' : 'The trader’s hold ends and the request goes back to the desk. Nothing has moved yet.'}
                      reasonLabel="Reason"
                      onConfirm={async (reason) => (await cmd.run(`Release ${o.ref}`, (key) => releaseOrderAction({ orderId: o.orderId, reason }, key))).ok}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
      {cmd.error ? (
        <li className={d.errorLine} role="alert" style={{ padding: 'var(--space-3) var(--space-5)' }}>
          {cmd.error}
        </li>
      ) : null}
      {cmd.dialog}
    </ul>
  );
}
