'use client';

import { useState } from 'react';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { CheckIcon, ClockIcon, ShieldIcon } from './icons.tsx';
import shell from '../shell.module.css';
import styles from './p2p-dispute.module.css';

/**
 * A P2P payment's dispute (ADR 0020 §2.15), drawn the same for a client and a desk. The seller of the USDT receives the
 * rupees and is the only one who can say they did not arrive; INRP2P then decides from the seller's bank. What each
 * side writes goes to INRP2P only — the other side sees that there is a dispute, never the words.
 */

export type DisputeReason = 'NO_CREDIT' | 'WRONG_AMOUNT' | 'OTHER';

export interface DisputeView {
  readonly ref: string;
  readonly reason: DisputeReason;
  readonly status: 'OPEN' | 'PAID' | 'NOT_PAID';
  readonly openedAt: string;
  readonly yourNote: string | null;
  readonly buyerAnswered: boolean;
}

const REASONS: readonly { value: DisputeReason; label: string }[] = [
  { value: 'NO_CREDIT', label: 'Nothing arrived' },
  { value: 'WRONG_AMOUNT', label: 'A different amount' },
  { value: 'OTHER', label: 'Something else' },
];

const REASON_WORDS: Record<DisputeReason, string> = { NO_CREDIT: 'nothing arrived', WRONG_AMOUNT: 'a different amount arrived', OTHER: 'something is wrong with it' };

type Submit<A extends unknown[]> = (...args: A) => Promise<{ ok: boolean; error?: string | null }>;

/**
 * The seller's way out of "Release the escrow": the rupees are not there. Folded until asked for, so the one right thing
 * — checking the bank, then confirming — stays the obvious one.
 */
