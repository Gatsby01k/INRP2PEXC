'use client';

import { useEffect, useMemo, useState } from 'react';
import { type InrRail, Money, checkUtrShape, normalizeUtr, railsForUtr } from '@inrp2p/kernel';
import type { PortalInrPayment } from '@inrp2p/portal';
import { CopyButton, QrCode } from '@inrp2p/ui';
import { formatCountdown, formatInr, formatIstDateTime, maskUtr } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { claimPaymentAction } from '../../../../server/actions/client.ts';
import { playSound } from '../../_assistant/sound.ts';
import { BankIcon, CheckIcon, ClockIcon, InfoIcon, PhoneIcon, ShieldIcon } from '../../_workspace/icons.tsx';
import shell from '../../shell.module.css';
import styles from './payment.module.css';

type Method = 'UPI' | 'BANK';

const STATE_WORDS = {
  CHECKING: 'Checking',
  CONFIRMED: 'Received',
  RETURNING: 'Not your account — being returned',
  NOT_RECEIVED: 'Not received',
} as const;

/**
 * Paying a BUY trade's rupees (ADR 0018), as one guided card: whose account pays, how — a UPI code that fills
 * everything in, or the account details to copy — and then the bank's reference. Three steps, in the order the client
 * lives them, with the one rule that keeps their own bank account safe said first: pay only from an account in your own
 * name.
 *
 * Nothing is counted here. Saying "I paid" files the payment; the desk sees the credit and who sent it, and only then
 * does the USDT go out.
 */
