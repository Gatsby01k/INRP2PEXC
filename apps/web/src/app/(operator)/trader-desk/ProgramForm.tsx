'use client';

import { useState } from 'react';
import type { DeskProgram } from '@inrp2p/traders';
import { Button } from '@inrp2p/ui';
import { configureProgramAction } from '../../../server/actions/traders-desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import styles from './traders.module.css';

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
    <section className="ix-card" aria-label="Programme">
      <h2 className="ix-sectionTitle">Programme</h2>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="ix-field">
          <label htmlFor="p-reserve">Default Security Reserve (USDT)</label>
          <input id="p-reserve" className="ix-input" inputMode="decimal" value={reserve} onChange={(e) => setReserve(e.target.value)} placeholder="Not set" disabled={!canConfigure} />
          <span className="ix-hint">Offered at approval; each trader’s own requirement can differ.</span>
        </div>
        <div className="ix-field">
          <label htmlFor="p-reward">Reward (basis points of the order’s INR value)</label>
          <input id="p-reward" className="ix-input" inputMode="numeric" value={reward} onChange={(e) => setReward(e.target.value)} placeholder="No reward" disabled={!canConfigure} />
          <span className="ix-hint">Fixed on each order when it starts; paid when it completes. Empty means none.</span>
        </div>
        <div className={styles.row}>
          <div className="ix-field">
            <label htmlFor="p-offer">Offer time (s)</label>
            <input id="p-offer" className="ix-input" inputMode="numeric" value={offer} onChange={(e) => setOffer(e.target.value)} disabled={!canConfigure} />
          </div>
          <div className="ix-field">
            <label htmlFor="p-hold">Hold time (s)</label>
            <input id="p-hold" className="ix-input" inputMode="numeric" value={hold} onChange={(e) => setHold(e.target.value)} disabled={!canConfigure} />
          </div>
        </div>
        <div className="ix-field">
          <label htmlFor="p-collection">Traders pay INR into</label>
          <select id="p-collection" className="ix-input" value={collection} onChange={(e) => setCollection(e.target.value)} disabled={!canConfigure}>
            <option value="">Not set</option>
            {accounts.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.bankName} ••••{a.last4} · {a.label}
              </option>
            ))}
          </select>
        </div>
        <label className="ix-row">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} disabled={!canConfigure} />
          <span>Route new USDT-fixed requests to a trader automatically</span>
        </label>
        {canConfigure ? (
          <>
            <div className="ix-field">
              <label htmlFor="p-reason">Reason for the change</label>
              <input id="p-reason" className="ix-input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button intent="primary" type="submit" disabled={cmd.busy || reason.trim().length < 3}>
              Save programme
            </Button>
          </>
        ) : (
          <p className="ix-muted">Changing the programme needs traders:configure.</p>
        )}
      </form>
      {cmd.error ? (
        <p className="ix-error" role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </section>
  );
}
