'use client';

import { useState } from 'react';
import type { PayoutAccountOption, TreasuryWalletOption } from '@inrp2p/desk';
import type { DeskOrderRow, DeskTraderDetail } from '@inrp2p/traders';
import { Button, UTRField, normalizeUtr } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { confirmOrderSettlementAction, recordOrderSettlementAction, releaseOrderAction } from '../../../../server/actions/traders-desk.ts';
import type { TraderPerms } from './TraderControls.tsx';
import styles from '../traders.module.css';

const TONE: Record<string, string | undefined> = { OFFERED: 'brand', ACCEPTED: 'warn', IN_PROGRESS: 'warn', COMPLETED: 'good' };

/**
 * One order's settlement from the desk's side. The trader's INR claim, or its USDT seen at the order address, is
 * already recorded as a route settlement; the desk confirms INR against the bank (⧗), records and confirms
 * INRP2P's own side, and the order is brought up to date straight after.
 */
function OrderSettlement({ order, detail, accounts, wallets, perms }: { order: DeskOrderRow; detail: DeskTraderDetail; accounts: readonly PayoutAccountOption[]; wallets: readonly TreasuryWalletOption[]; perms: TraderPerms }) {
  const cmd = useCommand();
  const buy = order.side === 'BUY_USDT';
  const [txHash, setTxHash] = useState('');
  const [walletId, setWalletId] = useState(wallets[0]?.walletId ?? '');
  const [utr, setUtr] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.accountId ?? '');
  const [claimUtr, setClaimUtr] = useState('');
  const pendingOurs = order.settlements.some((s) => s.side === 'EXCHANGE_DELIVERS' && s.status === 'RECORDED');
  const pendingTheirs = order.settlements.some((s) => s.side === 'ROUTE_DELIVERS' && s.status === 'RECORDED');

  return (
    <div className={styles.form}>
      {order.settlements.length > 0 ? (
        <ul className={styles.settlements}>
          {order.settlements.map((s) => (
            <li key={s.id}>
              <span>
                {s.ref} · {s.side === 'ROUTE_DELIVERS' ? 'from the trader' : 'to the trader'} · {s.amount} {s.asset} · {s.status.toLowerCase()}
              </span>
              {s.reference ? <span className={styles.mono}>{s.reference}</span> : null}
              {s.status === 'RECORDED' && perms.routeConfirm ? (
                <Button intent="primary" disabled={cmd.busy} onClick={() => cmd.run(`Confirm ${s.ref}`, (key) => confirmOrderSettlementAction({ orderId: order.orderId, routeSettlementId: s.id }, key))}>
                  Confirm
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {order.status === 'IN_PROGRESS' && perms.routeRecord && order.routeObligationId ? (
        <>
          {buy && order.traderOwes && !pendingTheirs && detail.program.collectionAccountId ? (
            <div className={styles.row}>
              <UTRField value={claimUtr} onChange={setClaimUtr} label={`Trader’s INR payment (₹${order.traderOwes}) — UTR`} />
              <div>
                <Button
                  disabled={cmd.busy || normalizeUtr(claimUtr).length < 6}
                  onClick={() =>
                    cmd.run(`Record the trader’s payment on ${order.ref}`, (key) =>
                      recordOrderSettlementAction({ routeObligationId: order.routeObligationId!, flow: 'FROM_ROUTE_TO_EXCHANGE', amount: order.traderOwes!, rail: 'IMPS', utr: normalizeUtr(claimUtr), inrAccountId: detail.program.collectionAccountId }, key),
                    )
                  }
                >
                  Record on the trader’s behalf
                </Button>
              </div>
            </div>
          ) : null}
          {order.inrp2pOwes && !pendingOurs && !order.traderOwes ? (
            buy ? (
              <div className={styles.row}>
                <div className="ix-field">
                  <label htmlFor={`tx-${order.orderId}`}>USDT sent to the trader ({order.inrp2pOwes}) — transaction hash</label>
                  <input id={`tx-${order.orderId}`} className="ix-input" value={txHash} onChange={(e) => setTxHash(e.target.value)} />
                </div>
                <div className="ix-field">
                  <label htmlFor={`w-${order.orderId}`}>From</label>
                  <select id={`w-${order.orderId}`} className="ix-input" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
                    {wallets.map((w) => (
                      <option key={w.walletId} value={w.walletId}>
                        {w.label} · {w.available} USDT
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Button
                    disabled={cmd.busy || txHash.trim().length < 10 || walletId === ''}
                    onClick={() =>
                      cmd.run(`Record USDT to ${detail.trader.ref}`, (key) =>
                        recordOrderSettlementAction({ routeObligationId: order.routeObligationId!, flow: 'TO_ROUTE', amount: order.inrp2pOwes!, txHash: txHash.trim(), logIndex: 0, treasuryWalletId: walletId }, key),
                      )
                    }
                  >
                    Record USDT sent
                  </Button>
                </div>
              </div>
            ) : (
              <div className={styles.row}>
                <UTRField value={utr} onChange={setUtr} label={`INR paid to the trader (₹${order.inrp2pOwes}) — UTR`} />
                <div className="ix-field">
                  <label htmlFor={`a-${order.orderId}`}>From</label>
                  <select id={`a-${order.orderId}`} className="ix-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                    {accounts.map((a) => (
                      <option key={a.accountId} value={a.accountId}>
                        {a.bankName} ••••{a.last4} · ₹{a.availableToday} today
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Button
                    disabled={cmd.busy || normalizeUtr(utr).length < 6 || accountId === ''}
                    onClick={() =>
                      cmd.run(`Record INR to ${detail.trader.ref}`, (key) =>
                        recordOrderSettlementAction({ routeObligationId: order.routeObligationId!, flow: 'TO_ROUTE', amount: order.inrp2pOwes!, rail: 'IMPS', utr: normalizeUtr(utr), inrAccountId: accountId }, key),
                      )
                    }
                  >
                    Record INR paid
                  </Button>
                </div>
              </div>
            )
          ) : null}
        </>
      ) : null}
      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}

/** Every order of the trader, newest first: open and unresolved ones with their settlement controls. */
export function TraderOrders({ detail, accounts, wallets, perms }: { detail: DeskTraderDetail; accounts: readonly PayoutAccountOption[]; wallets: readonly TreasuryWalletOption[]; perms: TraderPerms }) {
  const cmd = useCommand();
  const [why, setWhy] = useState('');
  return (
    <section className="ix-card" aria-label="Orders">
      <h2 className="ix-sectionTitle">Orders</h2>
      {detail.orders.length === 0 ? <p className="ix-muted">No orders yet.</p> : null}
      {detail.orders.map((o) => (
        <div key={o.orderId} className={styles.order}>
          <div className={styles.orderHead}>
            <strong>{o.ref}</strong>
            <span>{o.side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT'}</span>
            <span className={styles.tag} data-tone={TONE[o.status]}>
              {o.status.toLowerCase().replace('_', ' ')}
            </span>
            <span className="ix-num">
              {o.usdt} USDT · ₹{o.inr} at ₹{o.rate}
            </span>
            <span className="ix-muted">
              {o.requestRef}
              {o.tradeRef ? ` → ${o.tradeRef} (${(o.tradeState ?? '').toLowerCase().replace(/_/g, ' ')})` : ''}
            </span>
            <span className="ix-muted">{formatIstDateTime(new Date(o.startedAt ?? o.offeredAt))}</span>
            {o.reward ? <span className="ix-muted">reward ₹{o.reward}</span> : null}
          </div>
          {o.status === 'IN_PROGRESS' ? (
            <div className="ix-muted">
              Trader owes {o.traderOwes ? `${o.traderOwes} ${o.side === 'BUY_USDT' ? 'INR' : 'USDT'}` : 'nothing'} · INRP2P owes {o.inrp2pOwes ? `${o.inrp2pOwes} ${o.side === 'BUY_USDT' ? 'USDT' : 'INR'}` : 'nothing'}
              {o.deliveryAddress ? <span className={styles.mono}> · delivery address {o.deliveryAddress}</span> : null}
            </div>
          ) : null}
          {o.closeNote ? <div className="ix-muted">{o.closeNote}</div> : null}
          <OrderSettlement order={o} detail={detail} accounts={accounts} wallets={wallets} perms={perms} />
          {(o.status === 'OFFERED' || o.status === 'ACCEPTED') && perms.assign ? (
            <div className={styles.row}>
              <div className="ix-field">
                <label htmlFor={`rel-${o.orderId}`}>Reason</label>
                <input id={`rel-${o.orderId}`} className="ix-input" value={why} onChange={(e) => setWhy(e.target.value)} />
              </div>
              <div>
                <Button intent="ghost" disabled={cmd.busy || why.trim().length < 3} onClick={() => cmd.run(`Release ${o.ref}`, (key) => releaseOrderAction({ orderId: o.orderId, reason: why.trim() }, key))}>
                  {o.status === 'OFFERED' ? 'Withdraw offer' : 'Release order'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </section>
  );
}
