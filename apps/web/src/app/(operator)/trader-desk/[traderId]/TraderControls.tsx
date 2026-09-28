'use client';

import { useState } from 'react';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, StepUpMark } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  approveTraderAction, pauseTraderAction, rejectTraderAction, resumeTraderAction, setAssignmentsAction, setLimitsAction, setRequiredReserveAction, setRewardAction,
  setSettlementDetailsAction,
} from '../../../../server/actions/traders-desk.ts';
import { PanelSection } from '../../_desk/ContextPanel.tsx';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { SelectField, TextArea, TextField } from '../../_desk/fields.tsx';
import { inr, rate, usdt } from '../../_desk/format.ts';
import { Chip, KeyValues, Notice } from '../../_desk/ui.tsx';
import d from '../../_desk/desk.module.css';

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

/**
 * The desk's decisions about one trader. Every button is one audited command with a reason; the ones that change who
 * may provide liquidity, or on what terms, ask for the authenticator (⧗). None of them is automatic, and none edits
 * the trader's own capacity or rates: an operator ceiling is applied on top, and the trader is told.
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
  const step = <StepUpMark label="needs your authenticator code" />;

  const limitFields = (
    <div className={d.formGrid}>
      <TextField label="Max order ₹" value={maxOrderInr} onChange={setMaxOrderInr} placeholder="No ceiling" />
      <TextField label="Max order USDT" value={maxOrderUsdt} onChange={setMaxOrderUsdt} placeholder="No ceiling" />
      <TextField label="Max capacity ₹" value={maxCapInr} onChange={setMaxCapInr} placeholder="No ceiling" />
      <TextField label="Max capacity USDT" value={maxCapUsdt} onChange={setMaxCapUsdt} placeholder="No ceiling" />
    </div>
  );

  return (
    <div className={d.stack}>
      <PanelSection title={t.status === 'UNDER_REVIEW' ? 'Decision' : 'Controls'}>
        <KeyValues
          items={[
            { label: 'Provides', value: t.sides.map((s) => (s === 'BUY_USDT' ? 'INR (buys USDT)' : 'USDT (sells USDT)')).join(' · ') },
            ...(t.typicalInr ? [{ label: 'Typical INR', value: inr(t.typicalInr) }] : []),
            ...(t.typicalUsdt ? [{ label: 'Typical USDT', value: usdt(t.typicalUsdt) }] : []),
            ...(t.reviewNote ? [{ label: 'Review note', value: t.reviewNote }] : []),
            ...(t.controlNote ? [{ label: 'Hold reason', value: t.controlNote }] : []),
          ]}
        />
        <TextArea label="Reason / note (the trader sees pause and rejection reasons)" value={reason} onChange={setReason} />

        {t.status === 'UNDER_REVIEW' && perms.configure ? (
          <>
            <TextField label="Security Reserve for this trader (USDT)" value={reserve} onChange={setReserve} placeholder="Required" hint="From the programme default when left as is." />
            <TextField label="Reward override (basis points)" value={reward} onChange={setReward} placeholder="Follow the programme" />
            {limitFields}
            {detailsVerified ? null : <Notice tone="warning">Verify the submitted bank account and wallet first — approval waits for both.</Notice>}
            <div className={d.actions}>
              <Button
                intent="primary"
                size="sm"
                shortcut={step}
                disabled={cmd.busy || blank(reserve) === null || !detailsVerified}
                onClick={() =>
                  cmd.run(`Approve ${t.ref}`, (key) =>
                    approveTraderAction({ traderId: t.traderId, requiredReserve: blank(reserve), rewardBps: reward.trim() === '' ? null : Number.parseInt(reward, 10), ...limits, note: blank(reason) }, key),
                  )
                }
              >
                Approve
              </Button>
              <GuardedAction
                label="Reject"
                trigger="ghost"
                tone="danger"
                stepUp
                busy={cmd.busy}
                disabled={!hasReason}
                disabledReason="Write the reason above — the applicant sees it."
                consequence="The application is closed and the applicant is told why. They can apply again."
                onConfirm={async () => (await cmd.run(`Reject ${t.ref}`, (key) => rejectTraderAction({ traderId: t.traderId, note: reason }, key))).ok}
              />
            </div>
          </>
        ) : null}

        {approved && perms.pause ? (
          <div className={d.actions}>
            {t.status === 'APPROVED' ? (
              <GuardedAction
                label="Pause trader"
                tone="danger"
                stepUp
                busy={cmd.busy}
                disabled={!hasReason}
                disabledReason="Write the reason above — the trader sees it."
                consequence="No new order is offered to this trader. Orders already accepted or in progress still settle."
                onConfirm={async () => (await cmd.run(`Pause ${t.ref}`, (key) => pauseTraderAction({ traderId: t.traderId, reason }, key))).ok}
              />
            ) : (
              <Button size="sm" shortcut={step} disabled={cmd.busy || !hasReason} onClick={() => cmd.run(`Resume ${t.ref}`, (key) => resumeTraderAction({ traderId: t.traderId, reason }, key))}>
                Resume trader
              </Button>
            )}
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !hasReason}
              onClick={() => cmd.run(`${t.assignmentsEnabled ? 'Stop' : 'Allow'} new assignments for ${t.ref}`, (key) => setAssignmentsAction({ traderId: t.traderId, enabled: !t.assignmentsEnabled, reason }, key))}
            >
              {t.assignmentsEnabled ? 'Stop new assignments' : 'Allow new assignments'}
            </Button>
          </div>
        ) : null}
      </PanelSection>

      {approved && perms.configure ? (
        <PanelSection title="Terms">
          {limitFields}
          <div className={d.actions}>
            <Button size="sm" shortcut={step} disabled={cmd.busy || !hasReason} onClick={() => cmd.run(`Change limits for ${t.ref}`, (key) => setLimitsAction({ traderId: t.traderId, ...limits, reason }, key))}>
              Save limits
            </Button>
          </div>
          <div className={d.formGrid}>
            <TextField label="Required Security Reserve (USDT)" value={reserve} onChange={setReserve} />
            <TextField label="Reward override (basis points)" value={reward} onChange={setReward} placeholder="Follow the programme" />
          </div>
          <div className={d.actions}>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !hasReason || blank(reserve) === null}
              onClick={() => cmd.run(`Change reserve for ${t.ref}`, (key) => setRequiredReserveAction({ traderId: t.traderId, requiredReserve: reserve.trim(), reason }, key))}
            >
              Save reserve
            </Button>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !hasReason}
              onClick={() => cmd.run(`Change reward for ${t.ref}`, (key) => setRewardAction({ traderId: t.traderId, rewardBps: reward.trim() === '' ? null : Number.parseInt(reward, 10), reason }, key))}
            >
              Save reward
            </Button>
          </div>
          {!hasReason ? <p className={d.fieldHint}>Each change needs the reason above; it is kept with the change.</p> : null}
        </PanelSection>
      ) : null}

      {perms.configure && approved ? (
        <PanelSection title="Switch to another verified destination">
          <SelectField label="Bank account" value={bankId} onChange={setBankId} options={detail.clientDestinations.banks.map((b) => ({ value: b.id, label: b.label }))} />
          <SelectField label="Wallet (send and receive)" value={walletId} onChange={setWalletId} options={detail.clientDestinations.wallets.map((w) => ({ value: w.id, label: w.label }))} />
          <div className={d.actions}>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !hasReason || t.openOrders > 0 || (bankId === detail.bank.bankAccountId && walletId === detail.wallet.walletId)}
              onClick={() => cmd.run(`Change settlement details for ${t.ref}`, (key) => setSettlementDetailsAction({ traderId: t.traderId, bankAccountId: bankId, walletId, reason }, key))}
            >
              Change settlement details
            </Button>
          </div>
          {t.openOrders > 0 ? <p className={d.fieldHint}>Not while an order is accepted or in progress.</p> : null}
        </PanelSection>
      ) : null}

      <PanelSection title="Capacity and rates · set by the trader">
        {detail.blocks.length === 0 ? <p className={d.fieldHint}>Opened when the trader is approved.</p> : null}
        {detail.blocks.map((b) => (
          <KeyValues
            key={b.side}
            items={[
              { label: b.side === 'BUY_USDT' ? 'Buys USDT' : 'Sells USDT', value: <Chip tone={b.status === 'ACTIVE' ? 'success' : 'muted'}>{b.status.toLowerCase()}</Chip> },
              { label: 'Rate', value: b.rate ? rate(b.rate) : 'not set' },
              { label: 'Capacity', value: `${b.capacity} (${b.held} held)` },
              { label: 'Per order', value: b.minOrder && b.maxOrder ? `${b.minOrder} – ${b.maxOrder}` : 'not set' },
            ]}
          />
        ))}
      </PanelSection>

      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
