'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { PayoutAccountOption, TreasuryWalletOption } from '@inrp2p/desk';
import type { DeskOrderRow, DeskTraderDetail } from '@inrp2p/traders';
import { Button, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { confirmOrderSettlementAction, recordOrderSettlementAction, releaseOrderAction } from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { SelectField, TextField } from '../../_desk/fields.tsx';
import { dateTime, inr, rate, titleCase, usdt } from '../../_desk/format.ts';
import { Chip, Empty, Notice, Side } from '../../_desk/ui.tsx';
import type { TraderPerms } from './TraderControls.tsx';
import d from '../../_desk/desk.module.css';
import t from '../../_trade/trade.module.css';

const TONE: Record<string, 'brand' | 'warning' | 'success' | 'muted' | 'neutral'> = { OFFERED: 'brand', ACCEPTED: 'warning', IN_PROGRESS: 'warning', COMPLETED: 'success' };

/**
 * One order's settlement from the desk's side. The trader's INR claim, or its USDT seen at the order address, is
 * already recorded as a route settlement; the desk confirms INR against the bank (⧗), records and confirms INRP2P's
 * own side, and the order is brought up to date straight after.
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
  const step = <StepUpMark label="needs your authenticator code" />;

  return (
    <div className={d.stackTight}>
      {order.settlements.length > 0 ? (
        <ul className={d.stackTight} style={{ margin: 0, padding: 0, listStyle: 'none', gap: 4 }}>
          {order.settlements.map((s) => (
            <li key={s.id} className={d.row}>
              <strong className={d.num}>{s.asset === 'INR' ? inr(s.amount) : usdt(s.amount, { exact: true })}</strong>
              <span className={d.muted}>
                {s.side === 'ROUTE_DELIVERS' ? 'from the trader' : 'to the trader'} · {s.ref}
                {s.reference ? ` · ${s.asset === 'INR' ? `UTR ${maskUtr(s.reference)}` : `tx ${shortenHash(s.reference)}`}` : ''}
              </span>
              <Chip tone={s.status === 'CONFIRMED' ? 'success' : s.status === 'FAILED' ? 'danger' : 'warning'}>{s.status.toLowerCase()}</Chip>
              {s.status === 'RECORDED' && perms.routeConfirm ? (
                <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy} onClick={() => cmd.run(`Confirm ${s.ref}`, (key) => confirmOrderSettlementAction({ orderId: order.orderId, routeSettlementId: s.id }, key))}>
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
            <div className={d.guard}>
              <p className={d.guardTitle}>The trader’s INR payment ({inr(order.traderOwes)})</p>
              <UTRField value={claimUtr} onChange={setClaimUtr} label="Trader’s UTR" />
              <div className={d.actions}>
                <Button
                  size="sm"
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
              <div className={d.guard}>
                <p className={d.guardTitle}>USDT to the trader ({usdt(order.inrp2pOwes, { exact: true })})</p>
                <div className={d.formGrid}>
                  <TextField label="Transaction hash" value={txHash} onChange={setTxHash} mono />
                  <SelectField label="From" value={walletId} onChange={setWalletId} options={wallets.map((w) => ({ value: w.walletId, label: `${w.label} · ${w.available} USDT` }))} />
                </div>
                <div className={d.actions}>
                  <Button
                    size="sm"
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
              <div className={d.guard}>
                <p className={d.guardTitle}>INR to the trader ({inr(order.inrp2pOwes)})</p>
                <div className={d.formGrid}>
                  <UTRField value={utr} onChange={setUtr} label="UTR" />
                  <SelectField label="From" value={accountId} onChange={setAccountId} options={accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${inr(a.availableToday)} today` }))} />
                </div>
                <div className={d.actions}>
                  <Button
                    size="sm"
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
        <p className={d.errorLine} role="alert">
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
            {o.reward ? <span>reward {inr(o.reward)}</span> : null}
          </div>
          {o.status === 'IN_PROGRESS' ? (
            <Notice>
              Trader owes {o.traderOwes ? (o.side === 'BUY_USDT' ? inr(o.traderOwes) : usdt(o.traderOwes, { exact: true })) : 'nothing'} · INRP2P owes{' '}
              {o.inrp2pOwes ? (o.side === 'BUY_USDT' ? usdt(o.inrp2pOwes, { exact: true }) : inr(o.inrp2pOwes)) : 'nothing'}
              {o.deliveryAddress ? ` · delivery address ${o.deliveryAddress}` : ''}
            </Notice>
          ) : null}
          {o.closeNote ? <Notice>{o.closeNote}</Notice> : null}
          <OrderSettlement order={o} detail={detail} accounts={accounts} wallets={wallets} perms={perms} />
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