export function NotArrived({ inr, onSubmit, busy }: { inr: string; onSubmit: Submit<[DisputeReason, string | null]>; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<DisputeReason>('NO_CREDIT');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ready = !busy && (reason !== 'OTHER' || note.trim().length >= 3);

  if (!open) {
    return (
      <div className={styles.fold}>
        <span className={styles.foldText}>Not in your account?</span>
        <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => setOpen(true)}>
          It hasn’t arrived
        </button>
      </div>
    );
  }
  const submit = async () => {
    setError(null);
    const out = await onSubmit(reason, note.trim() || null);
    if (!out.ok) setError(out.error ?? 'That did not go through. Try again.');
  };
  return (
    <section className={styles.panel} aria-labelledby="not-arrived-title">
      <h3 id="not-arrived-title" className={styles.title}>
        Tell INRP2P {inr} hasn’t arrived
      </h3>
      <p className={styles.lead}>
        IMPS and UPI arrive in seconds; NEFT can take a few hours on bank working days. Check your bank app — pending credits too — before you do.
      </p>
      <div className={styles.reasons} role="radiogroup" aria-label="What your bank shows">
        {REASONS.map((r) => (
          <label key={r.value} className={styles.reason} data-selected={reason === r.value || undefined}>
            <input type="radio" name="dispute-reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} className={styles.radio} />
            {r.label}
          </label>
        ))}
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>For INRP2P{reason === 'OTHER' ? '' : ' (optional)'}</span>
        <textarea
          className={styles.textarea}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={reason === 'WRONG_AMOUNT' ? 'e.g. Only ₹30,000 arrived, at 14:09' : 'e.g. No credit for this UTR in my statement'}
        />
        <span className={styles.fieldHelp}>Only INRP2P reads this — the buyer is told there is a dispute, not what you wrote.</span>
      </label>
      <p className={styles.consequence}>
        <ShieldIcon className={styles.icon} />
        <span>The deal stops and your USDT stays locked in escrow. INRP2P decides from your bank’s evidence and may ask you for a statement.</span>
      </p>
      {error ? (
        <p className={shell.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={shell.action} disabled={!ready} aria-busy={busy || undefined} onClick={() => void submit()}>
          Tell INRP2P
        </button>
        <button type="button" className={shell.textAction} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** The seller's dispute while INRP2P decides: what it said, and that its USDT is safe. */
export function DisputeUnderReview({ dispute, children }: { dispute: DisputeView; children?: React.ReactNode }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={styles.panel} data-tone="review" aria-label={`Dispute ${dispute.ref}`}>
      <div className={styles.head}>
        <span className={styles.badge}>
          <ClockIcon className={styles.icon} />
          With INRP2P · <span className="ix-num">{dispute.ref}</span>
        </span>
        <span className={styles.meta}>{formatIstDateTime(new Date(dispute.openedAt))}</span>
      </div>
      <p className={styles.lead}>
        You said {REASON_WORDS[dispute.reason]}. Your USDT stays locked in escrow until INRP2P decides, from your bank’s evidence — not the buyer’s word.
      </p>
      {dispute.yourNote ? <blockquote className={styles.quote}>{dispute.yourNote}</blockquote> : null}
      <ol className={styles.track} aria-label="Where it stands">
        <li data-state="done">
          <CheckIcon className={styles.icon} /> You told INRP2P
        </li>
        <li data-state={dispute.buyerAnswered ? 'done' : 'waiting'}>
          {dispute.buyerAnswered ? <CheckIcon className={styles.icon} /> : <ClockIcon className={styles.icon} />} {dispute.buyerAnswered ? 'The buyer added its details' : 'Waiting for the buyer’s details'}
        </li>
        <li data-state="waiting">
          <ClockIcon className={styles.icon} /> INRP2P decides
        </li>
      </ol>
      {children ? (
        confirming ? (
          <div className={styles.later}>{children}</div>
        ) : (
          <div className={styles.fold}>
            <span className={styles.foldText}>It arrived after all?</span>
            <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => setConfirming(true)}>
              Confirm it
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}

/** The buyer's side of a dispute: what helps INRP2P check it, sent to INRP2P only. */
export function AddYourSide({ dispute, inr, onSubmit, busy }: { dispute: DisputeView; inr: string; onSubmit: Submit<[string]>; busy: boolean }) {
  const [note, setNote] = useState(dispute.yourNote ?? '');
  const [editing, setEditing] = useState(dispute.yourNote === null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    const out = await onSubmit(note.trim());
    if (out.ok) setEditing(false);
    else setError(out.error ?? 'That did not go through. Try again.');
  };
  return (
    <section className={styles.panel} data-tone="review" aria-labelledby="answer-title">
      <div className={styles.head}>
        <span className={styles.badge}>
          <ClockIcon className={styles.icon} />
          With INRP2P · <span className="ix-num">{dispute.ref}</span>
        </span>
        <span className={styles.meta}>{formatIstDateTime(new Date(dispute.openedAt))}</span>
      </div>
      <h3 id="answer-title" className={styles.title}>
        Add your side for INRP2P
      </h3>
      <p className={styles.lead}>
        The seller says {REASON_WORDS[dispute.reason]}. INRP2P is checking your {inr} with the seller’s bank; the USDT stays locked in escrow meanwhile. If the money left your
        account, add what helps: the UTR, the time you paid, the account you paid from.
      </p>
      {editing ? (
        <>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>For INRP2P</span>
            <textarea
              className={styles.textarea}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="e.g. Paid by IMPS from HDFC ••4821 at 14:02, UTR 412345678901"
            />
            <span className={styles.fieldHelp}>Only INRP2P reads this. Never send money again for this deal.</span>
          </label>
          {error ? (
            <p className={shell.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="button" className={shell.action} disabled={busy || note.trim().length < 3} aria-busy={busy || undefined} onClick={() => void submit()}>
              Send to INRP2P
            </button>
            {dispute.yourNote ? (
              <button type="button" className={shell.textAction} onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <blockquote className={styles.quote}>{dispute.yourNote ?? note}</blockquote>
          <div className={styles.fold}>
            <span className={styles.foldText}>
              <CheckIcon className={styles.icon} /> INRP2P has your details
            </span>
            <button type="button" className={shell.textAction} onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        </>
      )}
    </section>
  );
}
