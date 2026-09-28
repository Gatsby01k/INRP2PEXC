'use client';

import { useState } from 'react';
import type { PayoutAccountOption } from '@inrp2p/desk';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import { maskUtr, shortenHash } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  confirmRewardPayoutAction, confirmWithdrawalAction, failRewardPayoutAction, recordRewardPayoutAction, recordWithdrawalSentAction, rejectWithdrawalAction,
} from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { AmountField, SelectField, TextField } from '../../_desk/fields.tsx';
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
            ...(/[1-9]/.test(r.shortfall) ? [{ label: 'Short by', value: <span className={d.negative}>{usdt(r.shortfall, { exact: true })}</span> }] : []),
            { label: 'Deposit address', value: <span className={d.mono}>{r.depositAddress ?? 'not issued yet'}</span> },
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
      <Rewards detail={detail} accounts={accounts} perms={perms} earnings={e} />
    </>
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
  const [payAccount, setPayAccount] = useState(accounts[0]?.accountId ?? '');
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
            <SelectField label="From" value={payAccount} onChange={setPayAccount} options={accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${inr(a.availableToday)} today` }))} />
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
