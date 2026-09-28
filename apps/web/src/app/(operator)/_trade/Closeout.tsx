'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { DeskAdjustment, DeskTrade } from '@inrp2p/desk';
import { Button, StepUpMark, UTRField, normalizeUtr } from '@inrp2p/ui';
import {
  approveAdjustmentAction, cancelTradeAction, confirmRefundLegAction, createRefundLegAction, openTradeExceptionAction, refundAndCancelAction, rejectAdjustmentAction,
} from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { Choices, SelectField, TextField } from '../_desk/fields.tsx';
import { dateTime, inr, money, titleCase, usdt } from '../_desk/format.ts';
import { Chip, KeyValues, LegStatusChip, Notice } from '../_desk/ui.tsx';
import type { CollectionAccount } from './ClientFunds.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

/**
 * How a trade ends when it does not settle: a plain cancel while nothing has been received (T9), or — once the
 * client's funds are confirmed — a refund that one person plans and another confirms, and only then the cancel
 * (T10). Each step is a guarded, reasoned, step-up command; the page never offers a step the domain would refuse
 * in the state the trade is in, and says why when it withholds one.
 */
export function Closeout({ trade, perms, refundAccounts }: { trade: DeskTrade; perms: TradePerms; refundAccounts: readonly CollectionAccount[] }) {
  const cmd = useCommand();
  const open = trade.lifecycle !== 'COMPLETED' && trade.lifecycle !== 'CANCELLED';
  const inAsset = trade.receivable.currency;
  const received = Money.parse(trade.received, inAsset);
  const refundLegs = trade.legs.filter((l) => l.side === 'REFUND_TO_CLIENT');
  const refundPlanned = refundLegs.filter((l) => l.status === 'PENDING' || l.status === 'PROCESSING' || l.status === 'COMPLETED').reduce((a, l) => a.add(Money.parse(l.amount, inAsset)), Money.zero(inAsset));
  const refunded = refundLegs.filter((l) => l.status === 'COMPLETED').reduce((a, l) => a.add(Money.parse(l.amount, inAsset)), Money.zero(inAsset));
  const payoutsStarted = trade.legs.some((l) => l.side === 'EXCHANGE_TO_CLIENT' && (l.status === 'PROCESSING' || l.status === 'COMPLETED'));
  const beforeFunds = trade.lifecycle === 'AWAITING_FIRST_LEG' || trade.lifecycle === 'FIRST_LEG_DETECTED';
  const cancelCase = trade.cases.find((c) => c.type === 'TRADE_CANCELLATION');
  const [refundFrom, setRefundFrom] = useState(refundAccounts[0]?.accountId ?? '');
  const [walletId, setWalletId] = useState(trade.payoutOptions.wallets[0]?.walletId ?? '');

  if (!open) return null;

  return (
    <PanelSection title="Cancel or refund" testId="closeout">
      {!received.isPositive() ? (
        beforeFunds ? (
          perms.cancelTrade ? (
            <GuardedAction
              label="Cancel trade"
              tone="danger"
              trigger="secondary"
              stepUp
              busy={cmd.busy}
              consequence="Nothing has been received. Cancelling releases every reservation and the deposit address, reverses the acceptance journal and tells the client. There is no way back — a new trade needs a new quote."
              reasonLabel="Reason (the client is told the trade was cancelled)"
              onConfirm={async (reason) =>
                (await cmd.run(`Cancel ${trade.ref}`, (key) => cancelTradeAction({ tradeId: trade.tradeId, reason, ...(cancelCase ? { exceptionId: cancelCase.id } : {}) }, key))).ok
              }
            />
          ) : (
            <Notice>Cancelling a trade needs the dealer or owner role.</Notice>
          )
        ) : (
          <Notice>Nothing to cancel from here.</Notice>
        )
      ) : payoutsStarted ? (
        <Notice icon="lock">A payout has been sent, so this trade can no longer be refunded and cancelled. Correct it with a financial adjustment instead.</Notice>
      ) : (
        <>
          <KeyValues
            split
            items={[
              { label: 'Confirmed from the client', value: money(trade.received, inAsset, { exact: inAsset === 'USDT' }) },
              { label: 'Refund planned or sent', value: money(refundPlanned.toDecimalString(), inAsset, { exact: inAsset === 'USDT' }) },
              { label: 'Refunded and confirmed', value: money(refunded.toDecimalString(), inAsset, { exact: inAsset === 'USDT' }), strong: true },
            ]}
          />

          {refundPlanned.minor < received.minor && perms.createPayout ? (
            <div className={d.stackTight}>
              {inAsset === 'INR' ? (
                <SelectField label="Refund from" value={refundFrom} onChange={setRefundFrom} options={refundAccounts.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${a.label}` }))} />
              ) : (
                <SelectField label="Refund from" value={walletId} onChange={setWalletId} options={trade.payoutOptions.wallets.map((w) => ({ value: w.walletId, label: `${w.label} · ${money(w.available, 'USDT')} free` }))} />
              )}
              <GuardedAction
                label="Plan the refund"
                trigger="secondary"
                busy={cmd.busy}
                consequence={`Creates a refund of everything received not yet refunded — ${money(received.sub(refundPlanned).toDecimalString(), inAsset, { exact: inAsset === 'USDT' })} — back to the client’s own ${inAsset === 'INR' ? 'bank account' : 'source wallet'}. It pays nothing yet: a second person confirms it with the evidence.`}
                onConfirm={async () =>
                  (
                    await cmd.run(`Plan the refund on ${trade.ref}`, (key) =>
                      createRefundLegAction({ tradeId: trade.tradeId, ...(inAsset === 'INR' ? { inrAccountId: refundFrom } : { treasuryWalletId: walletId }) }, key),
                    )
                  ).ok
                }
              />
            </div>
          ) : null}

          {refundLegs.length > 0 ? (
            <ul className={t.legs}>
              {refundLegs.map((leg) => (
                <RefundLeg key={leg.id} leg={leg} tradeRef={trade.ref} perms={perms} />
              ))}
            </ul>
          ) : null}

          {refunded.minor === received.minor ? (
            perms.cancelTrade ? (
              <GuardedAction
                label="Cancel trade"
                confirmLabel="Close as refunded and cancelled"
                tone="danger"
                stepUp
                busy={cmd.busy}
                consequence="Every confirmed rupee or USDT is back with the client. Cancelling reverses the acceptance journal and closes the trade for good."
                reasonLabel="Reason"
                onConfirm={async (reason) => (await cmd.run(`Cancel ${trade.ref} after the refund`, (key) => refundAndCancelAction({ tradeId: trade.tradeId, reason, ...(cancelCase ? { exceptionId: cancelCase.id } : {}) }, key))).ok}
              />
            ) : (
              <Notice>Closing the trade needs the dealer or owner role.</Notice>
            )
          ) : (
            <Notice icon="clock">The trade is cancelled only after the whole refund is confirmed.</Notice>
          )}
        </>
      )}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </PanelSection>
  );
}

function RefundLeg({ leg, tradeRef, perms }: { leg: DeskTrade['legs'][number]; tradeRef: string; perms: TradePerms }) {
  const cmd = useCommand();
  const [utr, setUtr] = useState('');
  const [hash, setHash] = useState('');
  const mine = leg.createdBy === perms.meId;
  const pending = leg.status === 'PENDING' || leg.status === 'PROCESSING';
  const evidence = leg.asset === 'INR' ? normalizeUtr(utr).length >= 6 : hash.replace(/^0x/, '').length >= 64;
  return (
    <li className={t.leg} {...(pending ? { 'data-attention': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>{money(leg.amount, leg.asset, { exact: leg.asset === 'USDT' })} refund</span>
        <LegStatusChip status={leg.status} />
      </div>
      <div className={t.legMeta}>
        <span>{leg.ref}</span>
        <span>
          planned by <strong>{mine ? 'you' : leg.createdByLabel}</strong> · {dateTime(leg.createdAt)}
        </span>
      </div>
      {pending ? (
        <div className={t.legNext}>
          <span className={t.legNextLabel}>Next · a second person confirms it</span>
          {mine ? (
            <Notice tone="warning" icon="shield">
              You planned this refund, so someone else must confirm it (SECURITY §4).
            </Notice>
          ) : perms.approveRefund ? (
            <>
              {leg.asset === 'INR' ? <UTRField value={utr} onChange={setUtr} label="Refund UTR / reference" /> : <TextField label="Refund transaction hash" value={hash} onChange={(v) => setHash(v.trim())} mono />}
              <div className={d.actions}>
                <Button
                  intent="primary"
                  size="sm"
                  disabled={cmd.busy || !evidence}
                  shortcut={<StepUpMark label="needs your authenticator code" />}
                  onClick={() =>
                    cmd.run(`Confirm refund ${money(leg.amount, leg.asset)} on ${tradeRef}`, (key) =>
                      confirmRefundLegAction({ legId: leg.id, ...(leg.asset === 'INR' ? { rail: 'IMPS' as const, utr: normalizeUtr(utr) } : { txHash: hash.replace(/^0x/, ''), logIndex: 0 }) }, key),
                    )
                  }
                >
                  Confirm refund
                </Button>
              </div>
            </>
          ) : (
            <Notice>Confirming a refund needs the owner or finance role.</Notice>
          )}
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

const FLAG_TYPES = [
  { value: 'TRADE_CANCELLATION', title: 'Client asked to cancel', description: 'Blocks the trade until it is cancelled or the request withdrawn.' },
  { value: 'WRONG_NETWORK', title: 'Sent on the wrong network', description: 'Blocks the trade while recovery is worked out.' },
  { value: 'OPERATOR_MISTAKE', title: 'Desk mistake to correct', description: 'Blocks the trade until the correction is resolved.' },
  { value: 'INR_PAYOUT_DELAYED', title: 'Payout delayed at the bank', description: 'A warning: the trade keeps moving.' },
] as const;

type FlagType = (typeof FLAG_TYPES)[number]['value'];

/** The cases the system cannot see for itself (`exception.open`). A blocking one puts the trade on hold at once. */
export function FlagException({ trade }: { trade: DeskTrade }) {
  const cmd = useCommand();
  const [type, setType] = useState<FlagType>('TRADE_CANCELLATION');
  const blocking = type !== 'INR_PAYOUT_DELAYED';
  return (
    <PanelSection title="Flag an exception">
      <Choices<FlagType> legend="What happened" value={type} onChange={setType} choices={FLAG_TYPES.map((f) => ({ value: f.value, title: f.title, description: f.description }))} />
      <GuardedAction
        label="Open case"
        trigger="secondary"
        tone={blocking ? 'danger' : 'neutral'}
        busy={cmd.busy}
        consequence={blocking ? `${trade.ref} goes on hold immediately: no payout can be created or sent until the case is resolved.` : 'The case is listed on Exceptions; the trade keeps moving.'}
        reasonLabel="Details for whoever resolves it"
        onConfirm={async (notes) => (await cmd.run(`Open a case on ${trade.ref}`, (key) => openTradeExceptionAction({ tradeId: trade.tradeId, type, notes }, key))).ok}
      />
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </PanelSection>
  );
}

/**
 * Financial adjustments on the trade: requested by one person, approved or rejected by another (FI-31). The
 * frozen terms never change; an approved adjustment posts its own journal, and the effective obligations move.
 */
export function Adjustments({ adjustments, perms }: { adjustments: readonly DeskAdjustment[]; perms: TradePerms }) {
  if (adjustments.length === 0) return null;
  return (
    <PanelSection title="Adjustments" aside={`${adjustments.filter((a) => a.status === 'REQUESTED').length} waiting`}>
      <ul className={t.legs}>
        {adjustments.map((a) => (
          <AdjustmentItem key={a.id} a={a} perms={perms} />
        ))}
      </ul>
    </PanelSection>
  );
}

export function AdjustmentItem({ a, perms, showTrade = false }: { a: DeskAdjustment; perms: Pick<TradePerms, 'meId' | 'approveAdjustment'>; showTrade?: boolean }) {
  const cmd = useCommand();
  const mine = a.requestedBy === perms.meId;
  const deltas = [
    Money.parse(a.deltaBase, 'USDT').isZero() ? null : { label: 'USDT amount', value: usdt(a.deltaBase, { exact: true }) },
    Money.parse(a.deltaClientInr, 'INR').isZero() ? null : { label: 'Client INR', value: inr(a.deltaClientInr, { sign: true }) },
    a.deltaRouteInr && !Money.parse(a.deltaRouteInr, 'INR').isZero() ? { label: 'Route INR', value: inr(a.deltaRouteInr, { sign: true }) } : null,
    a.deltaMargin && !Money.parse(a.deltaMargin, 'INR').isZero() ? { label: 'Gross margin', value: inr(a.deltaMargin, { sign: true }) } : null,
  ].filter((x): x is { label: string; value: string } => x !== null);
  return (
    <li className={t.leg} {...(a.status === 'REQUESTED' ? { 'data-attention': '' } : {})}>
      <div className={t.legHead}>
        <span className={t.legAmount}>
          {titleCase(a.type)}
          {showTrade ? <span className={d.muted}> · {a.tradeRef} · {a.clientName}</span> : null}
        </span>
        <Chip tone={a.status === 'POSTED' ? 'success' : a.status === 'REJECTED' ? 'muted' : 'warning'}>{a.status === 'REQUESTED' ? 'Waiting approval' : titleCase(a.status)}</Chip>
      </div>
      <KeyValues split items={deltas.map((x) => ({ label: `Change in ${x.label}`, value: x.value }))} />
      <div className={t.legMeta}>
        <span>{a.ref}</span>
        <span>
          requested by <strong>{mine ? 'you' : a.requestedByLabel}</strong> · {dateTime(a.requestedAt)}
        </span>
        {a.decidedByLabel ? <span>decided by {a.decidedByLabel}</span> : null}
      </div>
      <Notice>{a.reason}</Notice>
      {a.rejectReason ? <Notice tone="danger">Rejected: {a.rejectReason}</Notice> : null}
      {a.status === 'REQUESTED' ? (
        mine ? (
          <Notice tone="warning" icon="shield">
            You requested this adjustment, so someone else must decide it.
          </Notice>
        ) : perms.approveAdjustment ? (
          <div className={d.actions}>
            <GuardedAction
              label="Approve and post"
              trigger="primary"
              stepUp
              busy={cmd.busy}
              consequence="Posts the adjustment journal and moves the trade’s effective obligations. The frozen terms stay as they were; this correction sits beside them in the ledger for good."
              onConfirm={async () => (await cmd.run(`Approve ${a.ref}`, (key) => approveAdjustmentAction({ adjustmentId: a.id }, key))).ok}
            />
            <GuardedAction
              label="Reject"
              trigger="ghost"
              tone="danger"
              stepUp
              busy={cmd.busy}
              consequence="Nothing is posted. The request stays on the record with your reason."
              reasonLabel="Why"
              onConfirm={async (reason) => (await cmd.run(`Reject ${a.ref}`, (key) => rejectAdjustmentAction({ adjustmentId: a.id, reason }, key))).ok}
            />
          </div>
        ) : (
          <Notice>Deciding an adjustment needs the owner or finance role.</Notice>
        )
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
