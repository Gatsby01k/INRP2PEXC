'use client';

import { useState } from 'react';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, CopyButton, StepUpMark } from '@inrp2p/ui';
import { shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  approveReserveApplicationAction, cancelReserveApplicationAction, confirmWithdrawalAction, endReserveApplicationAction, recordWithdrawalSentAction, rejectReserveApplicationAction, rejectWithdrawalAction, requestReserveApplicationAction,
} from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { AmountField, SelectField, TextArea, TextField } from '../../_desk/fields.tsx';
import { dateTime, inr, usdt } from '../../_desk/format.ts';
import { Chip, Notice } from '../../_desk/ui.tsx';
import type { TraderPerms } from '../words.tsx';
import { Sheet, Stats, bookStyles as b, shortAddress } from '../../_book/parts.tsx';
import { UsdtOnTron } from '../../../../components/PayMarks.tsx';
import d from '../../_desk/desk.module.css';
import t from '../../_trade/trade.module.css';

/**
 * The trader's money with INRP2P that is not an order: its Security Reserve (deposits are credited by the chain;
 * withdrawals are sent by the desk and confirmed on finality). Each record and confirm is its own audited command.
 */
export function TraderMoney({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const r = detail.reserve;
  const nonzero = (v: string) => /[1-9]/.test(v);
  return (
    <>
      <Sheet title="Security Reserve" hint="Deposits are credited by the chain; withdrawals are sent by the desk and confirmed on finality." label="Security Reserve">
        <Stats
          label="Reserve"
          items={[
            { key: 'held', label: 'Held', value: usdt(r.balance, { exact: true }), sub: r.required ? `of ${usdt(r.required, { exact: true })} required` : 'no requirement set' },
            { key: 'locked', label: 'Locked', value: usdt(r.locked, { exact: true }), sub: 'by open orders', ...(nonzero(r.locked) ? {} : { tone: 'muted' as const }) },
            { key: 'free', label: 'Free', value: usdt(r.available, { exact: true }), sub: 'to withdraw' },
            ...(nonzero(r.shortfall) ? [{ key: 'short', label: 'Short by', value: usdt(r.shortfall, { exact: true }), sub: 'below what it must hold', tone: 'danger' as const }] : []),
            ...(nonzero(r.pendingRelease) ? [{ key: 'pending', label: 'Pending release', value: usdt(r.pendingRelease, { exact: true }), sub: 'on its way back' }] : []),
            ...(nonzero(r.applying) ? [{ key: 'applying', label: 'Being applied', value: usdt(r.applying, { exact: true }), sub: 'to orders that owe', tone: 'warning' as const }] : []),
          ]}
        />
        <ul className={b.rows}>
          <li className={b.row}>
            <UsdtOnTron size={32} />
            <span className={b.rowMain}>
              <span className={b.rowTitle}>
                <span>Deposit address</span>
              </span>
              <span className={b.rowSub} title={r.depositAddress ?? undefined}>
                {r.depositAddress ? (
                  <>
                    <span className={b.addr}>{shortAddress(r.depositAddress)}</span> · shared by every trader; its registered wallet makes a deposit its own
                  </>
                ) : (
                  'none active'
                )}
              </span>
            </span>
            <span className={b.rowEnd}>{r.depositAddress ? <CopyButton value={r.depositAddress} label="deposit address" /> : null}</span>
          </li>
        </ul>
      </Sheet>
      <Sheet title="Withdrawals" count={detail.withdrawals.length} label="Withdrawals">
        {detail.withdrawals.length > 0 ? (
          <ul className={t.legs}>
            {detail.withdrawals.map((w) => (
              <Withdrawal key={w.withdrawalId} w={w} perms={perms} />
            ))}
          </ul>
        ) : (
          <p className={b.quiet}>No withdrawals yet.</p>
        )}
      </Sheet>
      <ReserveApplications detail={detail} perms={perms} />
    </>
  );
}

const APPLICATION_STATUS: Record<DeskTraderDetail['applications'][number]['status'], { label: string; tone: 'warning' | 'success' | 'danger' | 'muted' }> = {
  REQUESTED: { label: 'waiting for approval', tone: 'warning' },
  APPROVED: { label: 'held — not withdrawable', tone: 'warning' },
  REJECTED: { label: 'declined', tone: 'muted' },
  CANCELLED: { label: 'released', tone: 'muted' },
};

/**
 * The trader's reserve held against rupees one of its orders owes (TD-21). One person asks, with the reason; someone else
 * approves, each with step-up. The reserve is USDT and the debt is INR, so nothing is converted or moved: the amount stays
 * the trader's, not withdrawable, until the hold is released.
 */
function ReserveApplications({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const orders = detail.applicableOrders;
  const [orderId, setOrderId] = useState(orders[0]?.orderId ?? '');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const step = <StepUpMark label="needs your authenticator code" />;
  const order = orders.find((o) => o.orderId === orderId);
  if (detail.applications.length === 0 && (orders.length === 0 || !perms.applyReserve)) return null;
  return (
    <Sheet title="Reserve held" count={detail.applications.length} hint="Only against rupees the trader’s own order owes; asked by one person, approved by another." label="Reserve held">
      {detail.applications.length > 0 ? (
        <ul className={t.legs}>
          {detail.applications.map((a) => (
            <Application key={a.applicationId} a={a} perms={perms} />
          ))}
        </ul>
      ) : null}
      {perms.applyReserve && orders.length > 0 ? (
        <div className={d.guard}>
          <p className={d.guardTitle}>Hold the reserve against an order whose INR did not arrive</p>
          <div className={d.formGrid}>
            <SelectField
              label="Order"
              value={orderId}
              onChange={setOrderId}
              options={orders.map((o) => ({ value: o.orderId, label: `${o.ref} · ${inr(o.owed)} owed` }))}
            />
            <AmountField
              label="Hold (USDT)"
              currency="USDT"
              value={amount}
              onChange={setAmount}
              hint={order ? 'The debt is INR: name the USDT to keep back. Nothing is converted or taken.' : undefined}
            />
          </div>
          <TextArea label="Why" value={reason} onChange={setReason} placeholder="e.g. the trader stopped answering after the client's USDT reached the escrow; its rupees did not arrive" />
          <div className={d.actions}>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || orderId === '' || reason.trim().length < 10 || amount.trim() === ''}
              onClick={() =>
                cmd.run(`Ask to hold ${detail.trader.ref}'s reserve against ${order?.ref ?? 'the order'}`, (key) =>
                  requestReserveApplicationAction({ orderId, amount: amount.trim(), reason: reason.trim() }, key),
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
    </Sheet>
  );
}

function Application({ a, perms }: { a: DeskTraderDetail['applications'][number]; perms: TraderPerms }) {
  const cmd = useCommand();
  const step = <StepUpMark label="needs your authenticator code" />;
  const mine = a.requestedBy === perms.meId;
  const s = APPLICATION_STATUS[a.status];
  return (
    <li className={t.leg} {...(a.status === 'REQUESTED' || a.status === 'APPROVED' ? { 'data-attention': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>
          {usdt(a.amount, { exact: true })} held against {a.orderRef}
        </span>
        <Chip tone={s.tone}>{s.label}</Chip>
      </div>
      <div className={t.legMeta}>
        <span>{a.ref}</span>
        <span>asked by {mine ? 'you' : a.requestedByLabel} · {dateTime(a.requestedAt)}</span>
        {a.decidedByLabel ? <span>decided by {a.decidedByLabel}</span> : null}
      </div>
      <Notice>{a.reason}</Notice>
      {a.closeReason ? <Notice>{a.closeReason}</Notice> : null}
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
              consequence="Nothing is held; the reserve stays the trader's."
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
          {perms.approveReserve ? (
            <div className={d.actions}>
              <GuardedAction
                label="Release the hold"
                trigger="ghost"
                tone="danger"
                stepUp
                busy={cmd.busy}
                consequence="The held amount is the trader’s again; the INR debt stays as it is."
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
