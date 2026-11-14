'use client';

import { useState } from 'react';
import { type InrRail, Money, NEW_PAYEE_CAUTION_INR, RAIL_NOT_TAKEN, checkUtrShape, normalizeUtr, railsForUtr } from '@inrp2p/kernel';
import type { P2pDeal } from '@inrp2p/settlement';
import { CopyButton, QrCode } from '@inrp2p/ui';
import { formatInr } from '@inrp2p/ui/format';
import { type ActionResult, useCommand } from '../../../components/useCommand.tsx';
import { playSound } from '../_assistant/sound.ts';
import { ATTACH_ACCEPT, fileSize, prepareAttachment } from './attach.ts';
import { BankIcon, CheckIcon, ClockIcon, CloseIcon, InfoIcon, PaperclipIcon, PhoneIcon, ShieldIcon } from './icons.tsx';
import shell from '../shell.module.css';
import pay from '../trades/[tradeRef]/payment.module.css';
import styles from './pay-inr.module.css';

type Method = NonNullable<P2pDeal['payWindow']>['methods'][number];

/** How long each rail takes to land, as a payer plans around it. */
const SPEED: Record<InrRail, string> = {
  UPI: 'Arrives in seconds.',
  IMPS: 'Arrives in seconds, any time of day.',
  NEFT: 'Goes in the next half-hourly batch, 24×7 — usually within an hour, sometimes two or three.',
  RTGS: 'From ₹2 lakh. Usually within half an hour; some banks send RTGS only in banking hours.',
};

/** One of the payer's own: a registered bank account, or (ADR 0029) a verified UPI ID. */
export interface PayFromAccount {
  readonly id: string;
  readonly kind: 'BANK' | 'UPI';
  /** How it is named on screen: `HDFC Bank ••1234`, `UPI ID name@bank`. */
  readonly label: string;
  readonly bankName: string;
  readonly last4: string;
  readonly holderName: string;
}

/**
 * The buyer's step of a P2P deal (ADR 0019/0023), the same for a client buying and a trader buying: how to pay — the way
 * the amount suits, each with its time — the seller's own account to pay into, by a UPI code or the account to copy, and
 * then the bank's reference, with the receipt if the buyer has one.
 *
 * Choosing a way to pay sets the deadline on the server (never past the slowest way's). Saying "I've paid" stops that
 * clock and starts the seller's; nothing here — the reference, the receipt, a return from the bank's app — counts as the
 * money having arrived. Only the seller's confirmation from its own bank does.
 */
