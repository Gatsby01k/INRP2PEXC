'use client';

import { useState } from 'react';
import type { DeskTraderDetail } from '@inrp2p/traders';
import { Button, CopyButton, StepUpMark } from '@inrp2p/ui';
import { BankMark, UsdtOnTron } from '../../../../components/PayMarks.tsx';
import { useCommand } from '../../../../components/useCommand.tsx';
import { pauseTraderAction, resumeTraderAction, setAssignmentsAction, setLimitsAction, setRequiredReserveAction, setSettlementDetailsAction } from '../../../../server/actions/traders-desk.ts';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { SelectField, TextArea, TextField } from '../../_desk/fields.tsx';
import { inr, plainDecimal, usdt } from '../../_desk/format.ts';
import { Chip } from '../../_desk/ui.tsx';
import { Facts, Sheet, bookStyles as b, shortAddress } from '../../_book/parts.tsx';
import type { TraderPerms } from '../words.tsx';
import d from '../../_desk/desk.module.css';

const blank = (v: string) => (v.trim() === '' ? null : v.trim());
const step = <StepUpMark label="needs your authenticator code" />;

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p className={d.errorLine} role="alert">
      {error}
    </p>
  ) : null;
}

/**
 * Who may be offered orders: pausing the trader, or stopping only new assignments. Each is one audited command with its
 * own reason, asked for in the confirmation itself — the trader sees a pause's reason. Orders already taken still settle.
 */
