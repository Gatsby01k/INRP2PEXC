'use client';

import { useEffect, useMemo, useState } from 'react';
import { type InrRail, Money, checkUtrShape, normalizeUtr, railsForUtr } from '@inrp2p/kernel';
import type { PortalTrade } from '@inrp2p/portal';
import { CopyButton } from '@inrp2p/ui';
import { formatCountdown, formatInr, formatIstDateTime, formatUsdtHeadline, maskUtr } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { claimPaymentAction, confirmReceiptAction } from '../../../../server/actions/client.ts';
import { playSound } from '../../_assistant/sound.ts';
import { BankIcon, CheckIcon, ClockIcon, InfoIcon, LockIcon, ShieldIcon, UserIcon, WalletIcon } from '../../_workspace/icons.tsx';
import shell from '../../shell.module.css';
import pay from './payment.module.css';
import styles from './p2p.module.css';

type Deal = NonNullable<PortalTrade['p2p']>;
type Payment = Deal['payments'][number];

const RAILS: readonly InrRail[] = ['IMPS', 'UPI', 'NEFT', 'RTGS'];

/**
 * A P2P deal (ADR 0019), as its client lives it. The rupees go straight between the client and its counterparty; the
 * USDT waits in INRP2P's escrow until the one who received the rupees says so. So the card always shows where the USDT
 * is — the escrow strip — and then the one thing to do now: pay the seller, or confirm the buyer's rupees arrived.
 *
 * Nothing here counts anything. The payee's confirmation, checked against who its bank says sent the money, is what
 * releases the escrow — on the server, never in this card.
 */
export function P2pDealCard({ view }: { view: PortalTrade }) {
  const deal = view.p2p!;
  const buy = view.trade.direction === 'BUY_USDT';
  const usdt = formatUsdtHeadline(Money.parse(view.trade.base.amount, 'USDT'));
  const inr = formatInr(Money.parse(deal.inr, 'INR'), { fraction: 'always' });
  const now = useNow();
  const remaining = deal.dueBy ? Date.parse(deal.dueBy) - now : null;
  // A seller's own deposit has its card already (the trade's address); this one starts once the USDT is in.
  if (deal.step === 'DONE' || (deal.step === 'CANCELLED' && !deal.escrowReturn) || (!buy && deal.step === 'ESCROW')) return null;

  const timer = remaining !== null ? <StepTimer remaining={remaining} verb={deal.turn === (buy ? 'BUYER' : 'SELLER') ? 'Within' : 'Expected within'} /> : null;
  const yours = (buy && (deal.step === 'PAY')) || (!buy && deal.step === 'CONFIRM');

  return (
    <section className={`${shell.card} ${pay.card} ${styles.card}`} aria-labelledby="deal-title" {...(yours ? { 'data-attention': '' } : {})}>
      <div className={pay.head}>
        <div className={pay.headText}>
          <span className={pay.badge} data-tone={yours ? undefined : 'quiet'}>
            {yours ? 'Your move' : deal.step === 'RELEASE' ? 'Releasing' : 'Escrow'}
          </span>
          <h2 id="deal-title" className={pay.title}>
            {titleOf(deal, buy, usdt, inr)}
          </h2>
        </div>
        {timer}
      </div>

      <EscrowStrip deal={deal} buy={buy} usdt={usdt} />

      {buy && deal.step === 'ESCROW' ? (
        <p className={pay.lead}>
          INRP2P holds the USDT you are buying before you pay anything. As soon as it is in, the seller’s account appears here — you pay them directly, from your own
          account.
        </p>
      ) : null}
      {buy && deal.step === 'PAY' ? <PayTheSeller view={view} deal={deal} inr={inr} /> : null}
      {buy && deal.step === 'CONFIRM' ? (
        <Waiting>
          <strong>The seller is checking your payment.</strong> Once they confirm it arrived from your account, INRP2P releases your {usdt}. If they do not answer in time,
          the desk steps in with your bank’s evidence.
        </Waiting>
      ) : null}

      {!buy && deal.step === 'PAY' ? (
        <Waiting>
          <strong>The buyer is paying you {inr}</strong> to {view.destination}. You will be asked to confirm when they say they have paid. Your USDT stays in escrow until
          you do.
        </Waiting>
      ) : null}
      {!buy && deal.step === 'CONFIRM' ? <ConfirmReceipt view={view} deal={deal} inr={inr} usdt={usdt} /> : null}

      {deal.step === 'RELEASE' ? (
        <Waiting>
          <strong>{buy ? 'Your payment is confirmed.' : 'You confirmed the INR.'}</strong> {buy ? `INRP2P is sending your ${usdt} to your wallet now.` : 'INRP2P is releasing the escrow to the buyer. Nothing more to do.'}
        </Waiting>
      ) : null}

      {deal.step === 'CANCELLED' && deal.escrowReturn ? (
        <p className={pay.lead}>This trade was cancelled before it was paid. The seller’s USDT goes back to them from the escrow; nothing was taken from you.</p>
      ) : null}

      {deal.payments.length > 0 ? <PaymentList payments={deal.payments} buy={buy} /> : null}
    </section>
  );
}

