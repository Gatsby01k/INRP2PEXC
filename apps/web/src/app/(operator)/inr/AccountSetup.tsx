'use client';

import { useState } from 'react';
import type { InrAccountView, InrView } from '@inrp2p/desk';
import { normalizeVpa } from '@inrp2p/kernel';
import { Button, StepUpMark } from '@inrp2p/ui';
import { createInrAccountAction, createSettlementEntityAction, setCollectionDetailsAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { AmountField, Checkbox, SelectField, TextField } from '../_desk/fields.tsx';
import { Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import s from './inr.module.css';

type Rail = 'IMPS' | 'NEFT' | 'RTGS' | 'UPI';
const RAILS: readonly Rail[] = ['IMPS', 'NEFT', 'RTGS', 'UPI'];
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const step = <StepUpMark label="needs your authenticator code" />;

/**
 * Opening one of the exchange's own INR accounts (ADR 0018): the legal entity that owns it the first time, then the
 * account — its number sealed the moment it arrives — and, for an account that collects, what a paying client sees:
 * the payee name and its UPI ID. Until an account collects, BUY clients have nowhere to pay.
 */
export function AccountSetup({ entities }: { entities: InrView['entities'] }) {
  const cmd = useCommand();
  const [entityId, setEntityId] = useState(entities[0]?.entityId ?? '');
  const [legalName, setLegalName] = useState('');
  const [shortName, setShortName] = useState('');
  const [label, setLabel] = useState('');
  const [bankName, setBankName] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [number, setNumber] = useState('');
  const [direction, setDirection] = useState<'COLLECTION' | 'PAYOUT' | 'BOTH'>('COLLECTION');
  const [rails, setRails] = useState<readonly Rail[]>(['IMPS', 'NEFT', 'UPI']);
  const [capacity, setCapacity] = useState('');
  const [upi, setUpi] = useState('');
  const [payee, setPayee] = useState('');

  if (entities.length === 0) {
    return (
      <div className={d.guard}>
        <p className={d.guardTitle}>First, the company that owns the accounts</p>
        <p className={d.guardBody}>Its legal name is what clients see as the payee unless an account says otherwise.</p>
        <div className={d.formGrid}>
          <TextField label="Legal name" value={legalName} onChange={setLegalName} placeholder="INRP2P Exchange Private Limited" maxLength={200} />
          <TextField label="Short name" value={shortName} onChange={setShortName} placeholder="INRP2P" maxLength={60} />
        </div>
        <div className={d.actions}>
          <Button
            intent="primary"
            size="sm"
            shortcut={step}
            disabled={cmd.busy || legalName.trim().length < 2 || shortName.trim().length < 2}
            onClick={() => void cmd.run('Add the settlement entity', (k) => createSettlementEntityAction({ legalName: legalName.trim(), shortName: shortName.trim() }, k))}
          >
            Add the entity
          </Button>
        </div>
        {cmd.error ? <p className={d.errorLine} role="alert">{cmd.error}</p> : null}
        {cmd.dialog}
      </div>
    );
  }

  const collects = direction !== 'PAYOUT';
  const ifscOk = IFSC.test(ifsc.trim().toUpperCase());
  const digits = number.replace(/\s+/g, '');
  const numberOk = /^\d{9,18}$/.test(digits);
  const upiOk = upi.trim() === '' || normalizeVpa(upi) !== null;
  const ready = !cmd.busy && entityId !== '' && label.trim().length >= 2 && bankName.trim().length >= 2 && ifscOk && numberOk && rails.length > 0 && capacity.trim() !== '' && upiOk;

  return (
    <div className={d.stack}>
      <p className={d.fieldHint}>The account number is encrypted the moment it is saved; the desk shows its last four digits only. Clients paying a BUY see the full details of a collecting account on their trade.</p>
      <div className={d.formGrid}>
        {entities.length > 1 ? (
          <SelectField label="Owner" value={entityId} onChange={setEntityId} options={entities.map((e) => ({ value: e.entityId, label: e.legalName }))} />
        ) : (
          <TextField label="Owner" value={entities[0]!.legalName} onChange={() => {}} disabled />
        )}
        <TextField label="Label" value={label} onChange={setLabel} placeholder="HDFC collections" maxLength={80} />
        <TextField label="Bank" value={bankName} onChange={setBankName} placeholder="HDFC Bank" maxLength={140} />
        <TextField label="IFSC" value={ifsc} onChange={(v) => setIfsc(v.toUpperCase())} placeholder="HDFC0001234" mono maxLength={11} {...(ifsc !== '' && !ifscOk ? { error: 'Four letters, 0, six letters or digits' } : {})} />
        <TextField label="Account number" value={number} onChange={setNumber} mono maxLength={22} {...(number !== '' && !numberOk ? { error: '9 to 18 digits' } : {})} />
        <SelectField
          label="Use"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'COLLECTION', label: 'Collects — clients and traders pay in' },
            { value: 'PAYOUT', label: 'Pays out' },
            { value: 'BOTH', label: 'Both' },
          ]}
        />
        <AmountField label="Daily capacity" currency="INR" value={capacity} onChange={setCapacity} hint="What the desk may pay out of it in a day" />
      </div>
      <div className={s.rails} role="group" aria-label="Rails">
        {RAILS.map((r) => (
          <Checkbox key={r} label={r} checked={rails.includes(r)} onChange={(on) => setRails((now) => (on ? [...now, r] : now.filter((x) => x !== r)))} />
        ))}
      </div>
      {collects ? (
        <div className={d.formGrid}>
          <TextField label="UPI ID (optional)" value={upi} onChange={setUpi} placeholder="inrp2p@hdfcbank" mono maxLength={120} {...(!upiOk ? { error: 'A UPI ID looks like name@bank' } : {})} hint="Shown to clients as a code their UPI app fills in" />
          <TextField label="Payee name clients see (optional)" value={payee} onChange={setPayee} placeholder="defaults to the owner's legal name" maxLength={140} />
        </div>
      ) : null}
      <div className={d.actions}>
        <Button
          intent="primary"
          size="sm"
          shortcut={step}
          disabled={!ready}
          onClick={() =>
            void cmd
              .run(`Add ${label.trim()}`, (k) =>
                createInrAccountAction(
                  {
                    entityId, label: label.trim(), bankName: bankName.trim(), ifsc: ifsc.trim().toUpperCase(), accountNumber: digits, rails, direction,
                    defaultDailyCapacity: capacity, upiVpa: collects && upi.trim() ? upi.trim() : null, beneficiaryName: collects && payee.trim() ? payee.trim() : null,
                  },
                  k,
                ),
              )
              .then((out) => {
                if (out.ok) {
                  setLabel('');
                  setNumber('');
                  setUpi('');
                  setPayee('');
                }
              })
          }
        >
          Add account
        </Button>
      </div>
      {cmd.error ? <p className={d.errorLine} role="alert">{cmd.error}</p> : null}
      {cmd.dialog}
    </div>
  );
}

