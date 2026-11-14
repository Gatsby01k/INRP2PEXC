'use client';

import { useEffect, useState } from 'react';
import { ConfirmPanel, SecondFactorNeeded } from '../../../components/Confirm.tsx';
import { archiveBankAccountAction, archiveWalletAction } from '../../../server/actions/client.ts';
import { archiveUpiIdAction } from '../../../server/actions/upi.ts';
import { Sheet } from '../_workspace/Sheet.tsx';
import { useGuarded } from '../_workspace/useGuarded.ts';
import shell from '../shell.module.css';
import styles from './destinations.module.css';

export interface ArchiveTarget {
  readonly kind: 'bank' | 'wallet' | 'upi';
  readonly id: string;
  /** How the client knows it: "HDFC Bank •••• 8219", "Treasury wallet". */
  readonly name: string;
  /** A UPI ID still waiting for INRP2P: withdrawn, not archived — nothing was ever paid to it. */
  readonly pending?: boolean;
}

const REASONS = ['No longer used', 'Account closed', 'Details changed'] as const;

/**
 * Archiving a destination: one decision, said plainly — nothing is paid to it again, and it cannot be brought back
 * (S8: destinations are archived, never edited; a changed account is a new one). The reason is for the record and the
 * desk; a code from another factor than the sign-in confirms it, in the same card (ADR 0026).
 */
export function ArchiveDialog({ target, onClose }: { target: ArchiveTarget | null; onClose: () => void }) {
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [other, setOther] = useState('');
  const text = reason === 'Other' ? other.trim() : reason;
  const guarded = useGuarded((key) =>
    target!.kind === 'bank'
      ? archiveBankAccountAction({ bankAccountId: target!.id, reason: text }, key)
      : target!.kind === 'upi'
        ? archiveUpiIdAction({ upiId: target!.id, reason: text }, key)
        : archiveWalletAction({ walletId: target!.id, reason: text }, key),
  );
  const { reset } = guarded;

  useEffect(() => {
    if (!target) return;
    setReason(REASONS[0]);
    setOther('');
    reset();
    // A new target is a new decision: its own reason, its own key.
  }, [target, reset]);

  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      locked={guarded.busy}
      variant="dialog"
      title={target ? `${target.pending ? 'Withdraw' : 'Archive'} ${target.name}?` : 'Archive'}
      description={
        target?.kind === 'bank'
          ? 'Nothing will be paid to this account again. It stays in your list as archived; to use it again, add it as a new account.'
          : target?.kind === 'upi'
            ? target.pending
              ? 'INRP2P stops checking it, and nothing is ever paid to it. You can add it again later.'
              : 'No deal is paid to this UPI ID again, and you can no longer pay from it. A deal in progress keeps it until it finishes. To use it again, add it again — INRP2P checks it once more.'
            : 'Nothing will be sent to this wallet again. It stays in your list as archived; to use it again, add it as a new wallet.'
      }
      footer={
        guarded.confirmWith || guarded.needsFactor ? undefined : (
          <>
            <button type="button" className={shell.secondaryAction} onClick={onClose} disabled={guarded.busy}>
              Keep it
            </button>
            <button
              type="button"
              className={styles.dangerAction}
              disabled={guarded.busy || text.length < 3}
              onClick={async () => {
                if (await guarded.run()) onClose();
              }}
            >
              {target?.pending ? 'Withdraw' : 'Archive'}
            </button>
          </>
        )
      }
    >
      <div className={styles.archiveBody}>
        {guarded.confirmWith ? (
          <ConfirmPanel
            embedded
            factors={guarded.confirmWith.factors}
            purpose={guarded.confirmWith.purpose}
            summary={target ? `Archive ${target.name}` : 'Archive'}
            onCancel={onClose}
            onVerified={async () => {
              const problem = await guarded.retry();
              if (!problem) onClose();
              return problem;
            }}
          />
        ) : guarded.needsFactor ? (
          <SecondFactorNeeded summary={target ? `Archive ${target.name}` : 'Archive'} onCancel={onClose} />
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
