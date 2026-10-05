'use client';

import { useState } from 'react';
import type { DeskTrade } from '@inrp2p/desk';
import { Button, StepUpMark } from '@inrp2p/ui';
import {
  approveDestinationChangeAction, cancelDestinationChangeAction, rejectDestinationChangeAction, requestDestinationChangeAction,
} from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { PanelSection } from '../_desk/ContextPanel.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { SelectField, TextArea } from '../_desk/fields.tsx';
import { dateTime } from '../_desk/format.ts';
import { Chip, KeyValues, Notice } from '../_desk/ui.tsx';
import type { TradePerms } from './types.ts';
import d from '../_desk/desk.module.css';

const STATUS: Record<DeskTrade['destinationChanges'][number]['status'], { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  REQUESTED: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Declined', tone: 'danger' },
  CANCELLED: { label: 'Withdrawn', tone: 'neutral' },
};

/**
 * Where the trade pays, and the way to change it (D1, TD-18): one person asks — with the reason and how the client
 * confirmed the new account or wallet — and someone else approves it with step-up. The client's own verified
 * destinations are the only choices; nothing changes until the approval, and a payout already sent to the old one is
 * resolved first.
 */
export function Destination({ trade, perms }: { trade: DeskTrade; perms: TradePerms }) {
  const cmd = useCommand();
  const open = !['COMPLETED', 'CANCELLED'].includes(trade.lifecycle);
  const pending = trade.destinationChanges.find((c) => c.status === 'REQUESTED');
  const options = trade.destinationOptions.payout;
  const [toId, setToId] = useState(options[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const changeCase = trade.cases.find((c) => c.type === 'CLIENT_BANK_CHANGED');
  const paysInr = trade.payout.currency === 'INR';

  return (
    <PanelSection title="Destination" aside={trade.destination?.label ?? 'none'} testId="destination">
      {pending ? (
        <div className={d.stackTight}>
          <KeyValues
            items={[
              { label: 'Change', value: `${pending.fromLabel} → ${pending.toLabel}`, strong: true },
              { label: 'Why', value: pending.reason },
              { label: 'Client confirmed', value: pending.evidence },
              { label: 'Asked by', value: `${pending.requestedBy === perms.meId ? 'you' : pending.requestedByLabel} · ${dateTime(pending.requestedAt)}` },
            ]}
          />
          {pending.requestedBy === perms.meId ? (
            <>
              <Notice tone="warning" icon="shield">You asked for this change, so someone else approves it.</Notice>
              <div className={d.actions}>
                <Button size="sm" disabled={cmd.busy} onClick={() => cmd.run(`Withdraw ${pending.ref}`, (key) => cancelDestinationChangeAction({ requestId: pending.id }, key))}>
                  Withdraw
                </Button>
              </div>
            </>
          ) : perms.approveDestinationChange ? (
            <div className={d.actions}>
              <Button
                intent="primary"
                size="sm"
                disabled={cmd.busy}
                shortcut={<StepUpMark label="needs your authenticator code" />}
                onClick={() => cmd.run(`Approve ${pending.ref}: pay ${pending.toLabel}`, (key) => approveDestinationChangeAction({ requestId: pending.id }, key))}
              >
                Approve
              </Button>
              <GuardedAction
                label="Decline"
                trigger="ghost"
                busy={cmd.busy}
                consequence="The trade keeps paying where it does; the request is closed as declined."
                reasonLabel="Why"
                onConfirm={async (note) => (await cmd.run(`Decline ${pending.ref}`, (key) => rejectDestinationChangeAction({ requestId: pending.id, note }, key))).ok}
              />
            </div>
          ) : (
            <Notice>Approving a destination change needs the owner or finance role.</Notice>
          )}
        </div>
      ) : open && perms.requestDestinationChange && options.length > 0 ? (
        <div className={d.stackTight}>
          <SelectField label={paysInr ? 'Pay to this verified account instead' : 'Pay to this verified wallet instead'} value={toId} onChange={setToId} options={options.map((o) => ({ value: o.id, label: o.label }))} />
          <TextArea label="Why" value={reason} onChange={setReason} placeholder="e.g. the client closed the account the trade was accepted with" />
          <TextArea label="How the client confirmed it" value={evidence} onChange={setEvidence} placeholder="e.g. added by their administrator with an authenticator code; confirmed on a call to the number on file" />
          <div className={d.actions}>
            <Button
              size="sm"
              intent="primary"
              disabled={cmd.busy || toId === '' || reason.trim().length < 10 || evidence.trim().length < 10}
              shortcut={<StepUpMark label="needs your authenticator code" />}
              onClick={() =>
                cmd.run(`Ask to pay ${trade.ref} elsewhere`, (key) =>
                  requestDestinationChangeAction(
                    { tradeId: trade.tradeId, ...(paysInr ? { toBankAccountId: toId } : { toWalletId: toId }), reason: reason.trim(), evidence: evidence.trim(), ...(changeCase ? { exceptionId: changeCase.id } : {}) },
                    key,
                  ),
                )
              }
            >
              Ask for approval
            </Button>
          </div>
        </div>
      ) : open && options.length === 0 && changeCase ? (
        <Notice>The client has no other verified {paysInr ? 'account' : 'wallet'} yet: one is added first (by their administrator, or by the desk with them).</Notice>
      ) : null}

      {trade.destinationChanges.filter((c) => c.status !== 'REQUESTED').length > 0 ? (
        <ul className={d.stackTight} style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {trade.destinationChanges.filter((c) => c.status !== 'REQUESTED').map((c) => (
            <li key={c.id} className={d.row}>
              <Chip tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Chip>
              <span className={d.muted}>
                {c.ref} · {c.fromLabel} → {c.toLabel}
                {c.decidedByLabel ? ` · ${c.decidedByLabel}` : ''}
                {c.decidedAt ? ` · ${dateTime(c.decidedAt)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </PanelSection>
  );
}
