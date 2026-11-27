'use client';

import { useState } from 'react';
import { setPeerPolicyAction } from '../../../server/actions/pricing.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { TextField } from '../_desk/fields.tsx';
import { Chip } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

export interface PeerMatchingView {
  readonly enabled: boolean;
  readonly feeBps: number;
  readonly minDealUsdt: string;
  readonly live: number;
  readonly started7d: number;
  readonly ended7d: number;
}

/**
 * ADR 0033: clients meet clients. Off by default; switched on, a waiting client is also a price for the other side, and
 * two waiting clients meet without a trader — INRP2P's fee inside the rate, the network split. Every change is a
 * person's, with the reason and a fresh authenticator code.
 */
export function PeerMatching({ view, canSet }: { view: PeerMatchingView; canSet: boolean }) {
  const cmd = useCommand();
  const [fee, setFee] = useState(String(view.feeBps));
  const [min, setMin] = useState(view.minDealUsdt);
  const feeBps = /^\d{1,3}$/.test(fee) ? Number.parseInt(fee, 10) : null;
  const changed = feeBps !== view.feeBps || min !== view.minDealUsdt;
  const valid = feeBps !== null && feeBps <= 100 && /^\d{1,6}(\.\d{1,2})?$/.test(min);
  const set = (label: string, change: { enabled: boolean; feeBps?: number; minDealUsdt?: string }) => async (reason: string) =>
    (await cmd.run(label, (k) => setPeerPolicyAction({ ...change, reason }, k))).ok;

  return (
    <div className={d.stack}>
      {cmd.dialog}
      <div className={d.row}>
        <Chip tone={view.enabled ? 'success' : 'neutral'}>{view.enabled ? 'Clients meet clients' : 'Clients meet traders only'}</Chip>
        <Chip tone="neutral">Fee {(view.feeBps / 100).toFixed(2)}% inside the rate</Chip>
        <Chip tone="neutral">From {view.minDealUsdt} USDT</Chip>
        <Chip tone="neutral">{view.live} meeting{view.live === 1 ? '' : 's'} waiting · {view.started7d} started, {view.ended7d} ended in 7 days</Chip>
        {canSet ? (
          <GuardedAction
            label={view.enabled ? 'Stop client meetings' : 'Let clients meet clients'}
            tone={view.enabled ? 'danger' : 'neutral'}
            stepUp
            reasonLabel="Reason"
            minReason={10}
            consequence={view.enabled
              ? 'Waiting clients wait for traders only again. Meetings already started run to their end; ones waiting for a start end.'
              : 'A waiting client is also a price for the other side. Two clients meet without a trader: the deal runs P2P with the usual escrow, INRP2P keeps its fee inside the rate, and each client pays half the network.'}
            busy={cmd.busy}
            onConfirm={set(view.enabled ? 'Stop client meetings' : 'Let clients meet clients', { enabled: !view.enabled })}
          />
        ) : null}
      </div>
      {canSet ? (
        <div className={d.row}>
          <TextField label="Fee, basis points" value={fee} onChange={setFee} mono />
          <TextField label="Smallest meeting, USDT" value={min} onChange={setMin} mono />
          <GuardedAction
            label="Save fee and minimum"
            stepUp
            reasonLabel="Reason"
            minReason={10}
            disabled={!changed || !valid}
            disabledReason={!valid ? 'The fee is 0 to 100 basis points; the minimum a USDT amount.' : !changed ? 'Nothing changed.' : null}
            consequence="New meetings use these from now on; meetings already made keep their own."
            busy={cmd.busy}
            onConfirm={set('Save fee and minimum', { enabled: view.enabled, feeBps: feeBps ?? view.feeBps, minDealUsdt: min })}
          />
        </div>
      ) : null}
    </div>
  );
}
