'use client';

import { useEffect, useState } from 'react';
import type { ClientUpiId } from '@inrp2p/portal';
import { CopyButton, sanitizeAmountInput } from '@inrp2p/ui';
import { formatInr } from '@inrp2p/ui/format';
import { Money } from '@inrp2p/kernel';
import { ConfirmPanel, SecondFactorNeeded } from '../../../components/Confirm.tsx';
import { addUpiIdAction, updateUpiIdAction } from '../../../server/actions/upi.ts';
import { Field } from '../_workspace/Field.tsx';
import { ArchiveIcon, BoltIcon, InfoIcon, PauseIcon, SettingsIcon } from '../_workspace/icons.tsx';
import { UpiMark } from '../../../components/PayMarks.tsx';
import { Sheet } from '../_workspace/Sheet.tsx';
import { useGuarded } from '../_workspace/useGuarded.ts';
import { ArchiveDialog, type ArchiveTarget } from './ArchiveDialog.tsx';
import { AddTile, CardMenu, Group, Instrument, InstrumentTop, NoneYet, Tag } from './parts.tsx';
import shell from '../shell.module.css';
import styles from './destinations.module.css';
import add from './add.module.css';

/** UPI's own ceiling for one payment between two people. */
const UPI_MAX = '100000';
const VPA = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.-]{1,63}$/;
const rupees = (amount: string) => formatInr(Money.parse(amount, 'INR'));
/** What a UPI ID takes, a payment and a day, until a deal paid to it is confirmed (ADR 0030; `UPI_FIRST_DEAL_MAX_MINOR`). */
const FIRST_DEALS = '₹25,000';

/** UPI's own orange, the wash in a UPI ID card's corner. */
const UPI_TINT = '#f47920';

const STATE: Record<ClientUpiId['status'], string> = { ACTIVE: 'Ready', PENDING_REVIEW: 'Paused', REJECTED: 'Not verified', ARCHIVED: 'Archived' };

/**
 * A client's UPI IDs (ADR 0029): the addresses it is paid to and pays from by UPI, each its own, with no bank details
 * needed. One it adds is ready at once (ADR 0030): every buyer's UPI app shows the name the address is registered under, and
 * the buyer checks it is the client's before paying. Up to ₹25,000 until a deal to it is confirmed, then its own limits; a
 * buyer who sees another name pauses it for INRP2P. Each is a card with UPI's own mark, the address large enough to check,
 * and what it takes. The same list on Bank & wallets and, for a trader, on its settlement details.
 */
export function UpiIdsCard({ upiIds, isAdmin, holderName, clientName }: { upiIds: readonly ClientUpiId[]; isAdmin: boolean; holderName: string; clientName: string }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ClientUpiId | null>(null);
  const [archiving, setArchiving] = useState<ArchiveTarget | null>(null);
  const shown = upiIds.filter((u) => u.status !== 'ARCHIVED');
  const live = shown.filter((u) => u.status === 'ACTIVE').length;

  return (
    <>
      <Group id="upi-title" title="UPI IDs" count={live} note="Buyers pay you to these by UPI, and you can pay from them — ready as soon as you add one. In seconds, up to ₹100,000 a payment.">
        {shown.map((u) => (
          <UpiCard
            key={u.id}
            upi={u}
            {...(isAdmin && u.status !== 'REJECTED' ? { onEdit: () => setEditing(u), onArchive: () => setArchiving({ kind: 'upi', id: u.id, name: u.vpa, pending: u.status === 'PENDING_REVIEW' }) } : {})}
          />
        ))}
        {isAdmin ? (
          <AddTile
            title="Add UPI ID"
            note={
              shown.length === 0 ? (
                <>
                  No UPI ID yet · <span className="ix-num">name@okhdfcbank</span>
                </>
              ) : null
            }
            marks={
              <span className={styles.upiTile} data-size="sm">
                <UpiMark />
              </span>
            }
            onClick={() => setAdding(true)}
          />
        ) : shown.length === 0 ? (
          <NoneYet>No UPI ID yet. An administrator of {clientName} adds it.</NoneYet>
        ) : null}
      </Group>
      <AddUpiSheet open={adding} onClose={() => setAdding(false)} holderName={holderName} first={shown.length === 0} />
      <LimitsSheet upi={editing} onClose={() => setEditing(null)} />
      <ArchiveDialog target={archiving} onClose={() => setArchiving(null)} />
    </>
  );
}

