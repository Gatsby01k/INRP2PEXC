'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { PayoutAccountOption } from '@inrp2p/desk';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  approveReserveApplicationAction, cancelReserveApplicationAction, confirmRewardPayoutAction, confirmWithdrawalAction, endReserveApplicationAction, failRewardPayoutAction,
  recordReserveApplicationSentAction, recordRewardPayoutAction, recordWithdrawalSentAction, rejectReserveApplicationAction, rejectWithdrawalAction, requestReserveApplicationAction,
} from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { AmountField, SelectField, TextArea, TextField } from '../../_desk/fields.tsx';
import { dateTime, inr, usdt } from '../../_desk/format.ts';
import { Chip, KeyValues, Notice, Section } from '../../_desk/ui.tsx';
import type { TraderPerms } from './TraderControls.tsx';
import d from '../../_desk/desk.module.css';
import t from '../../_trade/trade.module.css';

/**
 * The trader's money with INRP2P that is not an order: its Security Reserve (deposits are credited by the chain;
 * withdrawals are sent by the desk and confirmed on finality) and its rewards (accrued by the ledger on completed
 * orders, paid by the desk from an exchange account). Each record and confirm is its own audited command.
 */
export function TraderMoney({ detail, accounts, perms }: { detail: DeskTraderDetail; accounts: readonly PayoutAccountOption[]; perms: TraderPerms }) {
  const r = detail.reserve;
  const e = detail.earnings;
  return (
    <>
      <Section title="Security Reserve" hint="Deposits are credited by the chain; withdrawals are sent by the desk and confirmed on finality.">
        <KeyValues
          split
          items={[
            { label: 'Held', value: usdt(r.balance, { exact: true }), strong: true },
            { label: 'Required', value: r.required ? usdt(r.required, { exact: true }) : 'not set' },
            { label: 'Locked by open orders', value: usdt(r.locked, { exact: true }) },
            { label: 'Available to withdraw', value: usdt(r.available, { exact: true }) },
            { label: 'Pending release', value: usdt(r.pendingRelease, { exact: true }) },
            ...(/[1-9]/.test(r.applying) ? [{ label: 'Being applied to orders', value: usdt(r.applying, { exact: true }) }] : []),
            ...(/[1-9]/.test(r.shortfall) ? [{ label: 'Short by', value: <span className={d.negative}>{usdt(r.shortfall, { exact: true })}</span> }] : []),
            { label: 'Deposit address · shared', value: <span className={d.mono}>{r.depositAddress ?? 'none active'}</span> },
          ]}
        />
        {detail.withdrawals.length > 0 ? (
          <ul className={t.legs}>
            {detail.withdrawals.map((w) => (
              <Withdrawal key={w.withdrawalId} w={w} perms={perms} />
            ))}
          </ul>
        ) : (
          <p className={d.fieldHint}>No withdrawals.</p>
        )}
      </Section>
      <ReserveApplications detail={detail} perms={perms} />
      <Rewards detail={detail} accounts={accounts} perms={perms} earnings={e} />
    </>
  );
}

const APPLICATION_STATUS: Record<DeskTraderDetail['applications'][number]['status'], { label: string; tone: 'warning' | 'success' | 'danger' | 'muted' }> = {
  REQUESTED: { label: 'waiting for approval', tone: 'warning' },
  APPROVED: { label: 'approved — custody to send', tone: 'warning' },
  SENT: { label: 'sent — waiting for the chain', tone: 'warning' },
  COMPLETED: { label: 'applied', tone: 'success' },
  REJECTED: { label: 'declined', tone: 'muted' },
  CANCELLED: { label: 'withdrawn', tone: 'muted' },
  FAILED: { label: 'failed', tone: 'danger' },
};

/**
 * The trader's reserve applied to USDT one of its own orders did not deliver (TD-21). One person asks, with the
 * reason; someone else approves, each with step-up. Approval holds the amount and names the order's delivery
 * address; custody moves the USDT there (this product never sends) and the chain makes it the order's delivery.
 * Against INR an order owes, the reserve can only be **held**: the reserve is USDT and converting it is the owner's
 * decision, so the debt stays open and nothing moves until the hold is released.
 */
