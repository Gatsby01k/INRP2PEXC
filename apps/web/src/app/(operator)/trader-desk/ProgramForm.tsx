'use client';

import { useState } from 'react';
import type { DeskProgram } from '@inrp2p/traders';
import { Button, StepUpMark } from '@inrp2p/ui';
import { configureProgramAction } from '../../../server/actions/traders-desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Checkbox, SelectField, TextArea, TextField } from '../_desk/fields.tsx';
import { Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

/**
 * The programme settings (`traders:configure`, ⧗). Nothing here has a default that stands in for a decision: the
 * Security Reserve and the reward stay unset until someone sets them, and every change is audited with its reason.
 */
export function ProgramForm({ program, accounts, canConfigure }: { program: DeskProgram; accounts: readonly { accountId: string; label: string; bankName: string; last4: string }[]; canConfigure: boolean }) {
  const cmd = useCommand();
  const [reserve, setReserve] = useState(program.defaultRequiredReserve ?? '');
  const [reward, setReward] = useState(program.rewardBps === null ? '' : String(program.rewardBps));
  const [offer, setOffer] = useState(String(program.offerTtlSeconds));
  const [hold, setHold] = useState(String(program.holdTtlSeconds));
  const [auto, setAuto] = useState(program.autoAssign);
  const [collection, setCollection] = useState(program.collectionAccountId ?? '');
  const [reason, setReason] = useState('');

  const save = () =>
    cmd.run('Save trader programme', (key) =>
      configureProgramAction(
        {
          expectedVersion: program.version,
          defaultRequiredReserve: reserve.trim() === '' ? null : reserve.trim(),
          rewardBps: reward.trim() === '' ? null : Number.parseInt(reward, 10),
          offerTtlSeconds: Number.parseInt(offer, 10),
          holdTtlSeconds: Number.parseInt(hold, 10),
          autoAssign: auto,
          collectionAccountId: collection === '' ? null : collection,
          reason,
        },
        key,
      ),
    );

  return (
    <form
      className={d.stackTight}
      aria-label="Programme"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className={d.formGrid} style={{ alignItems: 'start' }}>
        <TextField label="Default Security Reserve (USDT)" value={reserve} onChange={setReserve} placeholder="Not set" disabled={!canConfigure} hint="Offered at approval; each trader’s own can differ." />
        <TextField label="Reward (bps of the order’s INR)" value={reward} onChange={setReward} placeholder="No reward" disabled={!canConfigure} hint="Fixed when an order starts; paid when it completes." />
        <TextField label="Offer time (s)" value={offer} onChange={setOffer} disabled={!canConfigure} hint="How long a trader has to take an offer." />
        <TextField label="Hold time (s)" value={hold} onChange={setHold} disabled={!canConfigure} hint="How long an accepted order holds the request." />
        <SelectField
          label="Traders pay INR into"
          value={collection}
          onChange={setCollection}
          disabled={!canConfigure}
          options={[{ value: '', label: 'Not set' }, ...accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${a.label}` }))]}
        />
      </div>
      <Checkbox label="Route new USDT-fixed requests to a trader automatically" checked={auto} onChange={setAuto} disabled={!canConfigure} />
      {canConfigure ? (
        <>
          <TextArea label="Reason for the change" value={reason} onChange={setReason} />
          <div className={d.actions}>
            <Button intent="primary" size="sm" type="submit" disabled={cmd.busy || reason.trim().length < 3} shortcut={<StepUpMark label="needs your authenticator code" />}>
              Save programme
            </Button>
          </div>
        </>
      ) : (
        <Notice icon="lock">Changing the programme needs traders:configure.</Notice>
      )}
      {cmd.error ? (
        <p className={d.errorLine} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </form>
  );
}