function UpiCard({ upi: u, onEdit, onArchive }: { upi: ClientUpiId; onEdit?: () => void; onArchive?: () => void }) {
  const perPayment = rupees(u.perPaymentLimit);
  const limits = `${perPayment} a payment${u.dailyLimit ? ` · ${rupees(u.dailyLimit)} a day` : ''}`;
  const seen = u.verifiedName ?? u.holderName;
  const menu = [
    ...(onEdit && u.status === 'ACTIVE' ? [{ label: 'Change limits', icon: <SettingsIcon />, onSelect: onEdit }] : []),
    ...(onArchive ? [{ label: u.status === 'PENDING_REVIEW' ? 'Withdraw' : 'Archive', icon: <ArchiveIcon />, onSelect: onArchive, tone: 'danger' as const }] : []),
  ];
  return (
    <Instrument tint={UPI_TINT} state={u.status.toLowerCase()}>
      <InstrumentTop
        mark={
          <span className={styles.upiTile}>
            <UpiMark />
          </span>
        }
        title={seen}
        sub={u.label ?? 'The name buyers see'}
        tag={
          u.status === 'ACTIVE' ? (
            u.nameConfirmed ? (
              <Tag tone="success">Confirmed</Tag>
            ) : (
              <Tag tone="brand">Ready</Tag>
            )
          ) : u.status === 'PENDING_REVIEW' ? (
            <Tag tone="warning" icon={<PauseIcon />}>
              Paused
            </Tag>
          ) : (
            <Tag tone="danger">{STATE[u.status]}</Tag>
          )
        }
      />
      <div className={styles.figure}>
        <span className={styles.addressRow}>
          <span className={styles.vpa}>{u.vpa}</span>
          <CopyButton value={u.vpa} label={`UPI ID ${u.vpa}`} />
        </span>
      </div>
      {u.status === 'ACTIVE' && u.nameConfirmed ? (
        <p className={styles.cardNote} data-tone="success">
          A deal confirmed it is yours — your own limits apply.
        </p>
      ) : u.status === 'ACTIVE' ? (
        <p className={styles.cardNote} data-tone="brand">
          Up to {FIRST_DEALS} until your first deal to it is confirmed, then {perPayment} a payment.
        </p>
      ) : u.status === 'PENDING_REVIEW' ? (
        <p className={styles.cardNote} data-tone="warning">
          A buyer’s UPI app showed a different name. Paused until INRP2P checks it — buyers pay your bank account meanwhile.
        </p>
      ) : u.status === 'REJECTED' ? (
        <p className={styles.cardNote} data-tone="danger">
          Not verified{u.reviewNote ? `: ${u.reviewNote}` : ''}. Add another one.
        </p>
      ) : null}
      <div className={styles.foot}>
        <span className={styles.limits}>
          <BoltIcon />
          {limits}
        </span>
        {menu.length > 0 ? <CardMenu label={u.vpa} items={menu} /> : null}
      </div>
    </Instrument>
  );
}

/** The limits as typed: rupees, or empty for none of its own. */
function limitsProblem(perPayment: string, daily: string): string | null {
  const per = perPayment === '' ? Number(UPI_MAX) : Number.parseFloat(perPayment);
  if (!(per >= 1) || per > Number(UPI_MAX)) return 'One UPI payment is between ₹1 and ₹100,000.';
  if (daily !== '' && Number.parseFloat(daily) < per) return 'A day’s limit cannot be below one payment’s.';
  return null;
}