function titleOf(deal: Deal, buy: boolean, usdt: string, inr: string): string {
  switch (deal.step) {
    case 'ESCROW':
      return buy ? `The seller is putting ${usdt} in escrow` : `Send ${usdt} to escrow`;
    case 'PAY':
      return buy ? `Pay ${inr} to the seller` : `The buyer is paying you ${inr}`;
    case 'CONFIRM':
      return buy ? 'The seller is confirming your payment' : `Did ${inr} arrive?`;
    case 'RELEASE':
      return buy ? `Releasing ${usdt} to you` : 'Releasing the escrow';
    default:
      return 'Escrow';
  }
}

/** Where the USDT is, always in view: seller → INRP2P escrow → buyer, the lock between them. */
function EscrowStrip({ deal, buy, usdt }: { deal: Deal; buy: boolean; usdt: string }) {
  const where = deal.step === 'CANCELLED' ? 'returning' : deal.step === 'RELEASE' || deal.step === 'DONE' ? 'released' : deal.escrowFunded ? 'locked' : 'waiting';
  const words = { waiting: 'Not in yet', locked: 'Locked by INRP2P', released: 'Released', returning: 'Going back to the seller' }[where];
  return (
    <ol className={styles.strip} data-state={where} aria-label="Where the USDT is">
      <li className={styles.party}>
        {buy ? <UserIcon className={styles.partyIcon} /> : <WalletIcon className={styles.partyIcon} />}
        <span className={styles.partyLabel}>{buy ? 'Seller' : 'You'}</span>
      </li>
      <li className={styles.vault} aria-current={where === 'locked' ? 'step' : undefined}>
        <span className={styles.vaultIcon}>{where === 'released' ? <CheckIcon /> : <LockIcon />}</span>
        <span className={styles.vaultText}>
          <span className={styles.vaultAmount}>{usdt}</span>
          <span className={styles.vaultState}>{words}</span>
        </span>
      </li>
      <li className={styles.party}>
        {buy ? <WalletIcon className={styles.partyIcon} /> : <UserIcon className={styles.partyIcon} />}
        <span className={styles.partyLabel}>{buy ? 'You' : 'Buyer'}</span>
      </li>
    </ol>
  );
}