export function Controls({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const t = detail.trader;
  return (
    <Sheet title="Controls" hint="Who may be offered orders, and why." label="Controls">
      <Facts
        items={[
          { label: 'Trader', value: t.status === 'PAUSED' ? <Chip tone="warning" icon="pause">paused by the desk</Chip> : t.available ? <Chip tone="success" glyph="done">online</Chip> : <Chip glyph="pending">offline</Chip> },
          { label: 'New orders', value: t.status === 'APPROVED' && t.assignmentsEnabled ? 'may be offered' : 'not offered' },
          ...(t.controlNote ? [{ label: 'Why', value: t.controlNote }] : []),
          ...(t.reviewNote ? [{ label: 'Review note', value: t.reviewNote }] : []),
        ]}
      />
      {perms.pause ? (
        <div className={d.actions}>
          {t.status === 'APPROVED' ? (
            <GuardedAction
              label="Pause trader"
              tone="danger"
              stepUp
              busy={cmd.busy}
              reasonLabel="Reason — the trader sees it"
              consequence="No new order is offered to this trader. Orders already accepted or in progress still settle."
              onConfirm={async (reason) => (await cmd.run(`Pause ${t.ref}`, (key) => pauseTraderAction({ traderId: t.traderId, reason }, key))).ok}
            />
          ) : (
            <GuardedAction
              label="Resume trader"
              stepUp
              busy={cmd.busy}
              reasonLabel="Reason"
              consequence="The trader can be offered orders again, as soon as it is online."
              onConfirm={async (reason) => (await cmd.run(`Resume ${t.ref}`, (key) => resumeTraderAction({ traderId: t.traderId, reason }, key))).ok}
            />
          )}
          <GuardedAction
            label={t.assignmentsEnabled ? 'Stop new orders' : 'Allow new orders'}
            trigger="ghost"
            stepUp
            busy={cmd.busy}
            reasonLabel="Reason"
            consequence={t.assignmentsEnabled ? 'The trader stays online but is offered no new order. Open orders still settle.' : 'The trader may be offered new orders again.'}
            onConfirm={async (reason) =>
              (await cmd.run(`${t.assignmentsEnabled ? 'Stop' : 'Allow'} new assignments for ${t.ref}`, (key) => setAssignmentsAction({ traderId: t.traderId, enabled: !t.assignmentsEnabled, reason }, key))).ok
            }
          />
        </div>
      ) : null}
      <ErrorLine error={cmd.error} />
      {cmd.dialog}
    </Sheet>
  );
}

/**
 * INRP2P's terms for this trader: ceilings on top of what the trader sets (the trader is told), and the Security Reserve it
 * must hold. Read first; changed in place, with one reason kept with whichever is saved.
 */
export function Terms({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const t = detail.trader;
  const [editing, setEditing] = useState(false);
  const [reserve, setReserve] = useState(plainDecimal(detail.reserve.required ?? detail.program.defaultRequiredReserve));
  const [maxOrderInr, setMaxOrderInr] = useState(plainDecimal(t.limits.maxOrderInr));
  const [maxOrderUsdt, setMaxOrderUsdt] = useState(plainDecimal(t.limits.maxOrderUsdt));
  const [maxCapInr, setMaxCapInr] = useState(plainDecimal(t.limits.maxCapacityInr));
  const [maxCapUsdt, setMaxCapUsdt] = useState(plainDecimal(t.limits.maxCapacityUsdt));
  const [reason, setReason] = useState('');
  const hasReason = reason.trim().length >= 3;
  // Both ceilings unset is the ordinary case: said once. One set: the other reads as a dash beside it.
  const ceilings = (inrValue: string | null, usdtValue: string | null) =>
    inrValue || usdtValue ? `${inrValue ? inr(inrValue) : '—'} · ${usdtValue ? usdt(usdtValue) : '—'}` : <span className={d.muted}>no ceiling</span>;

  return (
    <Sheet
      title="Terms"
      hint="INRP2P’s ceilings on top of the trader’s own; the trader is told."
      label="Terms"
      actions={
        perms.configure && !editing ? (
          <Button intent="ghost" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        ) : null
      }
    >
      {!editing ? (
        <Facts
          items={[
            { label: 'Required reserve', value: detail.reserve.required ? usdt(detail.reserve.required) : <span className={d.muted}>not set</span> },
            { label: 'Max order', value: ceilings(t.limits.maxOrderInr, t.limits.maxOrderUsdt) },
            { label: 'Max capacity', value: ceilings(t.limits.maxCapacityInr, t.limits.maxCapacityUsdt) },
          ]}
        />
      ) : (
        <>
          <div className={b.grid2}>
            <TextField label="Max order ₹" value={maxOrderInr} onChange={setMaxOrderInr} placeholder="No ceiling" />
            <TextField label="Max order USDT" value={maxOrderUsdt} onChange={setMaxOrderUsdt} placeholder="No ceiling" />
            <TextField label="Max capacity ₹" value={maxCapInr} onChange={setMaxCapInr} placeholder="No ceiling" />
            <TextField label="Max capacity USDT" value={maxCapUsdt} onChange={setMaxCapUsdt} placeholder="No ceiling" />
          </div>
          <TextField label="Required Security Reserve (USDT)" value={reserve} onChange={setReserve} />
          <TextArea label="Reason for the change" value={reason} onChange={setReason} hint="Kept with whichever you save." />
          <div className={d.actions}>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !hasReason}
              onClick={async () => {
                const out = await cmd.run(`Change limits for ${t.ref}`, (key) =>
                  setLimitsAction({ traderId: t.traderId, maxOrderInr: blank(maxOrderInr), maxOrderUsdt: blank(maxOrderUsdt), maxCapacityInr: blank(maxCapInr), maxCapacityUsdt: blank(maxCapUsdt), reason }, key),
                );
                if (out.ok) setEditing(false);
              }}
            >
              Save limits
            </Button>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || !hasReason || blank(reserve) === null}
              onClick={async () => {
                const out = await cmd.run(`Change reserve for ${t.ref}`, (key) => setRequiredReserveAction({ traderId: t.traderId, requiredReserve: reserve.trim(), reason }, key));
                if (out.ok) setEditing(false);
              }}
            >
              Save reserve
            </Button>
            <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
      <ErrorLine error={cmd.error} />
      {cmd.dialog}
    </Sheet>
  );
}

/**
 * Where INRP2P pays the trader and takes its USDT from: its registered bank account and wallet, as their marks. Switching
 * to another verified one on its file is the desk's command, never while an order is open.
 */
export function Settles({ detail, perms }: { detail: DeskTraderDetail; perms: TraderPerms }) {
  const cmd = useCommand();
  const t = detail.trader;
  const [editing, setEditing] = useState(false);
  const [bankId, setBankId] = useState(detail.bank.bankAccountId);
  const [walletId, setWalletId] = useState(detail.wallet.walletId);
  const [reason, setReason] = useState('');
  const bank = detail.bank;
  const wallet = detail.wallet;
  const canChange = perms.configure && (detail.clientDestinations.banks.length > 1 || detail.clientDestinations.wallets.length > 1);
  return (
    <Sheet
      title="Settles with"
      hint="Where INRP2P pays the trader and takes its USDT from."
      label="Settles with"
      actions={
        canChange && !editing ? (
          <Button intent="ghost" size="sm" onClick={() => setEditing(true)}>
            Change
          </Button>
        ) : null
      }
    >
      <ul className={b.rows}>
        <li className={b.row}>
          <BankMark ifsc={bank.ifsc} name={bank.bankName} size={32} />
          <span className={b.rowMain}>
            <span className={b.rowTitle}>
              <span>{bank.bankName}</span>
              <span className={b.addr}>••••{bank.last4}</span>
            </span>
            <span className={b.rowSub}>{bank.holderName}</span>
          </span>
          <span className={b.rowEnd}>{bank.status === 'ACTIVE' ? <Chip tone="success" glyph="done">verified</Chip> : <Chip tone="warning">{bank.status.toLowerCase().replace('_', ' ')}</Chip>}</span>
        </li>
        <li className={b.row}>
          <UsdtOnTron size={32} />
          <span className={b.rowMain}>
            <span className={b.rowTitle}>
              <span>{wallet.label}</span>
            </span>
            <span className={`${b.rowSub} ${b.addr}`} title={wallet.address}>
              {shortAddress(wallet.address)}
            </span>
          </span>
          <span className={b.rowEnd}>
            <CopyButton value={wallet.address} label="wallet address" />
            {wallet.status === 'ACTIVE' ? null : <Chip tone="warning">{wallet.status.toLowerCase().replace('_', ' ')}</Chip>}
          </span>
        </li>
      </ul>
      {editing ? (
        <>
          <SelectField label="Bank account" value={bankId} onChange={setBankId} options={detail.clientDestinations.banks.map((x) => ({ value: x.id, label: x.label }))} />
          <SelectField label="Wallet (send and receive)" value={walletId} onChange={setWalletId} options={detail.clientDestinations.wallets.map((x) => ({ value: x.id, label: x.label }))} />
          <TextArea label="Reason for the change" value={reason} onChange={setReason} />
          <div className={d.actions}>
            <Button
              size="sm"
              shortcut={step}
              disabled={cmd.busy || reason.trim().length < 3 || t.openOrders > 0 || (bankId === bank.bankAccountId && walletId === wallet.walletId)}
              onClick={async () => {
                const out = await cmd.run(`Change settlement details for ${t.ref}`, (key) => setSettlementDetailsAction({ traderId: t.traderId, bankAccountId: bankId, walletId, reason }, key));
                if (out.ok) setEditing(false);
              }}
            >
              Change settlement details
            </Button>
            <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          {t.openOrders > 0 ? <p className={d.fieldHint}>Not while an order is accepted or in progress.</p> : null}
        </>
      ) : null}
      <ErrorLine error={cmd.error} />
      {cmd.dialog}
    </Sheet>
  );
}