/** What a paying client sees for this account: the payee and the UPI ID — edited here, shown on every new trade. */
export function CollectionDetails({ a, canManage }: { a: InrAccountView; canManage: boolean }) {
  const cmd = useCommand();
  const [open, setOpen] = useState(false);
  const [upi, setUpi] = useState(a.upiVpa ?? '');
  const [payee, setPayee] = useState(a.beneficiaryName ?? '');
  const upiOk = upi.trim() === '' || normalizeVpa(upi) !== null;
  if (a.direction === 'PAYOUT') return null;
  return (
    <div className={s.collectRow}>
      <span className={d.meta}>
        Clients pay <strong>{a.beneficiaryName ?? a.entityName}</strong>
        {a.upiVpa ? (
          <>
            {' '}
            · UPI <span className={d.mono}>{a.upiVpa}</span>
          </>
        ) : (
          ' · no UPI ID — bank transfer only'
        )}
      </span>
      {canManage ? (
        <Button size="sm" intent="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Close' : 'Edit'}
        </Button>
      ) : null}
      {open ? (
        <div className={s.editor}>
          <div className={d.formGrid}>
            <TextField label="UPI ID" value={upi} onChange={setUpi} placeholder="inrp2p@hdfcbank" mono maxLength={120} {...(!upiOk ? { error: 'A UPI ID looks like name@bank' } : {})} />
            <TextField label="Payee name" value={payee} onChange={setPayee} placeholder={a.entityName} maxLength={140} />
          </div>
          {!a.upiVpa && upi.trim() !== '' ? <Notice tone="brand">Clients of new BUY trades get a UPI code that fills in the amount and the trade’s reference.</Notice> : null}
          <div className={d.actions}>
            <Button
              intent="primary"
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !upiOk}
              onClick={() =>
                void cmd
                  .run(`Update what clients see for ${a.label}`, (k) => setCollectionDetailsAction({ accountId: a.accountId, upiVpa: upi.trim() || null, beneficiaryName: payee.trim() || null }, k))
                  .then((out) => {
                    if (out.ok) setOpen(false);
                  })
              }
            >
              Save
            </Button>
          </div>
          {cmd.error ? <p className={d.errorLine} role="alert">{cmd.error}</p> : null}
        </div>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
