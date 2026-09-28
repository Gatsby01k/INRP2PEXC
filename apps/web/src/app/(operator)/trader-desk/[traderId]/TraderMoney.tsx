'use client';

import { useState } from 'react';
import type { PayoutAccountOption } from '@inrp2p/desk';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, UTRField, normalizeUtr } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  confirmRewardPayoutAction, confirmWithdrawalAction, failRewardPayoutAction, recordRewardPayoutAction, recordWithdrawalSentAction, rejectWithdrawalAction,
} from '../../../../server/actions/traders-desk.ts';
import type { TraderPerms } from './TraderControls.tsx';
import styles from '../traders.module.css';

/**
 * The trader's money with INRP2P that is not an order: its Security Reserve (deposits are credited by the chain;
 * withdrawals are sent by the desk and confirmed on finality) and its rewards (accrued by the ledger on completed
 * orders, paid by the desk from an exchange account). Each record and confirm is its own audited command.
 */
export function TraderMoney({ detail, accounts, perms }: { detail: DeskTraderDetail; accounts: readonly PayoutAccountOption[]; perms: TraderPerms }) {
  const cmd = useCommand();
  const [tx, setTx] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [payAmount, setPayAmount] = useState('');
  const [payAccount, setPayAccount] = useState(accounts[0]?.accountId ?? '');
  const [payUtr, setPayUtr] = useState('');
  const r = detail.reserve;
  const e = detail.earnings;

  return (
    <>
      <section className="ix-card" aria-label="Security Reserve">
        <h2 className="ix-sectionTitle">Security Reserve</h2>
        <dl className={styles.facts}>
          <dt>Held</dt>
          <dd>{r.balance} USDT</dd>
          <dt>Required</dt>
          <dd>{r.required ? `${r.required} USDT` : 'not set'}</dd>
          <dt>Locked</dt>
          <dd>{r.locked} USDT</dd>
          <dt>Available to withdraw</dt>
          <dd>{r.available} USDT</dd>
          <dt>Pending release</dt>
          <dd>{r.pendingRelease} USDT</dd>
          {/[1-9]/.test(r.shortfall) ? (
            <>
              <dt>Short by</dt>
              <dd>{r.shortfall} USDT</dd>
            </>
          ) : null}
          <dt>Deposit address</dt>
          <dd className={styles.mono}>{r.depositAddress ?? 'not issued yet'}</dd>
        </dl>
        {detail.withdrawals.length > 0 ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Withdrawal</th>
                <th className={styles.num}>USDT</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {detail.withdrawals.map((w) => (
                <tr key={w.withdrawalId}>
                  <td>
                    {w.ref}
                    <div className="ix-muted">{formatIstDateTime(new Date(w.requestedAt))}</div>
                    <div className={`ix-muted ${styles.mono}`}>to {w.destination}</div>
                  </td>
                  <td className={styles.num}>{w.amount}</td>
                  <td>
                    {w.status.toLowerCase()}
                    {w.txHash ? <div className={`ix-muted ${styles.mono}`}>{w.txHash}</div> : null}
                    {w.closeReason ? <div className="ix-muted">{w.closeReason}</div> : null}
                  </td>
                  <td>
                    {w.status === 'REQUESTED' && perms.record ? (
                      <div className={styles.form}>
                        <input className="ix-input" placeholder="Transaction hash" value={tx[w.withdrawalId] ?? ''} onChange={(ev) => setTx((s) => ({ ...s, [w.withdrawalId]: ev.target.value }))} />
                        <Button
                          disabled={cmd.busy || (tx[w.withdrawalId] ?? '').trim().length < 10}
                          onClick={() => cmd.run(`Record ${w.ref} as sent`, (key) => recordWithdrawalSentAction({ withdrawalId: w.withdrawalId, txHash: (tx[w.withdrawalId] ?? '').trim() }, key))}
                        >
                          Record sent
                        </Button>
                      </div>
                    ) : null}
                    {w.status === 'SENT' && perms.confirm ? (
                      <Button intent="primary" disabled={cmd.busy} onClick={() => cmd.run(`Confirm ${w.ref}`, (key) => confirmWithdrawalAction({ withdrawalId: w.withdrawalId }, key))}>
                        Confirm on chain
                      </Button>
                    ) : null}
                    {(w.status === 'REQUESTED' || w.status === 'SENT') && perms.confirm ? (
                      <div className={styles.form}>
                        <input className="ix-input" placeholder="Reason (shown to the trader)" value={why[w.withdrawalId] ?? ''} onChange={(ev) => setWhy((s) => ({ ...s, [w.withdrawalId]: ev.target.value }))} />
                        <Button
                          intent="ghost"
                          disabled={cmd.busy || (why[w.withdrawalId] ?? '').trim().length < 3}
                          onClick={() => cmd.run(`Reject ${w.ref}`, (key) => rejectWithdrawalAction({ withdrawalId: w.withdrawalId, reason: (why[w.withdrawalId] ?? '').trim() }, key))}
                        >
                          Reject
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="ix-muted">No withdrawals.</p>
        )}
      </section>

      <section className="ix-card" aria-label="Rewards">
        <h2 className="ix-sectionTitle">Rewards</h2>
        <dl className={styles.facts}>
          <dt>Rate</dt>
          <dd>{e.rewardBps === null ? 'no reward' : `${e.rewardBps} bps`}</dd>
          <dt>Accrued, unpaid</dt>
          <dd>₹{e.available}</dd>
          <dt>Being paid</dt>
          <dd>₹{e.payingOut}</dd>
          <dt>Pending (open orders)</dt>
          <dd>₹{e.pending}</dd>
          <dt>Paid out</dt>
          <dd>₹{e.paidOut}</dd>
          <dt>Completed volume</dt>
          <dd>
            {e.completedUsdt} USDT · ₹{e.completedInr}
          </dd>
        </dl>
        {detail.payouts.length > 0 ? (
          <table className={styles.table}>
            <tbody>
              {detail.payouts.map((p) => (
                <tr key={p.payoutId}>
                  <td>
                    {p.ref}
                    <div className="ix-muted">{formatIstDateTime(new Date(p.recordedAt))}</div>
                  </td>
                  <td className={styles.num}>₹{p.amount}</td>
                  <td className={styles.mono}>{p.utr}</td>
                  <td>{p.status.toLowerCase()}</td>
                  <td>
                    {p.status === 'RECORDED' && perms.confirm ? (
                      <div className="ix-row">
                        <Button intent="primary" disabled={cmd.busy} onClick={() => cmd.run(`Confirm ${p.ref}`, (key) => confirmRewardPayoutAction({ payoutId: p.payoutId }, key))}>
                          Confirm
                        </Button>
                        <Button intent="ghost" disabled={cmd.busy} onClick={() => cmd.run(`Mark ${p.ref} failed`, (key) => failRewardPayoutAction({ payoutId: p.payoutId, reason: 'the payment did not leave the account' }, key))}>
                          Failed
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {perms.record && /[1-9]/.test(e.available) ? (
          <div className={styles.form}>
            <div className={styles.row}>
              <div className="ix-field">
                <label htmlFor="pay-amount">Pay (₹)</label>
                <input id="pay-amount" className="ix-input" inputMode="decimal" value={payAmount} onChange={(ev) => setPayAmount(ev.target.value)} placeholder={e.available} />
              </div>
              <div className="ix-field">
                <label htmlFor="pay-account">From</label>
                <select id="pay-account" className="ix-input" value={payAccount} onChange={(ev) => setPayAccount(ev.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.bankName} ••••{a.last4} · ₹{a.availableToday} today
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <UTRField value={payUtr} onChange={setPayUtr} />
            <Button
              disabled={cmd.busy || payAccount === '' || normalizeUtr(payUtr).length < 6}
              onClick={() =>
                cmd.run(`Record reward payout to ${detail.trader.ref}`, (key) =>
                  recordRewardPayoutAction({ traderId: detail.trader.traderId, amount: payAmount.trim() || e.available, inrAccountId: payAccount, rail: 'IMPS', utr: normalizeUtr(payUtr) }, key),
                )
              }
            >
              Record payout to the registered account
            </Button>
          </div>
        ) : null}
      </section>
      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </>
  );
}