/** The buyer's step: the seller's own account, the client's own account, and the bank's reference. */
function PayTheSeller({ view, deal, inr }: { view: PortalTrade; deal: Deal; inr: string }) {
  const cmd = useCommand();
  const accounts = view.payment?.fromAccounts ?? [];
  const [from, setFrom] = useState<string>(accounts.length === 1 ? accounts[0]!.id : '');
  const [rail, setRail] = useState<InrRail>('IMPS');
  const [utr, setUtr] = useState('');
  const [own, setOwn] = useState(false);
  const payee = deal.payTo;
  const shape = utr === '' ? null : checkUtrShape(rail, utr);
  const otherRail = shape && !shape.ok ? railsForUtr(utr).find((r) => r !== rail) : undefined;
  const fromAccount = accounts.find((a) => a.id === from) ?? null;
  const ready = !cmd.busy && fromAccount !== null && shape?.ok === true && own;

  const submit = async () => {
    if (!fromAccount) return;
    const out = await cmd.run(`Payment of ${inr} filed`, (key) => claimPaymentAction({ tradeRef: view.trade.ref, rail, utr: normalizeUtr(utr), fromBankAccountId: fromAccount.id, amount: deal.inr }, key));
    if (out.ok) {
      playSound('success');
      setUtr('');
      setOwn(false);
    }
  };

  if (!payee) {
    return <p className={pay.lead}>The seller’s account is being prepared. This page shows it in a moment.</p>;
  }
  return (
    <>
      <div className={pay.rule}>
        <ShieldIcon className={pay.ruleIcon} />
        <p>
          <strong>Pay from your own account, to exactly this account.</strong> The seller confirms who sent the money from their bank’s screen — rupees from anyone else are
          returned and do not count.
        </p>
      </div>
      <ol className={pay.steps}>
        <li className={pay.step}>
          <span className={pay.stepNo} aria-hidden="true">
            1
          </span>
          <div className={pay.stepBody}>
            <h3 className={pay.stepTitle}>Send {inr} to the seller</h3>
            <div className={pay.bank}>
              <Detail label="Account name" value={payee.holderName} />
              <Detail label="Account number" value={payee.accountNumber} mono />
              <Detail label="IFSC" value={payee.ifsc} mono />
              <Detail label="Bank" value={payee.bankName} copy={false} />
              <Detail label="Amount" value={deal.inr} shown={inr} mono />
              <p className={pay.hint}>
                <InfoIcon className={pay.inlineIcon} />
                Exactly {inr}, in one payment. {payee.rails.length > 0 ? `The seller receives ${payee.rails.join(', ')}.` : ''} IMPS and UPI arrive in seconds.
              </p>
            </div>
          </div>
        </li>
        <li className={pay.step}>
          <span className={pay.stepNo} aria-hidden="true">
            2
          </span>
          <div className={pay.stepBody}>
            <h3 className={pay.stepTitle}>From your account</h3>
            {accounts.length === 0 ? (
              <p className={pay.muted}>No bank account of yours is registered yet. Ask the desk to add one in your name before you pay.</p>
            ) : (
              <div className={pay.accounts} role="radiogroup" aria-label="Your account">
                {accounts.map((a) => (
                  <label key={a.id} className={pay.account} data-selected={from === a.id || undefined}>
                    <input type="radio" name="from" value={a.id} checked={from === a.id} onChange={() => setFrom(a.id)} className={pay.radio} />
                    <BankIcon className={pay.accountIcon} />
                    <span className={pay.accountText}>
                      <span className={pay.accountBank}>
                        {a.bankName} <span className="ix-num">••{a.last4}</span>
                      </span>
                      <span className={pay.accountHolder}>{a.holderName}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </li>
        <li className={pay.step}>
          <span className={pay.stepNo} aria-hidden="true">
            3
          </span>
          <div className={pay.stepBody}>
            <h3 className={pay.stepTitle}>Tell the seller you paid</h3>
            <div className={pay.rails} role="radiogroup" aria-label="How you paid">
              {RAILS.map((r) => (
                <label key={r} className={pay.railChoice} data-selected={rail === r || undefined}>
                  <input type="radio" name="rail" value={r} checked={rail === r} onChange={() => setRail(r)} className={pay.radio} />
                  {r}
                </label>
              ))}
            </div>
            <label className={pay.field}>
              <span className={pay.fieldLabel}>{rail} reference (UTR)</span>
              <input
                className={`${pay.input} ix-num`}
                value={utr}
                onChange={(e) => setUtr(e.target.value.replace(/[^0-9A-Za-z\s]/g, '').toUpperCase())}
                inputMode={rail === 'UPI' || rail === 'IMPS' ? 'numeric' : 'text'}
                autoComplete="off"
                spellCheck={false}
                maxLength={26}
                placeholder={rail === 'UPI' || rail === 'IMPS' ? '12 digits' : rail === 'NEFT' ? '16 characters' : '22 characters'}
                aria-invalid={shape?.ok === false || undefined}
                aria-describedby="p2p-utr-help"
              />
              <span id="p2p-utr-help" className={pay.fieldHelp} data-tone={shape?.ok === false ? 'warning' : undefined} aria-live="polite">
                {shape?.ok === false ? (otherRail ? `That looks like a ${otherRail} reference — choose ${otherRail}.` : `Not a ${rail} reference yet: ${shape.hint}.`) : shape?.ok ? 'Looks right.' : 'Your bank app shows it once the payment goes through.'}
              </span>
            </label>
            <label className={pay.confirm}>
              <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} disabled={!fromAccount} />
              <span>
                I sent {inr} to {payee.holderName} from {fromAccount ? `${fromAccount.bankName} ••${fromAccount.last4}` : 'my account'} — an account in my own name.
              </span>
            </label>
            <div className={pay.submitRow}>
              <button type="button" className={shell.action} disabled={!ready} aria-busy={cmd.busy || undefined} onClick={() => void submit()}>
                <CheckIcon className={pay.inlineIcon} />
                I’ve paid
              </button>
              <span className={pay.muted}>The USDT stays locked for you while the seller checks it.</span>
            </div>
            {cmd.error ? (
              <p className={shell.error} role="alert">
                {cmd.error}
              </p>
            ) : null}
          </div>
        </li>
      </ol>
      {cmd.dialog}
    </>
  );
}

/** The seller's step as a client: did the buyer's rupees arrive — and who does the bank say sent them? */
function ConfirmReceipt({ view, deal, inr, usdt }: { view: PortalTrade; deal: Deal; inr: string; usdt: string }) {
  const cmd = useCommand();
  const filed = deal.payments.filter((p) => p.status === 'PROCESSING').at(-1);
  const [name, setName] = useState('');
  const [arrived, setArrived] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);
  const ready = !cmd.busy && filed !== undefined && name.trim().length >= 2 && arrived;

  const submit = async () => {
    if (!filed) return;
    const out = await cmd.run(`Confirm ${inr} received`, (key) => confirmReceiptAction({ tradeRef: view.trade.ref, legRef: filed.ref, senderName: name.trim() }, key));
    if (out.ok) {
      setVerdict(out.result.verdict);
      if (out.result.confirmed) playSound('success');
    }
  };

  if (!filed) return null;
  return (
    <>
      <div className={styles.claim}>
        <span className={styles.claimLabel}>The buyer says they paid</span>
        <span className={styles.claimAmount}>{formatInr(Money.parse(filed.amount, 'INR'), { fraction: 'always' })}</span>
        <span className={styles.claimMeta}>
          {filed.rail} · UTR <span className="ix-num">{filed.utr}</span> · to {view.destination} · {formatIstDateTime(new Date(filed.filedAt)).split(', ')[1]}
        </span>
        {filed.utr ? <CopyButton value={filed.utr} label="UTR" /> : null}
      </div>
      <div className={pay.rule} data-tone="warning">
        <ShieldIcon className={pay.ruleIcon} />
        <p>
          <strong>Open your bank app first.</strong> Confirm only once {inr} is in your account — confirming releases {usdt} to the buyer and cannot be undone. Not there
          yet? Don’t confirm: if it doesn’t arrive, the desk is told automatically.
        </p>
      </div>
      {verdict && verdict !== 'MATCH' ? (
        <p className={pay.alert} role="alert">
          <ShieldIcon className={pay.alertIcon} />
          <span>
            {verdict === 'PARTIAL' ? (
              <>
                <strong>That name is close to the buyer’s, but not the same.</strong> The desk checks it and tells you; the escrow stays locked meanwhile.
              </>
            ) : (
              <>
                <strong>That is not the buyer’s registered account.</strong> Don’t spend this money — it is returned to whoever sent it. The desk has been told; the escrow
                stays locked.
              </>
            )}
          </span>
        </p>
      ) : null}
      <label className={pay.field}>
        <span className={pay.fieldLabel}>Sender’s name, as your bank shows it</span>
        <input className={pay.input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} maxLength={140} placeholder="e.g. RAHUL KUMAR SHARMA" />
        <span className={pay.fieldHelp}>In the transaction’s details: “From”, “Remitter” or “Sender”. Type it as it is, not as you expect it.</span>
      </label>
      <label className={pay.confirm}>
        <input type="checkbox" checked={arrived} onChange={(e) => setArrived(e.target.checked)} />
        <span>
          I see {inr} credited to {view.destination} in my bank app.
        </span>
      </label>
      <div className={pay.submitRow}>
        <button type="button" className={shell.action} disabled={!ready} aria-busy={cmd.busy || undefined} onClick={() => void submit()}>
          <CheckIcon className={pay.inlineIcon} />
          Release the escrow
        </button>
        <span className={pay.muted}>Only the buyer’s own account counts.</span>
      </div>
      {cmd.error ? (
        <p className={shell.error} role="alert">
          {cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </>
  );
}

const PAYMENT_WORDS: Record<string, string> = { PROCESSING: 'Waiting for confirmation', COMPLETED: 'Confirmed', FAILED: 'Not received', CANCELLED: 'Cancelled' };

function PaymentList({ payments, buy }: { payments: readonly Payment[]; buy: boolean }) {
  return (
    <ul className={pay.payments} aria-label={buy ? 'Your payments' : 'Payments to you'}>
      {payments.map((p) => {
        const state = p.verdict === 'MISMATCH' ? 'returning' : p.status === 'COMPLETED' ? 'confirmed' : p.status === 'FAILED' ? 'not_received' : 'checking';
        return (
          <li key={p.ref} className={pay.payment} data-state={state}>
            <span className={pay.paymentMark} aria-hidden="true">
              {state === 'confirmed' ? <CheckIcon /> : state === 'checking' ? <ClockIcon /> : '!'}
            </span>
            <span className={pay.paymentMain}>
              <span className={pay.paymentAmount}>{formatInr(Money.parse(p.amount, 'INR'))}</span>
              <span className={pay.paymentMeta}>
                {p.rail ?? '—'}
                {p.utr ? (
                  <>
                    {' '}
                    · UTR <span className="ix-num">{maskUtr(p.utr)}</span>
                  </>
                ) : null}
              </span>
            </span>
            <span className={pay.paymentState}>
              {state === 'returning' ? 'Not the registered account — returned' : (PAYMENT_WORDS[p.status] ?? p.status)}
              <time dateTime={p.filedAt}>{formatIstDateTime(new Date(p.filedAt)).split(', ')[1]}</time>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <div className={pay.checking} role="status">
      <span className={pay.pulse} aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}

function Detail({ label, value, shown, mono = false, copy = true }: { label: string; value: string; shown?: string; mono?: boolean; copy?: boolean }) {
  return (
    <div className={pay.detail}>
      <span className={pay.detailLabel}>{label}</span>
      <span className={`${pay.detailValue} ${mono ? 'ix-num' : ''}`}>{shown ?? value}</span>
      {copy ? <CopyButton value={value} label={label.toLowerCase()} /> : <span />}
    </div>
  );
}

/** Time left for the step: calm until the last five minutes, amber then; never a flashing alarm. */
function StepTimer({ remaining, verb }: { remaining: number; verb: string }) {
  const state = remaining <= 0 ? 'over' : remaining <= 5 * 60_000 ? 'soon' : 'calm';
  return (
    <span className={pay.timer} data-state={state} role="timer" aria-live="off">
      <ClockIcon className={pay.inlineIcon} />
      {remaining <= 0 ? 'Time’s up' : <>{verb} <span className="ix-num">{formatCountdown(remaining)}</span></>}
    </span>
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return useMemo(() => now, [now]);
}
