'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { InrAccountView } from '@inrp2p/desk';
import { Button, StepUpMark } from '@inrp2p/ui';
import { setDayCapacityAction } from '../../../server/actions/desk.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { AmountField, TextArea } from '../_desk/fields.tsx';
import { inr, inrCompact, parseAmount, share } from '../_desk/format.ts';
import { Chip, Legend, Meter, Notice } from '../_desk/ui.tsx';
import d from '../_desk/desk.module.css';
import s from './inr.module.css';

/**
 * INR settlement accounts and what today's capacity has left in each (FI-30). One row per account: the bar is
 * used · reserved · free against today's capacity, and the figure that matters — available — is the one in bold.
 * Changing today's capacity is step-up protected and always carries a reason, because a payout refused this
 * morning and allowed this afternoon has to be explainable.
 */
export function InrAccounts({ accounts, canChange }: { accounts: readonly InrAccountView[]; canChange: boolean }) {
  return (
    <div className={s.accounts}>
      <div className={s.accountsHead} aria-hidden="true">
        <span>Account</span>
        <span>Today</span>
        <span className={s.right}>Capacity</span>
        <span className={s.right}>Used</span>
        <span className={s.right}>Reserved</span>
        <span className={s.right}>Available</span>
        <span />
      </div>
      {accounts.map((a) => (
        <Account key={a.accountId} a={a} canChange={canChange} />
      ))}
      <div className={s.legendRow}>
        <Legend
          items={[
            { tone: 'ink', label: 'used — payouts sent today' },
            { tone: 'brand', label: 'reserved — legs created, not yet sent' },
            { tone: 'empty', label: 'available' },
          ]}
        />
      </div>
    </div>
  );
}

function Account({ a, canChange }: { a: InrAccountView; canChange: boolean }) {
  const cmd = useCommand();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const typed = parseAmount(value, 'INR');
  const committed = Money.parse(a.usedToday, 'INR').add(Money.parse(a.reservedToday, 'INR'));
  const overCommit = typed !== null && typed.minor < committed.minor;
  const low = a.status === 'ACTIVE' && Money.parse(a.availableToday, 'INR').minor < Money.parse(a.capacityToday, 'INR').minor / 10n;
  const active = a.status === 'ACTIVE';

  return (
    <div className={s.account} data-testid={`account-${a.accountId}`} {...(active ? {} : { 'data-inactive': '' })}>
      <div className={s.accountRow}>
        <div className={d.stackTight} style={{ gap: 2 }}>
          <span className={s.accountName}>
            {a.bankName} · {a.label}
          </span>
          <span className={d.meta}>
            {a.entityName} · {a.ifsc} ••••{a.last4} · {a.rails.join(' · ')}
          </span>
        </div>
        <div className={d.stackTight} style={{ gap: 4 }}>
          <span className={d.row}>
            <Chip tone={active ? 'success' : a.status === 'PAUSED' ? 'warning' : 'muted'} glyph={active ? 'done' : 'closed'}>
              {a.status.toLowerCase()}
            </Chip>
            <Chip>{a.direction === 'BOTH' ? 'pays & collects' : a.direction === 'PAYOUT' ? 'pays out' : 'collects'}</Chip>
          </span>
          <Meter
            label={`${inr(a.usedToday)} used and ${inr(a.reservedToday)} reserved of ${inr(a.capacityToday)}`}
            parts={[
              { value: share(a.usedToday, a.capacityToday, 'INR'), tone: 'ink' },
              { value: share(a.reservedToday, a.capacityToday, 'INR'), tone: 'brand' },
            ]}
          />
        </div>
        <span className={s.figure}>
          {inrCompact(a.capacityToday)}
          <span className={s.figureSub}>{a.dayOpened ? 'set for today' : 'default'}</span>
        </span>
        <span className={s.figure}>{inrCompact(a.usedToday)}</span>
        <span className={s.figure}>{inrCompact(a.reservedToday)}</span>
        <span className={s.figure} data-strong="" {...(low ? { 'data-low': '' } : {})}>
          {inr(a.availableToday)}
          {low ? <span className={s.figureSub}>under 10% left</span> : null}
        </span>
        <span className={s.right}>
          {canChange ? (
            <Button size="sm" intent={open ? 'ghost' : 'secondary'} onClick={() => setOpen((v) => !v)} shortcut={<StepUpMark label="needs your authenticator code" />}>
              {open ? 'Close' : 'Set capacity'}
            </Button>
          ) : null}
        </span>
      </div>
      {open ? (
        <div className={s.editor}>
          <div className={d.formGrid}>
            <AmountField label="Capacity today" currency="INR" value={value} onChange={setValue} hint={`Now ${inr(a.capacityToday)} · default ${inr(a.defaultDailyCapacity)}`} />
            <TextArea label="Reason (kept with the change)" value={reason} onChange={setReason} placeholder="e.g. bank raised the IMPS limit for today" />
          </div>
          {overCommit ? (
            <Notice tone="warning" icon="exceptions">
              Below what is already used and reserved today ({inr(committed.toDecimalString())}): the account shows as over-committed and takes no new legs until the day turns.
            </Notice>
          ) : null}
          <div className={d.actions}>
            <Button
              intent="primary"
              size="sm"
              disabled={cmd.busy || typed === null || reason.trim().length < 3}
              shortcut={<StepUpMark label="needs your authenticator code" />}
              onClick={() =>
                void cmd.run(`Set today's capacity on ${a.label} to ${inr(value)}`, (k) => setDayCapacityAction({ accountId: a.accountId, capacity: value, reason: reason.trim() }, k)).then((out) => {
                  if (out.ok) {
                    setValue('');
                    setReason('');
                    setOpen(false);
                  }
                  return out;
                })
              }
            >
              Set capacity
            </Button>
          </div>
          {cmd.error ? (
            <p className={d.errorLine} role="alert">
              {cmd.error}
            </p>
          ) : null}
        </div>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
