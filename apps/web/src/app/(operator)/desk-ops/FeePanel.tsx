'use client';

import { useState } from 'react';
import type { FeePolicyEntry, FeeProposalView } from '@inrp2p/traders';
import { Button } from '@inrp2p/ui';
import { decideFeeAction, proposeFeeAction, withdrawFeeAction } from '../../../server/actions/desk-ops.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { TextArea, TextField } from '../_desk/fields.tsx';
import { dateTime } from '../_desk/format.ts';
import { Chip, Columns, KpiBand, Notice, Section, Stack, Timeline } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/0$/, '')}%`;

/**
 * The platform's fee (ADR 0020 §2.17): what it is, the change waiting for a second person, and the fees before. A change is
 * one person's proposal and another's approval; approved, it applies to every price from then on — a price already given
 * keeps its own.
 */
export function FeePanel({ fees, meId, perms }: { fees: { current: FeePolicyEntry; proposal: FeeProposalView | null; history: readonly FeePolicyEntry[] }; meId: string; perms: { propose: boolean; approve: boolean } }) {
  const c = fees.current;
  return (
    <Columns>
      <Stack>
        <Section title="The fee now" hint={`Since ${dateTime(c.since)} · set by ${c.setBy}${c.approvedBy ? `, approved by ${c.approvedBy}` : ''}`}>
          <KpiBand
            label="The platform's fee"
            items={[
              { key: 'o', label: 'A desk’s own deal', value: `${c.ownDealBps} bps`, sub: `${pct(c.ownDealBps)} of the deal’s USDT`, size: 'lg' },
              { key: 'n', label: 'Through the network', value: `${c.networkDealBps} bps`, sub: `${pct(c.networkDealBps)} — stage 2` },
            ]}
          />
          <p className={d.fieldHint}>“{c.reason}”</p>
        </Section>
        <Section title="Before" count={fees.history.length}>
          {fees.history.length === 0 ? (
            <p className={d.fieldHint}>No earlier fee.</p>
          ) : (
            <Timeline
              events={fees.history.map((h, i) => ({
                key: `${h.since}:${i}`, title: `${h.ownDealBps} bps own · ${h.networkDealBps} bps network`,
                meta: `${h.reason} — ${h.setBy}${h.approvedBy ? `, approved by ${h.approvedBy}` : ''}`, time: dateTime(h.since),
              }))}
            />
          )}
        </Section>
      </Stack>
      <Section title={fees.proposal ? 'A change waiting for a decision' : 'Propose a change'} {...(fees.proposal ? { tone: 'brand' as const } : {})}>
        {fees.proposal ? <Proposal proposal={fees.proposal} current={c} mine={fees.proposal.proposedById === meId} canApprove={perms.approve} canPropose={perms.propose} /> : perms.propose ? <ProposeForm current={c} /> : <Notice>Proposing a change of the fee needs a role with fees:propose.</Notice>}
      </Section>
    </Columns>
  );
}

function Proposal({ proposal: p, current, mine, canApprove, canPropose }: { proposal: FeeProposalView; current: FeePolicyEntry; mine: boolean; canApprove: boolean; canPropose: boolean }) {
  const cmd = useCommand();
  return (
    <div className={d.stack}>
      <KpiBand
        label="Proposed fee"
        items={[
          { key: 'o', label: 'A desk’s own deal', value: `${p.ownDealBps} bps`, sub: `now ${current.ownDealBps} bps`, ...(p.ownDealBps !== current.ownDealBps ? { tone: 'warning' as const } : {}) },
          { key: 'n', label: 'Through the network', value: `${p.networkDealBps} bps`, sub: `now ${current.networkDealBps} bps`, ...(p.networkDealBps !== current.networkDealBps ? { tone: 'warning' as const } : {}) },
        ]}
      />
      <p className={d.fieldHint}>
        Proposed by {p.proposedBy}, {dateTime(p.proposedAt)}: “{p.reason}”
      </p>
      {mine ? (
        <>
          <Notice icon="shield">Someone else decides it: a change of the fee is never approved by the one who proposed it.</Notice>
          {canPropose ? (
            <div className={d.actions}>
              <Button size="sm" intent="ghost" disabled={cmd.busy} onClick={() => void cmd.run('Withdraw the proposal', (k) => withdrawFeeAction({ proposalId: p.id }, k))}>
                Withdraw it
              </Button>
            </div>
          ) : null}
        </>
      ) : canApprove ? (
        <div className={d.actions}>
          <GuardedAction
            label="Approve"
            trigger="primary"
            tone="neutral"
            busy={cmd.busy}
            stepUp
            consequence={`Every price from now on carries ${p.ownDealBps} bps on a desk’s own deal. Prices already given keep their own fee.`}
            reasonLabel="Note (optional)"
            minReason={0}
            onConfirm={async (note) => (await cmd.run('Approve the new fee', (k) => decideFeeAction({ proposalId: p.id, decision: 'APPROVE', note: note.trim() || null }, k))).ok}
          />
          <GuardedAction
            label="Reject"
            trigger="ghost"
            busy={cmd.busy}
            consequence="The fee stays as it is; the proposal is closed."
            reasonLabel="Why"
            onConfirm={async (note) => (await cmd.run('Reject the proposed fee', (k) => decideFeeAction({ proposalId: p.id, decision: 'REJECT', note }, k))).ok}
          />
        </div>
      ) : (
        <Notice>Approving a change of the fee needs a role with fees:approve.</Notice>
      )}
      {cmd.error ? (
        <Notice tone="danger" role="alert">
          {cmd.error}
        </Notice>
      ) : null}
      {cmd.dialog}
    </div>
  );
}

function ProposeForm({ current }: { current: FeePolicyEntry }) {
  const cmd = useCommand();
  const [own, setOwn] = useState(String(current.ownDealBps));
  const [network, setNetwork] = useState(String(current.networkDealBps));
  const [reason, setReason] = useState('');
  const ownN = Number.parseInt(own, 10);
  const netN = Number.parseInt(network, 10);
  const valid = /^\d{1,4}$/.test(own) && /^\d{1,4}$/.test(network) && ownN <= 1000 && netN <= 1000 && (ownN !== current.ownDealBps || netN !== current.networkDealBps) && reason.trim().length >= 10;
  return (
    <div className={d.stack}>
      <div className={d.formGrid}>
        <TextField label="A desk’s own deal (bps)" value={own} onChange={setOwn} mono maxLength={4} hint={/^\d+$/.test(own) ? pct(ownN) : undefined} />
        <TextField label="Through the network (bps)" value={network} onChange={setNetwork} mono maxLength={4} hint={/^\d+$/.test(network) ? pct(netN) : undefined} />
      </div>
      <TextArea label="Why" value={reason} onChange={setReason} rows={3} placeholder="What changes, and why now — read by whoever approves it, and kept with the fee" />
      <div className={d.actions}>
        <Button intent="primary" size="sm" disabled={!valid || cmd.busy} onClick={() => void cmd.run('Propose the new fee', (k) => proposeFeeAction({ ownDealBps: ownN, networkDealBps: netN, reason: reason.trim() }, k))}>
          Propose
        </Button>
        <Chip tone="neutral">a second person approves it</Chip>
      </div>
      {cmd.error ? (
        <Notice tone="danger" role="alert">
          {cmd.error}
        </Notice>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
