'use client';

import { useState } from 'react';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  approveTraderAction, pauseTraderAction, rejectTraderAction, resumeTraderAction, setAssignmentsAction, setLimitsAction, setRequiredReserveAction, setRewardAction,
  setSettlementDetailsAction,
} from '../../../../server/actions/traders-desk.ts';
import { TraderReview } from './TraderReview.tsx';
import styles from '../traders.module.css';

export interface TraderPerms {
  readonly configure: boolean;
  readonly pause: boolean;
  readonly assign: boolean;
  readonly record: boolean;
  readonly confirm: boolean;
  readonly routeRecord: boolean;
  readonly routeConfirm: boolean;
  readonly reveal: boolean;
}

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

function Field({ id, label, value, onChange, hint, placeholder }: { id: string; label: string; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string }) {
  return (
    <div className="ix-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="ix-input" value={value} onChange={(e) => onChange(e.target.value)} {...(placeholder ? { placeholder } : {})} />
      {hint ? <span className="ix-hint">{hint}</span> : null}
    </div>
  );
}

/**
 * The desk's decisions about one trader. Every button is one audited command with a reason; the ones that change
 * who may provide liquidity, or on what terms, ask for the authenticator (⧗). None of them is automatic, and none
 * edits the trader's own capacity or rates: an operator ceiling is applied on top, and the trader is told.
 */
