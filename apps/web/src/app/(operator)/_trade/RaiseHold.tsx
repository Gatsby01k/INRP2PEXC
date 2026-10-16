'use client';

import { useState } from 'react';
import { raiseTradeNetworkHoldAction } from '../../../server/actions/network.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { GuardedAction } from '../_desk/GuardedAction.tsx';
import { TextField } from '../_desk/fields.tsx';
import { isPositiveDecimal, trx } from '../_desk/network.ts';
import d from '../_desk/desk.module.css';

/**
 * Making room in a trade's TRX hold for a transfer its quote never priced (FI-95): typed, never suggested, with the
 * reason the audit keeps. It comes from the same funder's free TRX; what it costs is the platform's.
 */
export function RaiseHold({ tradeId, tradeRef, held }: { tradeId: string; tradeRef: string; held: string }) {
  const cmd = useCommand();
  const [amount, setAmount] = useState('');
  const ok = isPositiveDecimal(amount);
  return (
    <div className={d.stackTight}>
      {cmd.dialog}
      <TextField label="Hold in all, TRX" value={amount} onChange={setAmount} mono placeholder={held} />
      <GuardedAction
        label="Raise the hold"
        stepUp
        reasonLabel="Why this trade needs more"
        minReason={10}
        disabled={!ok}
        disabledReason={!ok ? `It holds ${trx(held)} now.` : null}
        consequence={<>The trade holds {trx(amount)} of its funder’s TRX for its transfers. A transfer its quote did not price can then be planned; its cost comes out of the platform’s margin.</>}
        busy={cmd.busy}
        onConfirm={async (reason) => (await cmd.run(`Raise the TRX hold of ${tradeRef}`, (k) => raiseTradeNetworkHoldAction({ tradeId, amount, reason }, k))).ok}
      />
      {cmd.error ? <span className={d.fieldError}>{cmd.error}</span> : null}
    </div>
  );
}
