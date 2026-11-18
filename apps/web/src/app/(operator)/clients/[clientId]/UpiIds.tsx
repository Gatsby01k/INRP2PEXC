'use client';

import { useState } from 'react';
import type { UpiIdView } from '@inrp2p/clients';
import { Button, StepUpMark } from '@inrp2p/ui';
import { UpiMark } from '../../../../components/PayMarks.tsx';
import { useCommand } from '../../../../components/useCommand.tsx';
import { archiveClientUpiIdAction, reviewUpiIdAction } from '../../../../server/actions/desk.ts';
import { TextArea, TextField } from '../../_desk/fields.tsx';
import { inr } from '../../_desk/format.ts';
import { Chip, Notice } from '../../_desk/ui.tsx';
import { bookStyles as b } from '../../_book/parts.tsx';
import d from '../../_desk/desk.module.css';

/** The desk's one way of writing rupees, so a UPI limit reads like every other INR figure on the page. */
const rupees = (amount: string) => inr(amount);

/**
 * A client's UPI IDs for the desk (ADR 0029/0030). One is live when the client adds it; a payer whose app showed another
 * name pauses it, and it waits here: a person opens a UPI app, starts a payment to the address without paying, and types
 * the name the app shows. The command judges that name against the client's own names on its record — a match puts it
 * back with its full limits, a partial match needs a reason, anyone else's is refused — and a rejection's note is what the
 * client reads. Archiving one is for a compromised address: deals then go by bank transfer.
 */
export function UpiIds({ upiIds, canReview }: { upiIds: readonly UpiIdView[]; canReview: boolean }) {
  const cmd = useCommand();
  const [open, setOpen] = useState<{ id: string; mode: 'VERIFY' | 'REJECT' | 'ARCHIVE' } | null>(null);
  const [resolved, setResolved] = useState('');
  const [note, setNote] = useState('');
  const shown = upiIds.filter((u) => u.status !== 'ARCHIVED');
  if (shown.length === 0) return <p className={b.quiet}>None registered — deals with this client go by bank transfer.</p>;
  const start = (id: string, mode: 'VERIFY' | 'REJECT' | 'ARCHIVE') => {
    setOpen({ id, mode });
    setResolved('');
    setNote('');
    cmd.clearError();
  };

  return (
    <>
      <ul className={b.rows}>
        {shown.map((u) => {
          const paused = u.status === 'PENDING_REVIEW';
          const editing = open?.id === u.id ? open : null;
          return (
            <li key={u.id} className={b.row} {...(paused ? { 'data-attention': '' } : {})}>
              <span className={b.upiTile}>
                <UpiMark />
              </span>
              <span className={b.rowMain}>
                <span className={b.rowTitle}>
                  <span className={b.addr} style={{ color: 'var(--text-primary)' }}>
                    {u.vpa}
                  </span>
                  {u.status === 'ACTIVE' ? (
                    u.nameConfirmed ? (
                      <Chip tone="success" glyph="done">confirmed</Chip>
                    ) : (
                      <Chip tone="brand" glyph="partial">first deals</Chip>
                    )
                  ) : paused ? (
                    <Chip tone="warning" glyph="partial">paused</Chip>
                  ) : (
                    <Chip>not verified</Chip>
                  )}
                </span>
                <span className={b.rowSub} data-wrap="">
                  {paused
                    ? u.reportedName
                      ? `app showed ${u.reportedName}, expected ${u.holderName}`
                      : `expected ${u.holderName}`
                    : `${u.nameConfirmed ? (u.verifiedName ?? u.holderName) : u.holderName} · ${rupees(u.perPaymentLimit)}/payment${u.dailyLimit ? ` · ${rupees(u.usedToday)} of ${rupees(u.dailyLimit)} today` : ''}`}
                </span>
              </span>
              <span className={b.rowEnd}>
                {canReview && !editing && u.status === 'ACTIVE' ? (
                  <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => start(u.id, 'ARCHIVE')}>
                    Archive
                  </Button>
                ) : null}
              </span>
              {canReview && !editing && paused ? (
                <div className={b.rowMore} style={{ flexDirection: 'row', gap: 'var(--space-2)', paddingTop: 0 }}>
                  <Button intent="secondary" size="sm" disabled={cmd.busy} onClick={() => start(u.id, 'VERIFY')}>
                    Put back
                  </Button>
                  <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => start(u.id, 'REJECT')}>
                    Reject
                  </Button>
                </div>
              ) : null}
              {editing ? (
                <div className={b.rowMore}>
                  {editing.mode === 'VERIFY' ? (
                    <>
                      <Notice tone="brand">
                        In a UPI app, start a payment to <span className={d.mono}>{u.vpa}</span> — do not pay — and type the name the app shows. It must be the client’s own name on
                        its record.
                      </Notice>
                      <TextField label="Name the UPI app shows" value={resolved} onChange={setResolved} maxLength={140} autoFocus />
                      <TextArea label="Note (needed when the name only partly matches)" value={note} onChange={setNote} hint="Why it is the same person or company, for the record." />
                    </>
                  ) : (
                    <TextArea
                      label={editing.mode === 'REJECT' ? 'Why it is not verified — the client reads this' : 'Why it is archived'}
                      value={note}
                      onChange={setNote}
                      hint={editing.mode === 'REJECT' ? 'For example: the UPI ID shows another person’s name.' : 'A deal paid to it then offers a bank transfer instead.'}
                    />
                  )}
                  <div className={d.actions}>
                    <Button
                      intent={editing.mode === 'VERIFY' ? 'primary' : 'danger'}
                      size="sm"
                      shortcut={<StepUpMark label="needs your authenticator code" />}
                      disabled={cmd.busy || (editing.mode === 'VERIFY' ? resolved.trim().length < 2 : note.trim().length < 3)}
                      onClick={async () => {
                        const out = await cmd.run(`${editing.mode === 'VERIFY' ? 'Put back' : editing.mode === 'REJECT' ? 'Reject' : 'Archive'} UPI ID ${u.vpa}`, (key) =>
                          editing.mode === 'ARCHIVE'
                            ? archiveClientUpiIdAction({ upiId: u.id, reason: note.trim() }, key)
                            : reviewUpiIdAction({ upiId: u.id, decision: editing.mode, resolvedName: editing.mode === 'VERIFY' ? resolved.trim() : null, note: note.trim() || null }, key),
                        );
                        if (out.ok) setOpen(null);
                      }}
                    >
                      {editing.mode === 'VERIFY' ? 'Put back' : editing.mode === 'REJECT' ? 'Reject' : 'Archive'}
                    </Button>
                    <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => setOpen(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {cmd.error ? (
        <Notice tone="danger" role="alert">
          {cmd.error}
        </Notice>
      ) : null}
      {cmd.dialog}
    </>
  );
}
