'use client';

import { useEffect, useState } from 'react';
import { OtpInput } from '@inrp2p/ui';
import { archiveBankAccountAction, archiveWalletAction } from '../../../server/actions/client.ts';
import { Sheet } from '../_workspace/Sheet.tsx';
import { useGuarded } from '../_workspace/useGuarded.ts';
import shell from '../shell.module.css';
import styles from './destinations.module.css';

export interface ArchiveTarget {
  readonly kind: 'bank' | 'wallet';
  readonly id: string;
  /** How the client knows it: "HDFC Bank •••• 8219", "Treasury wallet". */
  readonly name: string;
}

const REASONS = ['No longer used', 'Account closed', 'Details changed'] as const;

/**
 * Archiving a destination: one decision, said plainly — nothing is paid to it again, and it cannot be brought back
 * (S8: destinations are archived, never edited; a changed account is a new one). The reason is for the record and the
 * desk; the authenticator confirms it, in the same card.
 */
export function ArchiveDialog({ target, onClose }: { target: ArchiveTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [other, setOther] = useState('');
  const [code, setCode] = useState('');
  const text = reason === 'Other' ? other.trim() : reason;
  const guarded = useGuarded((key) =>
    target!.kind === 'bank'
      ? archiveBankAccountAction({ bankAccountId: target!.id, reason: text }, key)
      : archiveWalletAction({ walletId: target!.id, reason: text }, key),
  );
  const { reset } = guarded;

  useEffect(() => {
    if (!target) return;
    setReason(REASONS[0]);
    setOther('');
    setCode('');
    reset();
    // A new target is a new decision: its own reason, its own key.
  }, [target, reset]);

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      locked={guarded.busy}
      variant="dialog"
      title={target ? `Archive ${target.name}?` : 'Archive'}
      description={
        target?.kind === 'bank'
          ? 'Nothing will be paid to this account again. It stays in your list as archived; to use it again, add it as a new account.'
          : 'Nothing will be sent to this wallet again. It stays in your list as archived; to use it again, add it as a new wallet.'
      }
      footer={
        <>
          <button type="button" className={shell.secondaryAction} onClick={onClose} disabled={guarded.busy}>
            Keep it
          </button>
          <button
            type="button"
            className={styles.dangerAction}
            disabled={guarded.busy || text.length < 3 || (guarded.needsCode && code.length !== 6)}
            onClick={async () => {
              if (await (guarded.needsCode ? guarded.confirm(code) : guarded.run())) onClose();
            }}
          >
            {guarded.needsCode ? 'Confirm and archive' : 'Archive'}
          </button>
        </>
      }
    >
      <div className={styles.archiveBody}>
        {guarded.needsCode ? (
          <OtpInput label="Authenticator code" value={code} onChange={setCode} invalid={Boolean(guarded.error)} autoFocus />
        ) : (
          <fieldset className={styles.reasons}>
            <legend className={styles.reasonsLegend}>Why? The desk sees this.</legend>
            {[...REASONS, 'Other' as const].map((r) => (
              <label key={r} className={styles.reason}>
                <input type="radio" name="archive-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                <span>{r}</span>
              </label>
            ))}
            {reason === 'Other' ? (
              <textarea
                className={styles.reasonText}
                rows={2}
                maxLength={300}
                placeholder="A few words for the record"
                value={other}
                onChange={(e) => setOther(e.target.value)}
                aria-label="Reason"
                autoFocus
              />
            ) : null}
          </fieldset>
        )}
        {guarded.error ? (
          <p className={shell.error} role="alert">
            {guarded.error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