export function PayInr({
  deal,
  fromAccounts,
  defaultFrom,
  attachFields,
  choose,
  claim,
  attach,
}: {
  deal: P2pDeal;
  /** The payer's own accounts and verified UPI IDs; null for one that pays only from the account on its file. */
  fromAccounts: readonly PayFromAccount[] | null;
  /** The one chosen to start with — a trader's registered account; without it, a sole account, or none. */
  defaultFrom?: string;
  attachFields: Readonly<Record<string, string>>;
  choose: (method: InrRail, key: string) => Promise<ActionResult<unknown>>;
  claim: (input: { rail: InrRail; utr: string; from: { readonly kind: 'BANK' | 'UPI'; readonly id: string } | null }, key: string) => Promise<ActionResult<{ legRef: string }>>;
  attach: (form: FormData) => Promise<ActionResult<{ id: string }>>;
}) {
  const cmd = useCommand();
  const picking = useCommand();
  const slot = deal.payWindow;
  const payee = deal.payTo;
  const [method, setMethod] = useState<InrRail>(slot?.method ?? 'IMPS');
  const [from, setFrom] = useState<string>(defaultFrom ?? (fromAccounts?.length === 1 ? fromAccounts[0]!.id : ''));
  const [utr, setUtr] = useState('');
  const [own, setOwn] = useState(false);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);
  const amount = Money.parse(deal.inr, 'INR');
  const inr = formatInr(amount, { fraction: 'always' });

  if (!payee) return <p className={pay.lead}>The seller’s account is being prepared. This page shows it in a moment.</p>;

  const methods = slot?.methods ?? [];
  const current = methods.find((m) => m.rail === method);
  const shape = utr === '' ? null : checkUtrShape(method, utr);
  const otherRail = shape && !shape.ok ? railsForUtr(utr).find((r) => r !== method) : undefined;
  const fromAccount = fromAccounts ? (fromAccounts.find((a) => a.id === from) ?? null) : null;
  const ready = !cmd.busy && shape?.ok === true && own && (fromAccounts === null || fromAccount !== null);
  const large = amount.minor >= BigInt(NEW_PAYEE_CAUTION_INR) * 100n;

  const select = async (m: Method) => {
    if (!m.possible) return;
    setMethod(m.rail);
    // The deadline follows the way the buyer pays — while that way's time from the escrow is still open.
    if (slot && m.rail !== slot.method && m.open && slot.changesLeft > 0) await picking.run(`Paying by ${m.rail}`, (key) => choose(m.rail, key));
  };

  const pickReceipt = async (f: File | undefined) => {
    setReceiptError(null);
    if (!f) return;
    const r = await prepareAttachment(f);
    if (r.ok) setReceipt(r.file);
    else setReceiptError(r.error);
  };

  const submit = async () => {
    const out = await cmd.run(`Payment of ${inr} filed`, (key) => claim({ rail: method, utr: normalizeUtr(utr), from: fromAccount ? { kind: fromAccount.kind, id: fromAccount.id } : null }, key));
    if (!out.ok) return;
    playSound('success');
    if (receipt) {
      // The receipt goes to the deal's chat, against this payment. The payment stands whether or not it arrives.
      const sent = await cmd.run('Receipt attached', (key) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(attachFields)) form.set(k, v);
        form.set('key', key);
        form.set('legRef', out.result.legRef);
        form.set('file', receipt);
        return attach(form);
      });
      setSentNote(sent.ok ? null : 'Your payment is filed. The receipt did not attach — send it in the chat below.');
    }
    setUtr('');
    setOwn(false);
    setReceipt(null);
  };

  return (
    <div className={styles.pay}>
      <div className={pay.rule}>
        <ShieldIcon className={pay.ruleIcon} />
        <p>
          <strong>Pay from your own account, to exactly this account.</strong> The seller checks who sent the money in their own bank — rupees from anyone else go back and
          do not count.
        </p>
      </div>

      {slot?.final ? (
        <p className={pay.overdue} role="status">
          <ClockIcon className={pay.inlineIcon} />
          <span>
            <strong>Your time to pay is up.</strong> If you have sent {inr}, say so below now — after the final minutes the deal is cancelled and the seller’s USDT goes back.
            Not paid yet? Don’t pay now.
          </span>
        </p>
      ) : null}

      <ol className={pay.steps}>
        <li className={pay.step}>
          <span className={pay.stepNo} aria-hidden="true">
            1
          </span>
          <div className={pay.stepBody}>
            <h3 className={pay.stepTitle}>Send {inr}</h3>
            {methods.length > 0 ? (
              <div className={styles.methods} role="radiogroup" aria-label="How you pay">
                {methods.map((m, i) => (
                  <button
                    key={m.rail}
                    type="button"
                    role="radio"
                    aria-checked={method === m.rail}
                    className={styles.method}
                    disabled={!m.possible || picking.busy}
                    title={m.limit ?? undefined}
                    onClick={() => void select(m)}
                  >
                    <span className={styles.methodName}>{m.rail}</span>
                    <span className={styles.methodTime}>{m.possible ? `${m.minutes} min` : m.limit === RAIL_NOT_TAKEN ? (fromAccounts ? 'the seller does not take it' : 'not used on this deal') : m.limit?.replace(/ in one payment$/, '')}</span>
                    {i === 0 && m.possible ? <span className={styles.methodTag}>Suggested</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {current && slot && method !== slot.method && (!current.open || slot.changesLeft === 0) ? (
              <p className={styles.methodNote}>
                <InfoIcon className={pay.inlineIcon} />
                {slot.changesLeft === 0 ? `Your time stays as it is for ${slot.method}.` : `${method}’s ${current.minutes} minutes from the escrow are over — your time stays as it is for ${slot.method}.`}
              </p>
            ) : null}
            {picking.error ? (
              <p className={shell.error} role="alert">
                {picking.error}
              </p>
            ) : null}

            {method === 'UPI' && payee.upiLink ? (
              <div className={pay.upi}>
                <QrCode value={payee.upiLink} label={`UPI code to pay ${inr} to ${payee.upiName ?? payee.holderName}`} className={pay.qr} />
                <div className={pay.upiText}>
                  <p className={pay.upiLead}>
                    Scan with any UPI app — the amount and the remarks are filled in. Your app should show <strong>{payee.upiName ?? payee.holderName}</strong>: if it shows
                    another name, do not pay. Then approve with your UPI PIN.
                  </p>
                  <a className={`${shell.action} ${pay.openApp}`} href={payee.upiLink}>
                    <PhoneIcon className={pay.inlineIcon} />
                    Pay in UPI app
                  </a>
                  <Detail label="UPI ID" value={payee.upiId ?? ''} mono />
                  <Detail label="Amount" value={deal.inr} shown={inr} mono />
                  <Detail label="Name in your app" value={payee.upiName ?? payee.holderName} copy={false} extra={<span className={styles.ifscOk}><CheckIcon /> verified by INRP2P</span>} />
                </div>
              </div>
            ) : (
              <div className={pay.bank}>
                <Detail label="Account name" value={payee.holderName} />
                <Detail label="Account number" value={payee.accountNumber} mono />
                <Detail
                  label="IFSC"
                  value={payee.ifsc}
                  mono
                  extra={
                    payee.ifscValid ? (
                      <span className={styles.ifscOk}>
                        <CheckIcon /> valid format · bank {payee.ifsc.slice(0, 4)}
                      </span>
                    ) : (
                      <span className={styles.ifscBad}>check with the seller</span>
                    )
                  }
                />
                <Detail label="Bank" value={payee.bankName} copy={false} />
                <Detail label="Amount" value={deal.inr} shown={inr} mono />
                <Detail label="Remarks" value={payee.remarks} mono />
                <p className={pay.hint}>
                  <InfoIcon className={pay.inlineIcon} />
                  {SPEED[method]} Exactly {inr}, in one payment.
                </p>
              </div>
            )}

            {large ? (
              <p className={styles.caution}>
                <BankIcon className={pay.inlineIcon} />
                <span>
                  <strong>A large transfer.</strong> Banks often cap the first payments to a new payee — sometimes to ₹50,000 or less in the first day — or hold them for a few hours.
                  Check your bank’s limit before you start.
                </span>
              </p>
            ) : null}
          </div>
        </li>

        <li className={pay.step}>
          <span className={pay.stepNo} aria-hidden="true">
            2
          </span>
          <div className={pay.stepBody}>
            <h3 className={pay.stepTitle}>Tell the seller you paid</h3>
            {fromAccounts && fromAccounts.length !== 1 ? (
              fromAccounts.length === 0 ? (
                <p className={pay.muted}>
                  No bank account or verified UPI ID of yours is registered. <a className={shell.textAction} href="/destinations">Add the one you pay from</a>, then come back
                  here; pay only from your own.
                </p>
              ) : (
                <div className={pay.accounts} role="radiogroup" aria-label="You paid from">
                  {fromAccounts.map((a) => (
                    <label key={a.id} className={pay.account} data-selected={from === a.id || undefined}>
                      <input type="radio" name="from" value={a.id} checked={from === a.id} onChange={() => setFrom(a.id)} className={pay.radio} />
                      {a.kind === 'UPI' ? <PhoneIcon className={pay.accountIcon} /> : <BankIcon className={pay.accountIcon} />}
                      <span className={pay.accountText}>
                        <span className={`${pay.accountBank} ${a.kind === 'UPI' ? 'ix-num' : ''}`}>{a.label}</span>
                        {a.holderName ? <span className={pay.accountHolder}>{a.holderName}</span> : null}
                      </span>
                    </label>
                  ))}
                </div>
              )
            ) : null}
            <label className={pay.field}>
              <span className={pay.fieldLabel}>{method} transaction reference (UTR)</span>
              <input
                className={`${pay.input} ix-num`}
                value={utr}
                onChange={(e) => setUtr(e.target.value.replace(/[^0-9A-Za-z\s]/g, '').toUpperCase())}
                inputMode={method === 'UPI' || method === 'IMPS' ? 'numeric' : 'text'}
                autoComplete="off"
                spellCheck={false}
                maxLength={26}
                placeholder={method === 'UPI' || method === 'IMPS' ? '12 digits' : '16–22 characters'}
                aria-invalid={shape?.ok === false || undefined}
                aria-describedby="pay-utr-help"
              />
              <span id="pay-utr-help" className={pay.fieldHelp} data-tone={shape?.ok === false ? 'warning' : undefined} aria-live="polite">
                {shape?.ok === false
                  ? otherRail
                    ? `That looks like a ${otherRail} reference — choose ${otherRail} above.`
                    : `Not a ${method} reference yet: ${shape.hint}.`
                  : shape?.ok
                    ? 'Looks right.'
                    : method === 'UPI'
                      ? 'In your UPI app, open the payment: “UPI transaction ID”, “UTR” or “UPI Ref No.”'
                      : 'In your bank app, open the transfer: the reference or UTR.'}
              </span>
            </label>

            <div className={styles.receipt}>
              {receipt ? (
                <span className={styles.receiptFile}>
                  <PaperclipIcon className={pay.inlineIcon} />
                  <span className={styles.receiptName}>{receipt.name}</span>
                  <span className={pay.muted}>{fileSize(receipt.size)}</span>
                  <button type="button" className={styles.receiptRemove} onClick={() => setReceipt(null)} aria-label="Remove the receipt">
                    <CloseIcon />
                  </button>
                </span>
              ) : (
                <label className={shell.textAction}>
                  <PaperclipIcon className={pay.inlineIcon} />
                  Attach the receipt (optional)
                  <input
                    type="file"
                    accept={ATTACH_ACCEPT}
                    hidden
                    onChange={(e) => {
                      void pickReceipt(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
              {receiptError ? <span className={pay.fieldHelp} data-tone="warning">{receiptError}</span> : null}
            </div>

            <label className={pay.confirm}>
              <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} disabled={fromAccounts !== null && !fromAccount} />
              <span>
                I sent {inr} to {payee.holderName}
                {fromAccounts ? ` from ${fromAccount ? fromAccount.label : 'my account'}` : ' from my registered account'} — in my own name.
              </span>
            </label>
            <div className={pay.submitRow}>
              <button type="button" className={shell.action} disabled={!ready} aria-busy={cmd.busy || undefined} onClick={() => void submit()}>
                <CheckIcon className={pay.inlineIcon} />
                I’ve paid
              </button>
              <span className={pay.muted}>The USDT stays locked for you while the seller checks their bank.</span>
            </div>
            {cmd.error ? (
              <p className={shell.error} role="alert">
                {cmd.error}
              </p>
            ) : null}
            {sentNote ? <p className={pay.fieldHelp} data-tone="warning">{sentNote}</p> : null}
          </div>
        </li>
      </ol>
      {cmd.dialog}
      {picking.dialog}
    </div>
  );
}

function Detail({ label, value, shown, mono = false, copy = true, extra = null }: { label: string; value: string; shown?: string; mono?: boolean; copy?: boolean; extra?: React.ReactNode }) {
  return (
    <div className={pay.detail}>
      <span className={pay.detailLabel}>{label}</span>
      <span className={`${pay.detailValue} ${mono ? 'ix-num' : ''}`}>
        {shown ?? value}
        {extra}
      </span>
      {copy ? <CopyButton value={value} label={label.toLowerCase()} /> : <span />}
    </div>
  );
}