function AddUpiSheet({ open, onClose, holderName, first }: { open: boolean; onClose: () => void; holderName: string; first: boolean }) {
  const [vpa, setVpa] = useState('');
  const [perPayment, setPerPayment] = useState('');
  const [daily, setDaily] = useState('');
  const clean = vpa.trim().toLowerCase();
  const shapeOk = VPA.test(clean) && !clean.endsWith('.npci');
  const problem = limitsProblem(perPayment, daily);
  const guarded = useGuarded((key) => addUpiIdAction({ vpa: clean, perPaymentLimit: perPayment || null, dailyLimit: daily || null }, key));
  const { reset } = guarded;
  useEffect(() => {
    if (!open) return;
    setVpa('');
    setPerPayment('');
    setDaily('');
    reset();
  }, [open, reset]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      locked={guarded.busy}
      eyebrow="UPI ID"
      title={guarded.done ? 'UPI ID added' : 'Add a UPI ID'}
      description={guarded.done ? undefined : first ? 'The UPI ID you are paid to and pay from — ready as soon as you add it.' : 'Another UPI ID you are paid to and pay from. You confirm it is you with your second factor.'}
      footer={
        guarded.done || guarded.confirmWith || guarded.needsFactor ? undefined : (
          <>
            <button type="button" className={shell.secondaryAction} onClick={onClose} disabled={guarded.busy}>
              Cancel
            </button>
            <button type="button" className={shell.action} disabled={guarded.busy || !shapeOk || problem !== null} onClick={() => void guarded.run()}>
              Add UPI ID
            </button>
          </>
        )
      }
    >
      {guarded.done ? (
        <div className={add.done}>
          <p className={add.doneText}>
            <span className="ix-num">{clean}</span> is ready. Buyers can pay you up to {FIRST_DEALS} to it until your first deal to it is confirmed — then your own limits apply.
          </p>
          <div className={add.doneActions}>
            <button type="button" className={shell.action} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : guarded.confirmWith ? (
        <ConfirmPanel
          embedded
          factors={guarded.confirmWith.factors}
          purpose={guarded.confirmWith.purpose}
          summary={`Add UPI ID ${clean}`}
          onCancel={onClose}
          onVerified={async () => guarded.retry()}
        />
      ) : guarded.needsFactor ? (
        <SecondFactorNeeded summary={`Add UPI ID ${clean}`} onCancel={onClose} />
      ) : (
        <div className={add.form}>
          <Field
            label="UPI ID"
            mono
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
            placeholder="name@okhdfcbank"
            maxLength={120}
            value={vpa}
            onChange={(e) => setVpa(e.target.value.replace(/\s+/g, ''))}
            valid={shapeOk}
            error={vpa !== '' && !shapeOk ? (clean.endsWith('.npci') ? 'Enter your own UPI ID — not one made from an account number.' : 'A UPI ID looks like name@bank.') : null}
            hint="As your UPI app shows it under your profile."
          />
          <p className={shell.info}>
            <InfoIcon className={shell.infoIcon} />
            <span>
              Buyers’ UPI apps show the name this UPI ID is registered under, and they check it is <strong>{holderName}</strong> before paying. Add only one in your own
              name — one in another name is paused at the first deal.
            </span>
          </p>
          <div className={add.pair}>
            <Field
              label="Most in one payment"
              inputMode="decimal"
              adornment="₹"
              placeholder="100,000"
              value={perPayment}
              onChange={(e) => {
                const v = sanitizeAmountInput(e.target.value, 'INR');
                if (v !== null) setPerPayment(v);
              }}
              hint="Up to UPI’s ₹100,000. Larger deals go by bank transfer."
            />
            <Field
              label="Most in a day (optional)"
              inputMode="decimal"
              adornment="₹"
              value={daily}
              onChange={(e) => {
                const v = sanitizeAmountInput(e.target.value, 'INR');
                if (v !== null) setDaily(v);
              }}
              error={daily !== '' || perPayment !== '' ? problem : null}
              hint="Your bank’s daily UPI limit, if it has one. Deals beyond it go by bank transfer."
            />
          </div>
        </div>
      )}
      {guarded.error ? (
        <p className={shell.error} role="alert">
          {guarded.error}
        </p>
      ) : null}
    </Sheet>
  );
}

function LimitsSheet({ upi, onClose }: { upi: ClientUpiId | null; onClose: () => void }) {
  const [perPayment, setPerPayment] = useState('');
  const [daily, setDaily] = useState('');
  const problem = limitsProblem(perPayment, daily);
  const guarded = useGuarded((key) => updateUpiIdAction({ upiId: upi!.id, perPaymentLimit: perPayment || null, dailyLimit: daily || null }, key));
  const { reset } = guarded;
  useEffect(() => {
    if (!upi) return;
    setPerPayment(upi.perPaymentLimit === UPI_MAX ? '' : upi.perPaymentLimit);
    setDaily(upi.dailyLimit ?? '');
    reset();
  }, [upi, reset]);

  return (
    <Sheet
      open={upi !== null}
      onClose={onClose}
      locked={guarded.busy}
      variant="dialog"
      title={upi ? `Limits of ${upi.vpa}` : 'Limits'}
      description="Deals larger than these are paid to you by bank transfer instead. A deal already open keeps the way it was opened with."
      footer={
        guarded.confirmWith || guarded.needsFactor ? undefined : (
          <>
            <button type="button" className={shell.secondaryAction} onClick={onClose} disabled={guarded.busy}>
              Cancel
            </button>
            <button
              type="button"
              className={shell.action}
              disabled={guarded.busy || problem !== null}
              onClick={async () => {
                if (await guarded.run()) onClose();
              }}
            >
              Save
            </button>
          </>
        )
      }
    >
      {guarded.confirmWith ? (
        <ConfirmPanel
          embedded
          factors={guarded.confirmWith.factors}
          purpose={guarded.confirmWith.purpose}
          summary={upi ? `Change the limits of ${upi.vpa}` : 'Change limits'}
          onCancel={onClose}
          onVerified={async () => {
            const problemAfter = await guarded.retry();
            if (!problemAfter) onClose();
            return problemAfter;
          }}
        />
      ) : guarded.needsFactor ? (
        <SecondFactorNeeded summary="Change UPI limits" onCancel={onClose} />
      ) : (
        <div className={add.form}>
          <Field
            label="Most in one payment"
            inputMode="decimal"
            adornment="₹"
            placeholder="100,000"
            value={perPayment}
            onChange={(e) => {
              const v = sanitizeAmountInput(e.target.value, 'INR');
              if (v !== null) setPerPayment(v);
            }}
          />
          <Field
            label="Most in a day (optional)"
            inputMode="decimal"
            adornment="₹"
            value={daily}
            onChange={(e) => {
              const v = sanitizeAmountInput(e.target.value, 'INR');
              if (v !== null) setDaily(v);
            }}
            error={problem}
          />
        </div>
      )}
      {guarded.error ? (
        <p className={shell.error} role="alert">
          {guarded.error}
        </p>
      ) : null}
    </Sheet>
  );
}
