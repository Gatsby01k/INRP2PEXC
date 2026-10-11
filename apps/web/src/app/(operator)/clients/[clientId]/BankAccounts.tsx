'use client';

import { useState } from 'react';
import type { ClientDestination } from '@inrp2p/desk';
import { Button, StepUpMark } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import { archiveClientBankAccountAction } from '../../../../server/actions/desk.ts';
import { TextArea } from '../../_desk/fields.tsx';
import { KeyValues, Notice } from '../../_desk/ui.tsx';
import d from '../../_desk/desk.module.css';

/**
 * A client's active bank accounts, and — for whoever holds `client_bank:add` (OWNER, SUPPORT) — archiving one, with a
 * reason and the authenticator. An archived account is never paid and never revealed again; the list shows active
 * accounts only, so it leaves the list.
 */
export function BankAccounts({ accounts, canArchive }: { accounts: readonly ClientDestination[]; canArchive: boolean }) {
  const cmd = useCommand();
  const [choosing, setChoosing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 10;

  if (accounts.length === 0) return <Notice tone="warning">None on file — a SELL request cannot be opened.</Notice>;
  const chosen = accounts.find((a) => a.id === choosing) ?? null;
  return (
    <>
      <KeyValues
        items={accounts.map((b) => ({
          key: b.id,
          label: b.label,
          value: (
            <span className={d.row}>
              <span className={d.secondary}>{b.detail.replace(/ ••••/, ' · ••••')}</span>
              {canArchive && choosing !== b.id ? (
                <Button intent="ghost" size="sm" disabled={cmd.busy} onClick={() => { setChoosing(b.id); setReason(''); cmd.clearError(); }}>
                  Archive
                </Button>
              ) : null}
            </span>
          ),
        }))}
      />
      {chosen ? (
        <div className={d.stack}>
          <TextArea
            label={`Why ${chosen.detail.replace(/^.* ••••/, '••••')} is archived`}
            value={reason}
            onChange={setReason}
            hint="Recorded in the audit trail and told to the client. Nothing is paid to an archived account."
          />
          <div className={d.actions}>
            <Button
              intent="primary"
              size="sm"
              shortcut={<StepUpMark label="needs your authenticator code" />}
              disabled={cmd.busy || !ready}
              onClick={async () => {
                const out = await cmd.run(`Archive bank account ${chosen.detail.replace(/^.* ••••/, '••••')}`, (key) =>
                  archiveClientBankAccountAction({ bankAccountId: chosen.id, reason: reason.trim() }, key),
                );
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
      {cmd.error ? <Notice tone="danger" role="alert">{cmd.error}</Notice> : null}
      {cmd.dialog}
    </>
  );
}
