'use client';

import { useState } from 'react';
import type { ClientDestination } from '@inrp2p/desk';
import { Button, StepUpMark } from '@inrp2p/ui';
import { BankMark } from '../../../../components/PayMarks.tsx';
import { useCommand } from '../../../../components/useCommand.tsx';
import { archiveClientBankAccountAction } from '../../../../server/actions/desk.ts';
import { TextArea } from '../../_desk/fields.tsx';
import { Icon } from '../../_desk/icons.tsx';
import { Notice } from '../../_desk/ui.tsx';
import { bankParts, bookStyles as b } from '../../_book/parts.tsx';
import d from '../../_desk/desk.module.css';

/**
 * A client's active bank accounts, each as its bank's tile, and — for whoever holds `client_bank:add` (OWNER, SUPPORT) —
 * archiving one, with a reason and the authenticator. An archived account is never paid and never revealed again; the
 * list shows active accounts only, so it leaves the list.
 */
export function BankAccounts({ accounts, canArchive }: { accounts: readonly ClientDestination[]; canArchive: boolean }) {
  const cmd = useCommand();
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 10;

  if (accounts.length === 0)
    return (
      <p className={b.gap}>
        <Icon name="flag" size={12} />
        None on file — a SELL request cannot be opened.
      </p>
    );
  return (
    <>
      <ul className={b.rows}>
        {accounts.map((a) => {
          const p = bankParts(a.detail);
          const open = choosing === a.id;
          return (
            <li key={a.id} className={b.row}>
              <BankMark ifsc={p.ifsc} name={p.bank} size={32} />
              <span className={b.rowMain}>
                <span className={b.rowTitle}>
                  <span>{p.bank}</span>
                  <span className={b.addr}>••••{p.last4}</span>
                </span>
                <span className={b.rowSub}>
                  {a.label} · {p.ifsc}
                </span>
              </span>
              <span className={b.rowEnd}>
                {canArchive && !open ? (
                  <Button
                    intent="ghost"
                    size="sm"
                    disabled={cmd.busy}
                    onClick={() => {
                      setChoosing(a.id);
                      setReason('');
                      cmd.clearError();
                    }}
                  >
                    Archive
                  </Button>
                ) : null}
              </span>
              {open ? (
                <div className={b.rowMore}>
                  <TextArea label={`Why ••••${p.last4} is archived`} value={reason} onChange={setReason} hint="Recorded in the audit trail and told to the client. Nothing is paid to an archived account." />
                  <div className={d.actions}>
                    <Button
                      intent="primary"
                      size="sm"
                      shortcut={<StepUpMark label="needs your authenticator code" />}
                      disabled={cmd.busy || !ready}
                      onClick={async () => {
                        const out = await cmd.run(`Archive bank account ••••${p.last4}`, (key) => archiveClientBankAccountAction({ bankAccountId: a.id, reason: reason.trim() }, key));
                        if (out.ok) setChoosing(null);
                      }}
                    >
                      Archive this account
                    </Button>
                    <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => setChoosing(null)}>
                      Keep it
                    </Button>
                    {!ready ? <span className={d.fieldHint}>A reason of at least ten characters.</span> : null}
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