export function TraderControls({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const t = detail.trader;
  const [reserve, setReserve] = useState(detail.reserve.required ?? detail.program.defaultRequiredReserve ?? '');
  const [reward, setReward] = useState(t.rewardBps === null ? '' : String(t.rewardBps));
  const [maxOrderInr, setMaxOrderInr] = useState(t.limits.maxOrderInr ?? '');
  const [maxOrderUsdt, setMaxOrderUsdt] = useState(t.limits.maxOrderUsdt ?? '');
  const [maxCapInr, setMaxCapInr] = useState(t.limits.maxCapacityInr ?? '');
  const [maxCapUsdt, setMaxCapUsdt] = useState(t.limits.maxCapacityUsdt ?? '');
  const [reason, setReason] = useState('');
  const [bankId, setBankId] = useState(detail.bank.bankAccountId);
  const [walletId, setWalletId] = useState(detail.wallet.walletId);
  const approved = t.status === 'APPROVED' || t.status === 'PAUSED';
  // Approval waits for both submitted details to be verified (each its own decision, in the review beside this).
  const detailsVerified = detail.bank.status === 'ACTIVE' && detail.wallet.status === 'ACTIVE';
  const hasReason = reason.trim().length >= 3;
  const limits = { maxOrderInr: blank(maxOrderInr), maxOrderUsdt: blank(maxOrderUsdt), maxCapacityInr: blank(maxCapInr), maxCapacityUsdt: blank(maxCapUsdt) };

  return (
    <div className="ix-stack">
      <section className="ix-card" aria-label="Decision">
        <h2 className="ix-sectionTitle">{t.status === 'UNDER_REVIEW' ? 'Review' : 'Controls'}</h2>
        <dl className={styles.facts}>
          <dt>Provides</dt>
          <dd>{t.sides.map((s) => (s === 'BUY_USDT' ? 'INR (buys USDT)' : 'USDT (sells USDT)')).join(' · ')}</dd>
          {t.typicalInr ? (
            <>
              <dt>Typical INR</dt>
              <dd>₹{t.typicalInr}</dd>
            </>
          ) : null}
          {t.typicalUsdt ? (
            <>
              <dt>Typical USDT</dt>
              <dd>{t.typicalUsdt} USDT</dd>
            </>
          ) : null}
          {t.reviewNote ? (
            <>
              <dt>Review note</dt>
              <dd>{t.reviewNote}</dd>
            </>
          ) : null}
          {t.controlNote ? (
            <>
              <dt>Hold reason</dt>
              <dd>{t.controlNote}</dd>
            </>
          ) : null}
        </dl>
        <div className={styles.form}>
          <Field id="c-reason" label="Reason / note (the trader sees pause and rejection reasons)" value={reason} onChange={setReason} />
          {t.status === 'UNDER_REVIEW' && perms.configure ? (
            <>
              <Field id="c-reserve" label="Security Reserve for this trader (USDT)" value={reserve} onChange={setReserve} placeholder="Required" hint="From the programme default when left as is." />
              <Field id="c-reward" label="Reward override (basis points)" value={reward} onChange={setReward} placeholder="Follow the programme" />
              <div className={styles.row}>
                <Field id="c-moi" label="Max order ₹" value={maxOrderInr} onChange={setMaxOrderInr} placeholder="No ceiling" />
                <Field id="c-mou" label="Max order USDT" value={maxOrderUsdt} onChange={setMaxOrderUsdt} placeholder="No ceiling" />
              </div>
              <div className={styles.row}>
                <Field id="c-mci" label="Max capacity ₹" value={maxCapInr} onChange={setMaxCapInr} placeholder="No ceiling" />
                <Field id="c-mcu" label="Max capacity USDT" value={maxCapUsdt} onChange={setMaxCapUsdt} placeholder="No ceiling" />
              </div>
              <div className="ix-row">
                <Button
                  intent="primary"
                  disabled={cmd.busy || blank(reserve) === null || !detailsVerified}
                  onClick={() =>
                    cmd.run(`Approve ${t.ref}`, (key) =>
                      approveTraderAction({ traderId: t.traderId, requiredReserve: blank(reserve), rewardBps: reward.trim() === '' ? null : Number.parseInt(reward, 10), ...limits, note: blank(reason) }, key),
                    )
                  }
                >
                  Approve
                </Button>
                <Button intent="ghost" disabled={cmd.busy || !hasReason} onClick={() => cmd.run(`Reject ${t.ref}`, (key) => rejectTraderAction({ traderId: t.traderId, note: reason }, key))}>
                  Reject
                </Button>
              </div>
              {detailsVerified ? null : <span className="ix-hint">Verify the submitted bank account and wallet first.</span>}
            </>
          ) : null}
          {approved && perms.pause ? (
            <div className="ix-row">
              {t.status === 'APPROVED' ? (
                <Button disabled={cmd.busy || !hasReason} onClick={() => cmd.run(`Pause ${t.ref}`, (key) => pauseTraderAction({ traderId: t.traderId, reason }, key))}>
                  Pause trader
                </Button>
              ) : (
                <Button disabled={cmd.busy || !hasReason} onClick={() => cmd.run(`Resume ${t.ref}`, (key) => resumeTraderAction({ traderId: t.traderId, reason }, key))}>
                  Resume trader
                </Button>
              )}
              <Button
                disabled={cmd.busy || !hasReason}
                onClick={() => cmd.run(`${t.assignmentsEnabled ? 'Stop' : 'Allow'} new assignments for ${t.ref}`, (key) => setAssignmentsAction({ traderId: t.traderId, enabled: !t.assignmentsEnabled, reason }, key))}
              >
                {t.assignmentsEnabled ? 'Stop new assignments' : 'Allow new assignments'}
              </Button>
            </div>
          ) : null}
          {approved && perms.configure ? (
            <>
              <div className={styles.row}>
                <Field id="c-moi2" label="Max order ₹" value={maxOrderInr} onChange={setMaxOrderInr} placeholder="No ceiling" />
                <Field id="c-mou2" label="Max order USDT" value={maxOrderUsdt} onChange={setMaxOrderUsdt} placeholder="No ceiling" />
              </div>
              <div className={styles.row}>
                <Field id="c-mci2" label="Max capacity ₹" value={maxCapInr} onChange={setMaxCapInr} placeholder="No ceiling" />
                <Field id="c-mcu2" label="Max capacity USDT" value={maxCapUsdt} onChange={setMaxCapUsdt} placeholder="No ceiling" />
              </div>
              <Button disabled={cmd.busy || !hasReason} onClick={() => cmd.run(`Change limits for ${t.ref}`, (key) => setLimitsAction({ traderId: t.traderId, ...limits, reason }, key))}>
                Save limits
              </Button>
              <div className={styles.row}>
                <Field id="c-reserve2" label="Required Security Reserve (USDT)" value={reserve} onChange={setReserve} />
                <div>
                  <Button disabled={cmd.busy || !hasReason || blank(reserve) === null} onClick={() => cmd.run(`Change reserve for ${t.ref}`, (key) => setRequiredReserveAction({ traderId: t.traderId, requiredReserve: reserve.trim(), reason }, key))}>
                    Save reserve
                  </Button>
                </div>
              </div>
              <div className={styles.row}>
                <Field id="c-reward2" label="Reward override (basis points)" value={reward} onChange={setReward} placeholder="Follow the programme" />
                <div>
                  <Button disabled={cmd.busy || !hasReason} onClick={() => cmd.run(`Change reward for ${t.ref}`, (key) => setRewardAction({ traderId: t.traderId, rewardBps: reward.trim() === '' ? null : Number.parseInt(reward, 10), reason }, key))}>
                    Save reward
                  </Button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </section>

      <TraderReview detail={detail} perms={perms} />

      {perms.configure && approved ? (
        <section className="ix-card" aria-label="Switch settlement details">
          <h2 className="ix-sectionTitle">Switch to another verified destination</h2>
          <div className={styles.form}>
            <div className="ix-field">
              <label htmlFor="c-bank">Bank account</label>
              <select id="c-bank" className="ix-input" value={bankId} onChange={(e) => setBankId(e.target.value)}>
                {detail.clientDestinations.banks.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="ix-field">
              <label htmlFor="c-wallet">Wallet (send and receive)</label>
              <select id="c-wallet" className="ix-input" value={walletId} onChange={(e) => setWalletId(e.target.value)}>
                {detail.clientDestinations.wallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </select>
            </div>
            <Button
              disabled={cmd.busy || !hasReason || t.openOrders > 0 || (bankId === detail.bank.bankAccountId && walletId === detail.wallet.walletId)}
              onClick={() => cmd.run(`Change settlement details for ${t.ref}`, (key) => setSettlementDetailsAction({ traderId: t.traderId, bankAccountId: bankId, walletId, reason }, key))}
            >
              Change settlement details
            </Button>
            {t.openOrders > 0 ? <span className="ix-hint">Not while an order is accepted or in progress.</span> : null}
          </div>
        </section>
      ) : null}

      <section className="ix-card" aria-label="Capacity">
        <h2 className="ix-sectionTitle">Capacity and rates (set by the trader)</h2>
        {detail.blocks.length === 0 ? <p className="ix-muted">Opened when the trader is approved.</p> : null}
        {detail.blocks.map((b) => (
          <dl key={b.side} className={styles.facts}>
            <dt>{b.side === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT'}</dt>
            <dd>
              <span className={styles.tag} data-tone={b.status === 'ACTIVE' ? 'good' : undefined}>
                {b.status.toLowerCase()}
              </span>
            </dd>
            <dt>Rate</dt>
            <dd>{b.rate ? `₹${b.rate}` : 'not set'}</dd>
            <dt>Capacity</dt>
            <dd>
              {b.capacity} ({b.held} held)
            </dd>
            <dt>Per order</dt>
            <dd>{b.minOrder && b.maxOrder ? `${b.minOrder} – ${b.maxOrder}` : 'not set'}</dd>
          </dl>
        ))}
      </section>

      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
