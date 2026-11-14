'use client';

import { useState } from 'react';
import type { UpiIdView } from '@inrp2p/clients';
import { Button, StepUpMark } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import { archiveClientUpiIdAction, reviewUpiIdAction } from '../../../../server/actions/desk.ts';
import { TextArea, TextField } from '../../_desk/fields.tsx';
import { Chip, KeyValues, Notice } from '../../_desk/ui.tsx';
import d from '../../_desk/desk.module.css';

const rupees = (amount: string) => `₹${Number.parseFloat(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * A client's UPI IDs for the desk (ADR 0029). One the client submitted waits here: a person opens a UPI app, starts a
 * payment to the address without paying, and types the name the app shows. The command judges that name against the
 * client's own names on its record — a match verifies it, a partial match needs a reason, anyone else's is refused — and
 * a rejection's note is what the client reads. Archiving one is for a compromised address: deals then go by bank transfer.
 */
export function UpiIds({ upiIds, canReview }: { upiIds: readonly UpiIdView[]; canReview: boolean }) {
  const cmd = useCommand();
  const [open, setOpen] = useState<{ id: string; mode: 'VERIFY' | 'REJECT' | 'ARCHIVE' } | null>(null);
  const [resolved, setResolved] = useState('');
  const [note, setNote] = useState('');
  const shown = upiIds.filter((u) => u.status !== 'ARCHIVED');
  if (shown.length === 0) return <Notice>None registered — deals with this client go by bank transfer.</Notice>;
  const chosen = open ? shown.find((u) => u.id === open.id) ?? null : null;
  const start = (id: string, mode: 'VERIFY' | 'REJECT' | 'ARCHIVE') => {
    setOpen({ id, mode });
    setResolved('');
    setNote('');
    cmd.clearError();
  };

  return (
    <>
      <KeyValues
        items={shown.map((u) => ({
          key: u.id,
          label: <span className={d.mono}>{u.vpa}</span>,
          value: (
            <span className={d.row}>
              {u.status === 'ACTIVE' ? (
                <Chip tone="success" glyph="done">verified · {u.verifiedName}</Chip>
              ) : u.status === 'PENDING_REVIEW' ? (
                <Chip tone="warning">to check · says {u.holderName}</Chip>
              ) : (
                <Chip tone="neutral">not verified</Chip>
              )}
              <span className={d.secondary}>
                {rupees(u.perPaymentLimit)}/payment{u.dailyLimit ? ` · ${rupees(u.dailyLimit)}/day · ${rupees(u.usedToday)} today` : ''}
              </span>
              {canReview && u.status === 'PENDING_REVIEW' && open?.id !== u.id ? (
                <>
                  <Button intent="secondary" size="sm" disabled={cmd.busy} onClick={() => start(u.id, 'VERIFY')}>Verify</Button>
                  <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => start(u.id, 'REJECT')}>Reject</Button>
                </>
              ) : null}
              {canReview && u.status === 'ACTIVE' && open?.id !== u.id ? (
                <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => start(u.id, 'ARCHIVE')}>Archive</Button>
              ) : null}
            </span>
          ),
        }))}
      />
      {chosen && open ? (
        <div className={d.stack}>
          {open.mode === 'VERIFY' ? (
            <>
              <Notice tone="brand">
                In a UPI app, start a payment to <span className={d.mono}>{chosen.vpa}</span> — do not pay — and type the name the app shows. It must be the client’s
                own name on its record.
              </Notice>
              <TextField label="Name the UPI app shows" value={resolved} onChange={setResolved} maxLength={140} autoFocus />
              <TextArea label="Note (needed when the name only partly matches)" value={note} onChange={setNote} hint="Why it is the same person or company, for the record." />
            </>
          ) : (
            <TextArea
              label={open.mode === 'REJECT' ? 'Why it is not verified — the client reads this' : 'Why it is archived'}
              value={note}
              onChange={setNote}
              hint={open.mode === 'REJECT' ? 'For example: the UPI ID shows another person’s name.' : 'A deal paid to it then offers a bank transfer instead.'}
            />
          )}
          <div className={d.actions}>
            <Button
              intent={open.mode === 'VERIFY' ? 'primary' : 'danger'}
              size="sm"
              shortcut={<StepUpMark label="needs your authenticator code" />}
              disabled={cmd.busy || (open.mode === 'VERIFY' ? resolved.trim().length < 2 : note.trim().length < 3)}
              onClick={async () => {
                const out = await cmd.run(`${open.mode === 'VERIFY' ? 'Verify' : open.mode === 'REJECT' ? 'Reject' : 'Archive'} UPI ID ${chosen.vpa}`, (key) =>
                  open.mode === 'ARCHIVE'
                    ? archiveClientUpiIdAction({ upiId: chosen.id, reason: note.trim() }, key)
                    : reviewUpiIdAction({ upiId: chosen.id, decision: open.mode, resolvedName: open.mode === 'VERIFY' ? resolved.trim() : null, note: note.trim() || null }, key),
                );
                if (out.ok) setOpen(null);
              }}
            >
              {open.mode === 'VERIFY' ? 'Verify' : open.mode === 'REJECT' ? 'Reject' : 'Archive'}
            </Button>
            <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => setOpen(null)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {cmd.error ? <Notice tone="danger" role="alert">{cmd.error}</Notice> : null}
      {cmd.dialog}
    </>
  );
}