export function InrPayment({ tradeRef, payment, total }: { tradeRef: string; payment: PortalInrPayment; total: string }) {
  const cmd = useCommand();
  const { instructions } = payment;
  const due = Money.parse(payment.due, 'INR');
  const partial = Money.parse(total, 'INR').minor !== due.minor;
  const upiAllowed = Boolean(instructions?.upiLink);
  const [method, setMethod] = useState<Method>(upiAllowed ? 'UPI' : 'BANK');
  const [from, setFrom] = useState<string>(payment.fromAccounts.length === 1 ? payment.fromAccounts[0]!.id : '');
  const [utr, setUtr] = useState('');
  const [bankRail, setBankRail] = useState<InrRail>('IMPS');
  const [own, setOwn] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const now = useNow();

  const rail: InrRail = method === 'UPI' ? 'UPI' : bankRail;
  const shape = utr === '' ? null : checkUtrShape(rail, utr);
  // A 16-character reference typed under IMPS is a NEFT one: say so rather than refuse it.
  const otherRail = shape && !shape.ok ? railsForUtr(utr).find((r) => r !== rail && (method === 'BANK' ? r !== 'UPI' : true)) : undefined;
  const fromAccount = payment.fromAccounts.find((a) => a.id === from) ?? null;
  const ready = !cmd.busy && fromAccount !== null && shape?.ok === true && own && due.isPositive();
  const remaining = instructions ? Date.parse(instructions.payBy) - now : null;
  const overdue = remaining !== null && remaining <= 0;
  const returning = payment.payments.filter((p) => p.state === 'RETURNING');
  const amountText = formatInr(due, { fraction: 'always' });
  const plainAmount = due.toDecimalString();

  const submit = async () => {
    if (!fromAccount) return;
    const out = await cmd.run(`Payment of ${amountText} filed`, (key) =>
      claimPaymentAction({ tradeRef, rail, utr: normalizeUtr(utr), fromBankAccountId: fromAccount.id, amount: plainAmount }, key),
    );
    if (out.ok) {
      playSound('success');
      setSent(normalizeUtr(utr));
      setUtr('');
      setOwn(false);
    }
  };

  if (!instructions) {
    return (
      <section className={`${shell.card} ${styles.card}`} aria-labelledby="pay-title" data-attention="">
        <Head title={`Pay ${amountText}`} />
        <p className={styles.lead}>The desk sends you the account to pay into and the reference to use. Pay only from an account in your own name — your USDT goes out once the payment is confirmed.</p>
      </section>
    );
  }

  return (
    <section className={`${shell.card} ${styles.card}`} aria-labelledby="pay-title" {...(payment.canClaim ? { 'data-attention': '' } : {})}>
      <Head
        title={payment.canClaim ? (partial ? `Pay the remaining ${amountText}` : `Pay ${amountText}`) : 'Your payment'}
        timer={payment.canClaim && remaining !== null ? <PayTimer remaining={remaining} /> : null}
      />

      {returning.length > 0 ? (
        <p className={styles.alert} role="alert">
          <ShieldIcon className={styles.alertIcon} />
          <span>
            <strong>A payment did not come from your own account.</strong> It is being returned to the account it came from and does not count. Pay again from one of your
            registered accounts.
          </span>
        </p>
      ) : null}

      {payment.canClaim ? (
        <>
          <div className={styles.rule}>
            <ShieldIcon className={styles.ruleIcon} />
            <p>
              <strong>Pay only from your own account.</strong> Money from anyone else — family, a friend, a business — is returned and does not count. It is what keeps
              your bank account, and ours, safe.
            </p>
          </div>

          {overdue ? (
            <p className={styles.overdue} role="status">
              <ClockIcon className={styles.inlineIcon} />
              The time to pay has run out and this trade is about to be cancelled. If you have already paid, enter the reference below now.
            </p>
          ) : null}

          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={styles.stepNo} aria-hidden="true">
                1
              </span>
              <div className={styles.stepBody}>
                <h3 className={styles.stepTitle}>Pay from</h3>
                {payment.fromAccounts.length === 0 ? (
                  <p className={styles.muted}>No bank account of yours is registered yet. Ask the desk to add one in your name — payments from other accounts are returned.</p>
                ) : (
                  <div className={styles.accounts} role="radiogroup" aria-label="Your account">
                    {payment.fromAccounts.map((a) => (
                      <label key={a.id} className={styles.account} data-selected={from === a.id || undefined}>
                        <input type="radio" name="from" value={a.id} checked={from === a.id} onChange={() => setFrom(a.id)} className={styles.radio} />
                        <BankIcon className={styles.accountIcon} />
                        <span className={styles.accountText}>
                          <span className={styles.accountBank}>
                            {a.bankName} <span className="ix-num">••{a.last4}</span>
                          </span>
                          <span className={styles.accountHolder}>{a.holderName}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </li>

            <li className={styles.step}>
              <span className={styles.stepNo} aria-hidden="true">
                2
              </span>
              <div className={styles.stepBody}>
                <div className={styles.stepHead}>
                  <h3 className={styles.stepTitle}>Pay {amountText}</h3>
                  <div className={styles.tabs} role="tablist" aria-label="How you pay">
                    <button type="button" role="tab" aria-selected={method === 'UPI'} className={styles.tab} disabled={!upiAllowed} onClick={() => setMethod('UPI')}>
                      UPI
                    </button>
                    <button type="button" role="tab" aria-selected={method === 'BANK'} className={styles.tab} onClick={() => setMethod('BANK')}>
                      Bank transfer
                    </button>
                  </div>
                </div>

                {method === 'UPI' && instructions.upiLink ? (
                  <div className={styles.upi} role="tabpanel">
                    <QrCode value={instructions.upiLink} label={`UPI code to pay ${amountText} to ${instructions.beneficiaryName}`} className={styles.qr} />
                    <div className={styles.upiText}>
                      <p className={styles.upiLead}>Scan with any UPI app — the amount and the reference are filled in. Check them, then approve with your UPI PIN.</p>
                      <a className={`${shell.action} ${styles.openApp}`} href={instructions.upiLink}>
                        <PhoneIcon className={styles.inlineIcon} />
                        Open UPI app
                      </a>
                      <Detail label="UPI ID" value={instructions.upiId!} />
                      <Detail label="Pays" value={instructions.beneficiaryName} copy={false} />
                    </div>
                  </div>
                ) : (
                  <div className={styles.bank} role="tabpanel">
                    <Detail label="Account name" value={instructions.beneficiaryName} />
                    <Detail label="Account number" value={instructions.accountNumber} mono />
                    <Detail label="IFSC" value={instructions.ifsc} mono />
                    <Detail label="Bank" value={instructions.bankName} copy={false} />
                    <Detail label="Amount" value={plainAmount} shown={amountText} mono />
                    <Detail label="Remarks" value={`INRP2P ${instructions.reference}`} mono />
                    <p className={styles.hint}>
                      <InfoIcon className={styles.inlineIcon} />
                      IMPS reaches us in seconds. Put the remarks exactly as shown{!upiAllowed && Money.parse(payment.upiLimit, 'INR').minor < due.minor ? '; above ₹1,00,000 UPI is not offered' : ''}.
                    </p>
                  </div>
                )}
              </div>
            </li>

            <li className={styles.step}>
              <span className={styles.stepNo} aria-hidden="true">
                3
              </span>
              <div className={styles.stepBody}>
                <h3 className={styles.stepTitle}>Tell us you paid</h3>
                {method === 'BANK' ? (
                  <div className={styles.rails} role="radiogroup" aria-label="Transfer type">
                    {(['IMPS', 'NEFT', 'RTGS'] as const).map((r) => (
                      <label key={r} className={styles.railChoice} data-selected={bankRail === r || undefined}>
                        <input type="radio" name="rail" value={r} checked={bankRail === r} onChange={() => setBankRail(r)} className={styles.radio} />
                        {r}
                      </label>
                    ))}
                  </div>
                ) : null}
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{rail === 'UPI' ? 'UPI reference (UTR)' : `${rail} reference (UTR)`}</span>
                  <input
                    className={`${styles.input} ix-num`}
                    value={utr}
                    onChange={(e) => setUtr(e.target.value.replace(/[^0-9A-Za-z\s]/g, '').toUpperCase())}
                    inputMode={rail === 'UPI' || rail === 'IMPS' ? 'numeric' : 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={26}
                    placeholder={rail === 'UPI' || rail === 'IMPS' ? '12 digits' : rail === 'NEFT' ? '16 characters' : '22 characters'}
                    aria-invalid={shape?.ok === false || undefined}
                    aria-describedby="utr-help"
                  />
                  <span id="utr-help" className={styles.fieldHelp} data-tone={shape?.ok === false ? 'warning' : undefined} aria-live="polite">
                    {shape?.ok === false
                      ? otherRail
                        ? `That looks like a ${otherRail} reference — choose ${otherRail === 'UPI' ? 'UPI' : `Bank transfer · ${otherRail}`}.`
                        : `Not a ${rail} reference yet: ${shape.hint}.`
                      : shape?.ok
                        ? 'Looks right.'
                        : 'Your app shows it once the payment goes through.'}
                  </span>
                </label>
                <details className={styles.where}>
                  <summary>Where do I find it?</summary>
                  <p>
                    In your UPI app, open the payment: the 12-digit reference is called <em>UPI transaction ID</em>, <em>UTR</em> or <em>UPI Ref No.</em> In your bank’s app,
                    open the transfer: IMPS shows a 12-digit reference, NEFT a 16-character UTR.
                  </p>
                </details>
                <label className={styles.confirm}>
                  <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} disabled={!fromAccount} />
                  <span>
                    I paid {amountText} from {fromAccount ? `${fromAccount.bankName} ••${fromAccount.last4}` : 'my account'} — an account in my own name.
                  </span>
                </label>
                <div className={styles.submitRow}>
                  <button type="button" className={shell.action} disabled={!ready} aria-busy={cmd.busy || undefined} onClick={() => void submit()}>
                    <CheckIcon className={styles.inlineIcon} />
                    I’ve paid
                  </button>
                  <span className={styles.muted}>Your USDT goes out once the desk sees the credit from your account.</span>
                </div>
                {cmd.error ? (
                  <p className={shell.error} role="alert">
                    {cmd.error}
                  </p>
                ) : null}
              </div>
            </li>
          </ol>
        </>
      ) : sent || payment.payments.some((p) => p.state === 'CHECKING') ? (
        <div className={styles.checking} role="status">
          <span className={styles.pulse} aria-hidden="true" />
          <p>
            <strong>We’re checking your payment.</strong> The desk confirms the credit and that it came from your account; your USDT follows straight away.
          </p>
        </div>
      ) : null}

      {payment.payments.length > 0 ? (
        <ul className={styles.payments} aria-label="Your payments">
          {payment.payments.map((p) => (
            <li key={p.ref} className={styles.payment} data-state={p.state.toLowerCase()}>
              <span className={styles.paymentMark} aria-hidden="true">
                {p.state === 'CONFIRMED' ? <CheckIcon /> : p.state === 'CHECKING' ? <ClockIcon /> : '!'}
              </span>
              <span className={styles.paymentMain}>
                <span className={styles.paymentAmount}>{formatInr(Money.parse(p.amount, 'INR'))}</span>
                <span className={styles.paymentMeta}>
                  {p.rail} · UTR <span className="ix-num">{maskUtr(p.utr)}</span>
                  {p.from ? ` · from ${p.from.bankName} ••${p.from.last4}` : ''}
                </span>
              </span>
              <span className={styles.paymentState}>
                {STATE_WORDS[p.state]}
                <time dateTime={p.filedAt}>{formatIstDateTime(new Date(p.filedAt)).split(', ')[1]}</time>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {cmd.dialog}
    </section>
  );
}

function Head({ title, timer = null }: { title: string; timer?: React.ReactNode }) {
  return (
    <div className={styles.head}>
      <div className={styles.headText}>
        <span className={styles.badge}>Your move</span>
        <h2 id="pay-title" className={styles.title}>
          {title}
        </h2>
      </div>
      {timer}
    </div>
  );
}

/** One field to copy into a banking app: the value as it must be typed, with a copy button beside it. */
function Detail({ label, value, shown, mono = false, copy = true }: { label: string; value: string; shown?: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className={styles.detail}>
      <span className={styles.detailLabel}>{label}</span>
      <span className={`${styles.detailValue} ${mono ? 'ix-num' : ''}`}>{shown ?? value}</span>
      {copy ? <CopyButton value={value} label={label.toLowerCase()} /> : <span />}
    </div>
  );
}

/** Time left to pay: calm until the last five minutes, amber then; never a flashing alarm. */
function PayTimer({ remaining }: { remaining: number }) {
  const state = remaining <= 0 ? 'over' : remaining <= 5 * 60_000 ? 'soon' : 'calm';
  return (
    <span className={styles.timer} data-state={state} role="timer" aria-live="off">
      <ClockIcon className={styles.inlineIcon} />
      {remaining <= 0 ? 'Time’s up' : <>Pay within <span className="ix-num">{formatCountdown(remaining)}</span></>}
    </span>
  );
}

/** The wall clock, once a second, for the countdown — only while the card is on screen. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return useMemo(() => now, [now]);
}