function ReserveApplications({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const orders = detail.applicableOrders;
  const [orderId, setOrderId] = useState(orders[0]?.orderId ?? '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const step = <StepUpMark label="needs your authenticator code" />;
  const order = orders.find((o) => o.orderId === orderId);
  const holding = order?.kind === 'HOLD';
  if (detail.applications.length === 0 && (orders.length === 0 || !perms.applyReserve)) return null;
  return (
    <Section title="Reserve applied or held" count={detail.applications.length} hint="Only for the trader’s own undelivered orders; asked by one person, approved by another.">
      {detail.applications.length > 0 ? (
        <ul className={t.legs}>
          {detail.applications.map((a) => (
            <Application key={a.applicationId} a={a} perms={perms} reserveAddress={detail.reserve.depositAddress} />
          ))}
        </ul>
      ) : null}
      {perms.applyReserve && orders.length > 0 ? (
        <div className={d.guard}>
          <p className={d.guardTitle}>{holding ? 'Hold the reserve against an order whose INR did not arrive' : 'Apply the reserve to an order whose USDT did not arrive'}</p>
          <div className={d.formGrid}>
            <SelectField
              label="Order"
              value={orderId}
              onChange={setOrderId}
              options={orders.map((o) => ({ value: o.orderId, label: `${o.ref} · ${o.owedAsset === 'USDT' ? usdt(o.owed, { exact: true }) : inr(o.owed)} owed${o.kind === 'HOLD' ? ' · hold only' : ''}` }))}
            />
            <AmountField
              label={holding ? 'Hold (USDT)' : 'Apply'}
              currency="USDT"
              value={amount}
              onChange={setAmount}
              hint={order ? (holding ? 'The debt is INR: name the USDT to keep back. Nothing is converted or taken.' : `Leave empty to apply all ${usdt(order.owed, { exact: true })} owed`) : undefined}
            />
          </div>
          <TextArea label="Why" value={reason} onChange={setReason} placeholder="e.g. the trader stopped answering after the client paid; its USDT did not arrive" />
          <div className={d.actions}>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || orderId === '' || reason.trim().length < 10 || (holding && amount.trim() === '')}
              onClick={() =>
                cmd.run(`Ask to apply ${detail.trader.ref}'s reserve to ${order?.ref ?? 'the order'}`, (key) =>
                  requestReserveApplicationAction({ orderId, ...(amount.trim() ? { amount: amount.trim() } : {}), reason: reason.trim() }, key),
                )
              }
            >
              Ask for approval
            </Button>
          </div>
        </div>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </Section>
  );
}

function Application({ a, perms, reserveAddress }: { a: DeskTraderDetail['applications'][number]; perms: TraderPerms; reserveAddress: string | null }) {
  const cmd = useCommand();
  const [tx, setTx] = useState('');
  const step = <StepUpMark label="needs your authenticator code" />;
  const mine = a.requestedBy === perms.meId;
  const s = APPLICATION_STATUS[a.status];
  return (
    <li className={t.leg} {...(a.status === 'REQUESTED' || a.status === 'APPROVED' || a.status === 'SENT' ? { 'data-attention': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>
          {usdt(a.amount, { exact: true })} {a.kind === 'HOLD' ? 'held against' : 'to'} {a.orderRef}
        </span>
        <Chip tone={s.tone}>{a.kind === 'HOLD' ? (a.status === 'APPROVED' ? 'held — not withdrawable' : a.status === 'CANCELLED' ? 'released' : s.label) : s.label}</Chip>
      </div>
      <div className={t.legMeta}>
        <span>{a.ref}</span>
        <span>asked by {mine ? 'you' : a.requestedByLabel} · {dateTime(a.requestedAt)}</span>
        {a.decidedByLabel ? <span>decided by {a.decidedByLabel}</span> : null}
        {a.txHash ? <span className={d.mono}>tx {shortenHash(a.txHash)}</span> : null}
      </div>
      <Notice>{a.reason}</Notice>
      {a.closeReason && a.status !== 'COMPLETED' ? <Notice>{a.closeReason}</Notice> : null}
      {a.status === 'APPROVED' && a.kind === 'APPLY' && a.deliveryAddress ? (
        <KeyValues
          items={[
            { label: 'Custody sends', value: usdt(a.amount, { exact: true }), strong: true },
            { label: 'From', value: <span className={d.mono}>{reserveAddress ?? 'the reserve address'} (or a treasury wallet)</span> },
            { label: 'To the order’s address', value: <span className={d.mono}>{a.deliveryAddress}</span> },
          ]}
        />
      ) : null}
      {a.status === 'REQUESTED' ? (
        mine ? (
          <div className={d.actions}>
            <Notice tone="warning" icon="shield">You asked for this, so someone else approves it.</Notice>
            <GuardedAction
              label="Withdraw"
              trigger="ghost"
              busy={cmd.busy}
              consequence="The request is closed; nothing was held or moved."
              reasonLabel="Why"
              onConfirm={async (reason) => (await cmd.run(`Withdraw ${a.ref}`, (key) => cancelReserveApplicationAction({ applicationId: a.applicationId, reason }, key))).ok}
            />
          </div>
        ) : perms.approveReserve ? (
          <div className={d.actions}>
            <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy} onClick={() => cmd.run(`Approve ${a.ref}`, (key) => approveReserveApplicationAction({ applicationId: a.applicationId }, key))}>
              Approve
            </Button>
            <GuardedAction
              label="Decline"
              trigger="ghost"
              stepUp
              busy={cmd.busy}
              consequence="Nothing is applied; the reserve stays the trader's."
              reasonLabel="Why"
              onConfirm={async (note) => (await cmd.run(`Decline ${a.ref}`, (key) => rejectReserveApplicationAction({ applicationId: a.applicationId, note }, key))).ok}
            />
          </div>
        ) : (
          <Notice>Approving it needs the owner or finance role.</Notice>
        )
      ) : null}
      {a.status === 'APPROVED' ? (
        <div className={d.stackTight}>
          {perms.record && a.kind === 'APPLY' ? (
            <>
              <TextField label="Transaction hash (custody sent it)" value={tx} onChange={setTx} mono />
              <div className={d.actions}>
                <Button size="sm" disabled={cmd.busy || tx.trim().length < 10} onClick={() => cmd.run(`Record ${a.ref} as sent`, (key) => recordReserveApplicationSentAction({ applicationId: a.applicationId, txHash: tx.trim() }, key))}>
                  Record sent
                </Button>
              </div>
            </>
          ) : null}
          {perms.approveReserve ? (
            <div className={d.actions}>
              <GuardedAction
                label={a.kind === 'HOLD' ? 'Release the hold' : 'End without applying'}
                trigger="ghost"
                tone="danger"
                stepUp
                busy={cmd.busy}
                consequence={a.kind === 'HOLD' ? 'The held amount is the trader’s again; the INR debt stays as it is.' : 'Only before custody sent anything: the held amount is the trader’s again.'}
                reasonLabel="Why (e.g. the trader delivered after all)"
                onConfirm={async (reason) => (await cmd.run(`End ${a.ref}`, (key) => endReserveApplicationAction({ applicationId: a.applicationId, reason }, key))).ok}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </li>
  );
}

function Withdrawal({ w, perms }: { w: DeskTraderDetail['withdrawals'][number]; perms: TraderPerms }) {
  const cmd = useCommand();
  const [tx, setTx] = useState('');
  const step = <StepUpMark label="needs your authenticator code" />;
  return (
    <li className={t.leg} {...(w.status === 'REQUESTED' || w.status === 'SENT' ? { 'data-attention': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>{usdt(w.amount, { exact: true })} withdrawal</span>
        <Chip tone={w.status === 'CONFIRMED' ? 'success' : w.status === 'REJECTED' ? 'muted' : 'warning'}>{w.status.toLowerCase()}</Chip>
      </div>
      <div className={t.legMeta}>
        <span>{w.ref}</span>
        <span>{dateTime(w.requestedAt)}</span>
        <span className={d.mono}>to {w.destination}</span>
        {w.txHash ? <span className={d.mono}>tx {shortenHash(w.txHash)}</span> : null}
      </div>
      {w.closeReason ? <Notice>{w.closeReason}</Notice> : null}
      {w.status === 'REQUESTED' && perms.record ? (
        <div className={d.stackTight}>
          <TextField label="Transaction hash" value={tx} onChange={setTx} mono />
          <div className={d.actions}>
            <Button size="sm" disabled={cmd.busy || tx.trim().length < 10} onClick={() => cmd.run(`Record ${w.ref} as sent`, (key) => recordWithdrawalSentAction({ withdrawalId: w.withdrawalId, txHash: tx.trim() }, key))}>
              Record sent
            </Button>
          </div>
        </div>
      ) : null}
      <div className={d.actions}>
        {w.status === 'SENT' && perms.confirm ? (
          <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy} onClick={() => cmd.run(`Confirm ${w.ref}`, (key) => confirmWithdrawalAction({ withdrawalId: w.withdrawalId }, key))}>
            Confirm on chain
          </Button>
        ) : null}
        {(w.status === 'REQUESTED' || w.status === 'SENT') && perms.confirm ? (
          <GuardedAction
            label="Reject"
            trigger="ghost"
            tone="danger"
            stepUp
            busy={cmd.busy}
            consequence="The withdrawal is closed and the reserve stays where it is. The trader sees your reason."
            reasonLabel="Reason (shown to the trader)"
            onConfirm={async (reason) => (await cmd.run(`Reject ${w.ref}`, (key) => rejectWithdrawalAction({ withdrawalId: w.withdrawalId, reason }, key))).ok}
          />
        ) : null}
      </div>
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </li>
  );
}

function Rewards({ detail, accounts, perms, earnings: e }: { detail: DeskTraderDetail; accounts: readonly PayoutAccountOption[]; perms: TraderPerms; earnings: DeskTraderDetail['earnings'] }) {
  const cmd = useCommand();
  const [payAmount, setPayAmount] = useState('');
  // A reward is paid only out of realized margin at the paying account (D4): the account with the most free goes first.
  const marginOf = (accountId: string) => detail.rewardMargins.find((m) => m.accountId === accountId)?.freeMargin ?? '0.00';
  const minorOf = (accountId: string) => Money.parse(marginOf(accountId), 'INR').minor;
  const ranked = [...accounts].sort((x, y) => (minorOf(y.accountId) > minorOf(x.accountId) ? 1 : minorOf(y.accountId) < minorOf(x.accountId) ? -1 : 0));
  const [payAccount, setPayAccount] = useState(ranked[0]?.accountId ?? '');
  const [payUtr, setPayUtr] = useState('');
  const step = <StepUpMark label="needs your authenticator code" />;
  return (
    <Section title="Rewards" hint="Accrued by the ledger on completed orders; paid by the desk to the registered account.">
      <KeyValues
        split
        items={[
          { label: 'Rate', value: e.rewardBps === null ? 'no reward' : `${e.rewardBps} bps` },
          { label: 'Accrued, unpaid', value: inr(e.available), strong: true },
          { label: 'Being paid', value: inr(e.payingOut) },
          { label: 'Pending (open orders)', value: inr(e.pending) },
          { label: 'Paid out', value: inr(e.paidOut) },
          { label: 'Completed volume', value: `${usdt(e.completedUsdt)} · ${inr(e.completedInr)}` },
        ]}
      />
      {detail.payouts.length > 0 ? (
        <ul className={t.legs}>
          {detail.payouts.map((p) => (
            <li key={p.payoutId} className={t.leg} {...(p.status === 'RECORDED' ? { 'data-attention': '' } : {})}>
              <div className={t.legHead}>
                <span className={t.legAmount}>{inr(p.amount)}</span>
                <Chip tone={p.status === 'CONFIRMED' ? 'success' : p.status === 'FAILED' ? 'danger' : 'warning'}>{p.status.toLowerCase()}</Chip>
              </div>
              <div className={t.legMeta}>
                <span>{p.ref}</span>
                <span>{dateTime(p.recordedAt)}</span>
                <span className={d.mono}>UTR {maskUtr(p.utr)}</span>
              </div>
              {p.status === 'RECORDED' && perms.confirm ? (
                <div className={d.actions}>
                  <Button intent="primary" size="sm" shortcut={step} disabled={cmd.busy} onClick={() => cmd.run(`Confirm ${p.ref}`, (key) => confirmRewardPayoutAction({ payoutId: p.payoutId }, key))}>
                    Confirm
                  </Button>
                  <GuardedAction
                    label="Failed"
                    trigger="ghost"
                    tone="danger"
                    stepUp
                    busy={cmd.busy}
                    consequence="Records that the payment did not leave the account; the reward goes back to unpaid."
                    onConfirm={async () => (await cmd.run(`Mark ${p.ref} failed`, (key) => failRewardPayoutAction({ payoutId: p.payoutId, reason: 'the payment did not leave the account' }, key))).ok}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {perms.record && /[1-9]/.test(e.available) ? (
        <div className={d.guard}>
          <p className={d.guardTitle}>Record a reward payout to the registered account</p>
          <div className={d.formGrid}>
            <AmountField label="Pay" currency="INR" value={payAmount} onChange={setPayAmount} hint={`Leave empty to pay all ${inr(e.available)}`} />
            <SelectField
              label="From"
              value={payAccount}
              onChange={setPayAccount}
              options={ranked.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${inr(marginOf(a.accountId))} margin free · ${inr(a.availableToday)} today` }))}
              hint="Rewards are paid only out of margin the account's finished trades left there — never a client's or a trader's money."
            />
          </div>
          <UTRField value={payUtr} onChange={setPayUtr} />
          <div className={d.actions}>
            <Button
              size="sm"
              disabled={cmd.busy || payAccount === '' || normalizeUtr(payUtr).length < 6}
              onClick={() =>
                cmd.run(`Record reward payout to ${detail.trader.ref}`, (key) =>
                  recordRewardPayoutAction({ traderId: detail.trader.traderId, amount: payAmount.trim() || e.available, inrAccountId: payAccount, rail: 'IMPS', utr: normalizeUtr(payUtr) }, key),
                )
              }
            >
              Record payout
            </Button>
          </div>
        </div>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </Section>
  );
}
