'use client';

import { useState } from 'react';
import type { DeskTrade } from '@inrp2p/desk';
import { Button } from '@inrp2p/ui';
import { decideP2pPaymentAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { Ago } from '../_desk/clock.tsx';
import { Choices, TextArea, TextField } from '../_desk/fields.tsx';
import { money, time } from '../_desk/format.ts';
import { Chip, KeyValues, Notice } from '../_desk/ui.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';
import t from './trade.module.css';

type View = NonNullable<DeskTrade['p2p']>;
type Decision = 'PAID' | 'NOT_PAID';

const REASON: Record<NonNullable<View['dispute']>['reason'], string> = {
  NO_CREDIT: 'No credit in their account',
  WRONG_AMOUNT: 'A different amount arrived',
  OTHER: 'Something else',
};

const REFUND: Record<string, string> = { PENDING: 'planned', PROCESSING: 'on its way', COMPLETED: 'back with the client', FAILED: 'failed', CANCELLED: 'cancelled' };

/**
 * A P2P payment for INRP2P to decide (ADR 0020 §2.15): its payee disputed it, or never answered. The payment as it was
 * filed, what each side told INRP2P, and the decision — taken from the payee's bank, never from a screenshot the payer
 * sends: paid, with the sender as that bank shows it (the escrow releases), or not paid (a BUY is cancelled and the
 * trader's USDT goes back; a SELL unwinds and the client's goes back). Then, for an unwinding SELL, how its return stands.
 */
export function P2pPayment({ trade, perms }: { trade: DeskTrade; perms: TradePerms }) {
  const cmd = useCommand();
  const [decision, setDecision] = useState<Decision>('PAID');
  const [name, setName] = useState('');
  const [account, setAccount] = useState('');
  const [notes, setNotes] = useState('');
  const view = trade.p2p;
  if (!view) return null;

  const buy = trade.direction === 'BUY_USDT';
  const payee = view.payee === 'CLIENT' ? 'client' : 'trader';
  const payer = view.payee === 'CLIENT' ? 'trader' : 'client';
  const dispute = view.dispute;
  const open = dispute?.status === 'OPEN';
  const allowed = decision === 'PAID' ? (buy ? perms.confirmIncoming : perms.confirmPayout) : perms.cancelTrade;
  const ready = !cmd.busy && allowed && notes.trim().length >= 5 && (decision === 'NOT_PAID' || name.trim().length >= 2);
  const title = open ? 'P2P payment disputed' : view.decidable ? 'P2P payment unanswered' : view.unwind ? 'Client’s USDT going back' : 'P2P payment';

  const decide = () =>
    cmd.run(
      decision === 'PAID' ? `Decide ${view.payment?.ref ?? 'the payment'} paid — release the escrow` : `Decide ${view.payment?.ref ?? 'the payment'} not paid — ${buy ? 'cancel the trade' : 'unwind the deal'}`,
      (key) =>
        decideP2pPaymentAction(
          { tradeId: trade.tradeId, decision, notes: notes.trim(), ...(decision === 'PAID' ? { senderName: name.trim(), senderAccount: account.trim() || null } : {}) },
          key,
        ),
    );

  return (
    <PanelSection title={title} aside={dispute ? dispute.ref : undefined} testId="p2p-payment" {...(open ? { tone: 'danger' as const } : {})}>
      <div className={d.stack}>
        {view.payment ? (
          <KeyValues
            label="The payment"
            items={[
              { label: 'Payment', value: <span className={d.mono}>{view.payment.ref}</span> },
              { label: 'Amount', value: money(view.payment.amount, 'INR'), strong: true },
              { label: 'Reference', value: view.payment.utr ? <span className={d.mono}>{`${view.payment.rail ?? ''} · ${view.payment.utr}`}</span> : '—' },
              { label: `Filed by the ${payer}`, value: <><Ago at={view.payment.filedAt} /> · {time(view.payment.filedAt)}</> },
              { label: 'Declared from', value: view.payment.declaredFrom ?? 'any of the payer’s registered accounts' },
            ]}
          />
        ) : null}

        {dispute ? (
          <div className={t.disputeSides}>
            <div className={t.disputeSide}>
              <span className={d.fieldLabel}>The {payee} says · payee</span>
              <strong>{REASON[dispute.reason]}</strong>
              {dispute.payeeNote ? <p className={t.disputeNote}>{dispute.payeeNote}</p> : null}
              <span className={d.muted}>
                <Ago at={dispute.openedAt} />
              </span>
            </div>
            <div className={t.disputeSide}>
              <span className={d.fieldLabel}>The {payer} says · payer</span>
              {dispute.payerNote ? <p className={t.disputeNote}>{dispute.payerNote}</p> : <span className={d.muted}>Not answered yet</span>}
              {dispute.payerNotedAt ? (
                <span className={d.muted}>
                  <Ago at={dispute.payerNotedAt} />
                </span>
              ) : null}
            </div>
          </div>
        ) : view.overdue ? (
          <Notice tone="warning" icon="clock">
            The {payee} has neither confirmed nor disputed it in its window.
          </Notice>
        ) : null}

        {dispute && dispute.status !== 'OPEN' ? (
          <div className={d.stackTight}>
            <Chip tone={dispute.status === 'PAID' ? 'success' : 'danger'} glyph={dispute.status === 'PAID' ? 'done' : 'closed'}>
              {dispute.status === 'PAID' ? (dispute.decidedVia === 'PAYEE' ? `The ${payee} confirmed it after all` : 'Decided paid') : 'Decided not paid'}
            </Chip>
            {dispute.decisionNotes && dispute.decidedVia === 'INRP2P' ? <p className={t.disputeNote}>{dispute.decisionNotes}</p> : null}
          </div>
        ) : null}

        {view.decidable ? (
          <div className={d.stackTight} data-testid="p2p-decision">
            <Choices<Decision>
              legend="Decision"
              value={decision}
              onChange={setDecision}
              choices={[
                {
                  value: 'PAID',
                  title: 'Paid — release the escrow',
                  description: `The ${payee}’s bank shows the credit, from the ${payer}’s own account.`,
                  ...(buy ? (perms.confirmIncoming ? {} : { disabled: true }) : perms.confirmPayout ? {} : { disabled: true }),
                },
                {
                  value: 'NOT_PAID',
                  title: buy ? 'Not paid — cancel the trade' : 'Not paid — unwind the deal',
                  description: buy ? 'The client’s payment fails; the trader’s USDT goes back from the escrow.' : 'The trader’s payment fails; the client’s USDT goes back to the wallet it came from.',
                  ...(perms.cancelTrade ? {} : { disabled: true }),
                },
              ]}
            />
            {decision === 'PAID' ? (
              <div className={t.pair}>
                <TextField label={`Sender, as the ${payee}’s bank shows it`} value={name} onChange={setName} placeholder="e.g. RAHUL KUMAR SHARMA" maxLength={140} />
                <TextField label="Account or UPI, if shown" value={account} onChange={setAccount} mono maxLength={80} />
              </div>
            ) : null}
            <TextArea
              label="Evidence"
              value={notes}
              onChange={setNotes}
              rows={3}
              placeholder={decision === 'PAID' ? 'Statement line or the payee’s bank screen: date, amount, sender, UTR' : 'What the payee’s bank shows: no credit for this UTR, the amount that did arrive…'}
              hint="Recorded with the decision; both sides are told the outcome, never these words."
            />
            <div className={d.actions}>
              <Button intent={decision === 'PAID' ? 'primary' : 'danger'} size="sm" disabled={!ready} aria-busy={cmd.busy || undefined} onClick={() => void decide()}>
                {decision === 'PAID' ? 'Decide paid' : 'Decide not paid'}
              </Button>
              {!allowed ? <span className={d.muted}>{decision === 'PAID' ? 'Needs a role that confirms this payment.' : 'Needs a role that cancels trades.'}</span> : null}
            </div>
            <Notice icon="shield">Never on a screenshot from the payer: only the payee’s bank shows who sent what.</Notice>
          </div>
        ) : null}

        {view.unwind ? (
          <div className={d.stackTight}>
            <KeyValues
              label="The return"
              items={[
                { label: 'Why', value: view.unwind.reason === 'PAY_WINDOW_MISSED' ? 'The trader did not pay in time' : 'Decided not paid' },
                { label: 'Refund', value: view.unwind.refundRef ? <><span className={d.mono}>{view.unwind.refundRef}</span> · {REFUND[view.unwind.refundStatus ?? ''] ?? view.unwind.refundStatus}</> : 'not planned yet' },
              ]}
            />
            {view.unwind.waitingReason ? (
              <Notice tone="warning" icon="flag">
                <strong>Waits for a person.</strong> {view.unwind.waitingReason} — then Refund and cancel on the trade record.
              </Notice>
            ) : null}
          </div>
        ) : null}

        {cmd.error ? (
          <Notice tone="danger" role="alert">
            {cmd.error}
          </Notice>
        ) : null}
      </div>
      {cmd.dialog}
    </PanelSection>
  );
}
