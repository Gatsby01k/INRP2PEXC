'use client';

import { useState } from 'react';
import { plainDecimal } from '../_desk/format.ts';
import type { DeskProgram } from '@inrp2p/traders';
import { Button, StepUpMark } from '@inrp2p/ui';
import { configureProgramAction } from '../../../server/actions/traders-desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { Checkbox, SelectField, TextArea, TextField } from '../_desk/fields.tsx';
import { Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';

const RAILS = ['UPI', 'IMPS', 'NEFT', 'RTGS'] as const;
type Rail = (typeof RAILS)[number];

/**
 * The programme settings (`traders:configure`, ⧗). Nothing here has a default that stands in for a decision: the
 * Security Reserve and the reward stay unset until someone sets them, and every change is audited with its reason.
 */
export function ProgramForm({ program, accounts, canConfigure }: { program: DeskProgram; accounts: readonly { accountId: string; label: string; bankName: string; last4: string }[]; canConfigure: boolean }) {
  const cmd = useCommand();
  const [reserve, setReserve] = useState(plainDecimal(program.defaultRequiredReserve));
  const [reward, setReward] = useState(program.rewardBps === null ? '' : String(program.rewardBps));
  const [offer, setOffer] = useState(String(program.offerTtlSeconds));
  const [hold, setHold] = useState(String(program.holdTtlSeconds));
  const [auto, setAuto] = useState(program.autoAssign);
  const [collection, setCollection] = useState(program.collectionAccountId ?? '');
  const [mode, setMode] = useState<'TO_EXCHANGE' | 'P2P'>(program.executionMode);
  const [timing, setTiming] = useState(() => ({
    escrowMinutes: String(program.p2pTiming.escrowMinutes),
    finalMinutes: String(program.p2pTiming.finalMinutes),
    pay: Object.fromEntries(RAILS.map((r) => [r, String(program.p2pTiming.pay[r])])) as Record<Rail, string>,
    receipt: Object.fromEntries(RAILS.map((r) => [r, String(program.p2pTiming.receipt[r])])) as Record<Rail, string>,
  }));
  const [reason, setReason] = useState('');
  const minutes = (v: string) => Number.parseInt(v, 10);

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
          executionMode: mode,
          p2pTiming: {
            escrowMinutes: minutes(timing.escrowMinutes),
            finalMinutes: minutes(timing.finalMinutes),
            pay: { UPI: minutes(timing.pay.UPI), IMPS: minutes(timing.pay.IMPS), NEFT: minutes(timing.pay.NEFT), RTGS: minutes(timing.pay.RTGS) },
            receipt: { UPI: minutes(timing.receipt.UPI), IMPS: minutes(timing.receipt.IMPS), NEFT: minutes(timing.receipt.NEFT), RTGS: minutes(timing.receipt.RTGS) },
          },
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
          label="How traders settle"
          value={mode}
          onChange={(v) => setMode(v === 'P2P' ? 'P2P' : 'TO_EXCHANGE')}
          disabled={!canConfigure}
          hint={mode === 'P2P' ? 'Rupees go straight between client and trader; INRP2P holds the USDT in escrow. No reward; the trader’s network deposit pays the TRX.' : 'Rupees go through INRP2P’s own bank account.'}
          options={[
            { value: 'P2P', label: 'P2P — INRP2P holds the USDT' },
            { value: 'TO_EXCHANGE', label: 'Through INRP2P’s account' },
          ]}
        />
        <SelectField
          label="Traders pay INR into"
          value={collection}
          onChange={setCollection}
          disabled={!canConfigure}
          options={[{ value: '', label: 'Not set' }, ...accounts.map((a) => ({ value: a.accountId, label: `${a.bankName} ••••${a.last4} · ${a.label}` }))]}
        />
      </div>
      <Checkbox label="Route new USDT-fixed requests to a trader automatically" checked={auto} onChange={setAuto} disabled={!canConfigure} />
      <fieldset className={d.stackTight} disabled={!canConfigure} aria-label="P2P deal times">
        <legend className={d.fieldLabel}>P2P deal times (minutes) · a running deal keeps the times it opened with</legend>
        <div className={d.formGrid} style={{ alignItems: 'start' }}>
          {RAILS.map((r) => (
            <TextField key={`pay-${r}`} label={`Buyer pays by ${r}`} value={timing.pay[r]} onChange={(v) => setTiming((t) => ({ ...t, pay: { ...t.pay, [r]: v } }))} hint="From the escrow being final." />
          ))}
          {RAILS.map((r) => (
            <TextField key={`receipt-${r}`} label={`Seller confirms ${r}`} value={timing.receipt[r]} onChange={(v) => setTiming((t) => ({ ...t, receipt: { ...t.receipt, [r]: v } }))} hint="Then INRP2P checks; never cancelled." />
          ))}
          <TextField label="Final period" value={timing.finalMinutes} onChange={(v) => setTiming((t) => ({ ...t, finalMinutes: v }))} hint="After the buyer is warned, before a cancel." />
          <TextField label="Trader funds a BUY’s escrow" value={timing.escrowMinutes} onChange={(v) => setTiming((t) => ({ ...t, escrowMinutes: v }))} hint="From the trade opening." />
        </div>
      </fieldset>
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
