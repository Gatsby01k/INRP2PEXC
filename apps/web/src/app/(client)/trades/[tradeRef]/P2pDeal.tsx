'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { PortalTrade } from '@inrp2p/portal';
import { CopyButton } from '@inrp2p/ui';
import { formatCountdown, formatInr, formatIstDateTime, formatUsdtHeadline, maskUtr } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import {
  answerDisputeAction, callSupportAction, choosePayMethodAction, claimPaymentAction, confirmReceiptAction, openDisputeAction, postDealMessageAction, reportPayeeNameAction,
} from '../../../../server/actions/client.ts';
import { DealChat } from '../../_workspace/DealChat.tsx';
import { PayInr } from '../../_workspace/PayInr.tsx';
import { AddYourSide, DisputeUnderReview, NotArrived } from '../../_workspace/P2pDispute.tsx';
import { ClaimProof } from '../../_workspace/ClaimProof.tsx';
import { playSound } from '../../_assistant/sound.ts';
import { useServerClock } from '../../exchange/useServerClock.ts';
import { CheckIcon, ClockIcon, LockIcon, ShieldIcon, UserIcon, WalletIcon } from '../../_workspace/icons.tsx';
import shell from '../../shell.module.css';
import pay from './payment.module.css';
import styles from './p2p.module.css';

type Deal = NonNullable<PortalTrade['p2p']>;
type Payment = Deal['payments'][number];

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
  const now = useServerClock(deal.now, deal.dueBy !== null);
  const remaining = deal.dueBy ? Date.parse(deal.dueBy) - now : null;
  const disputed = deal.dispute?.status === 'OPEN';
  const decidedUnpaid = deal.dispute?.status === 'NOT_PAID';
  // A seller's own deposit has its card already (the trade's address); this one starts once the USDT is in.
  if (deal.step === 'DONE' || (deal.step === 'CANCELLED' && !deal.escrowReturn && !deal.unwind && !decidedUnpaid) || (!buy && deal.step === 'ESCROW')) return null;

  const final = deal.step === 'PAY' && deal.payWindow?.final === true;
  const timer = remaining !== null ? <StepTimer remaining={remaining} verb={final ? 'Final' : deal.turn === (buy ? 'BUYER' : 'SELLER') ? 'Within' : 'Expected within'} final={final} /> : null;
  const method = deal.payWindow?.method ?? deal.payments.at(-1)?.rail ?? null;
  const yours = !disputed && ((buy && deal.step === 'PAY') || (!buy && deal.step === 'CONFIRM'));

  return (
    <section className={`${shell.card} ${pay.card} ${styles.card}`} aria-labelledby="deal-title" {...(yours ? { 'data-attention': '' } : {})}>
      <div className={yours ? `${pay.head} ${shell.cap}` : pay.head}>
        <div className={pay.headText}>
          <span className={pay.badge} data-tone={yours ? undefined : 'quiet'}>
            {disputed ? 'With INRP2P' : yours ? 'Your move' : deal.step === 'RELEASE' ? 'Releasing' : deal.step === 'REFUND' ? 'Refund' : 'Escrow'}
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
      {buy && deal.step === 'PAY' ? (
        <PayInr
          deal={deal}
          fromAccounts={view.fromAccounts}
          attachFields={{ tradeRef: view.trade.ref }}
          choose={(m, key) => choosePayMethodAction({ tradeRef: view.trade.ref, method: m }, key)}
          claim={(input, key) =>
            claimPaymentAction({
              tradeRef: view.trade.ref, rail: input.rail, utr: input.utr, amount: deal.inr, payeeNameConfirmed: input.payeeNameConfirmed,
              ...(input.from?.kind === 'UPI' ? { fromUpiId: input.from.id } : { fromBankAccountId: input.from?.id ?? '' }),
            }, key)
          }
          report={(shownName, key) => reportPayeeNameAction({ tradeRef: view.trade.ref, shownName }, key)}
          attach={postDealMessageAction}
        />
      ) : null}
      {buy && deal.step === 'CONFIRM' && disputed ? <BuyerSide view={view} deal={deal} inr={inr} /> : null}
      {buy && deal.step === 'CONFIRM' && !disputed ? (
        <Waiting>
          {deal.receiptLate ? (
            <>
              <strong>The seller has not confirmed your payment yet.</strong> {method === 'NEFT' || method === 'RTGS' ? `${method} can take longer. ` : ''}INRP2P is checking it with
              the seller. Nothing is cancelled for a bank’s delay — your {usdt} stays locked for you.
            </>
          ) : (
            <>
              <strong>The seller is checking your payment.</strong> Once they confirm it arrived from your account, INRP2P releases your {usdt}.{' '}
              {method === 'NEFT' ? 'A NEFT payment can take an hour or two to land.' : method === 'RTGS' ? 'An RTGS payment usually lands within half an hour.' : ''}
            </>
          )}
        </Waiting>
      ) : null}

      {!buy && deal.step === 'PAY' ? (
        <Waiting>
          {final ? (
            <>
              <strong>The buyer’s time to pay is up.</strong> If they do not file their payment in the final minutes, this trade is cancelled and your {usdt} comes back to
              the wallet you sent it from.
            </>
          ) : (
            <>
              <strong>The buyer is paying you {inr}</strong>
              {method ? ` by ${method}` : ''} to {view.destination}. You will be asked to confirm when they say they have paid. Your USDT stays in escrow until you do.
            </>
          )}
        </Waiting>
      ) : null}
      {!buy && deal.step === 'CONFIRM' && !disputed ? (
        <>
          {deal.receiptLate ? (
            <p className={pay.overdue} role="status">
              <ClockIcon className={pay.inlineIcon} />
              <span>
                <strong>Longer than usual{method ? ` for ${method}` : ''}.</strong> Check your bank app. If the money is not there, say so below — INRP2P is following it up.
              </span>
            </p>
          ) : null}
          <ConfirmReceipt view={view} deal={deal} inr={inr} usdt={usdt} />
          <SellerNotArrived view={view} inr={inr} />
        </>
      ) : null}
      {!buy && deal.step === 'CONFIRM' && disputed ? (
        <DisputeUnderReview dispute={deal.dispute!}>
          <ConfirmReceipt view={view} deal={deal} inr={inr} usdt={usdt} />
        </DisputeUnderReview>
      ) : null}

      {deal.step === 'REFUND' && deal.unwind ? <RefundState unwind={deal.unwind} usdt={usdt} /> : null}
      {deal.step === 'CANCELLED' && deal.unwind ? (
        <p className={pay.lead}>
          {deal.unwind.reason === 'NOT_PAID' ? 'INRP2P found the buyer’s payment did not arrive.' : 'The buyer did not pay in time.'} Your {formatUsdtHeadline(Money.parse(deal.unwind.amount, 'USDT'))}{' '}
          went back to the wallet you sent it from; nothing of yours was kept.
        </p>
      ) : null}

      {deal.step === 'RELEASE' ? (
        <Waiting>
          <strong>{buy ? 'Your payment is confirmed.' : 'You confirmed the INR.'}</strong> {buy ? `INRP2P is sending your ${usdt} to your wallet now.` : 'INRP2P is releasing the escrow to the buyer. Nothing more to do.'}
        </Waiting>
      ) : null}

      {deal.step === 'CANCELLED' && buy && decidedUnpaid ? (
        <p className={pay.lead}>
          INRP2P found your {inr} did not reach the seller, so this trade is cancelled and the seller’s USDT went back to them. Do not pay again for it. If money left your account,
          write to INRP2P with your bank statement.
        </p>
      ) : deal.step === 'CANCELLED' && deal.escrowReturn ? (
        <p className={pay.lead}>This trade was cancelled before it was paid. The seller’s USDT goes back to them from the escrow; nothing was taken from you.</p>
      ) : null}

      {deal.payments.length > 0 ? <PaymentList payments={deal.payments} buy={buy} /> : null}
    </section>
  );
}

/** The deal's chat (ADR 0023), under the deal's card: there from the start, and kept after the deal closes. */
export function P2pDealChat({ view }: { view: PortalTrade }) {
  const deal = view.p2p!;
  return <DealChat chat={deal.chat} fields={{ tradeRef: view.trade.ref }} send={postDealMessageAction} callSupport={(note, key) => callSupportAction({ tradeRef: view.trade.ref, note }, key)} />;
}

function titleOf(deal: Deal, buy: boolean, usdt: string, inr: string): string {
  if (deal.dispute?.status === 'OPEN') return buy ? `The seller says your ${inr} has not arrived` : `You said ${inr} has not arrived`;
  switch (deal.step) {
    case 'ESCROW':
      return buy ? `The seller is putting ${usdt} in escrow` : `Send ${usdt} to escrow`;
    case 'PAY':
      return buy ? `Pay ${inr} to the seller` : `The buyer is paying you ${inr}`;
    case 'CONFIRM':
      return buy ? 'The seller is confirming your payment' : `Did ${inr} arrive?`;
    case 'RELEASE':
      return buy ? `Releasing ${usdt} to you` : 'Releasing the escrow';
    case 'REFUND':
      return 'Back to the wallet you sent it from';
    case 'CANCELLED':
      return deal.unwind ? `Your ${usdt} went back to you` : 'Cancelled';
    default:
      return 'Escrow';
  }
}

/** Where the USDT is, always in view: seller → INRP2P escrow → buyer, the lock between them. */
function EscrowStrip({ deal, buy, usdt }: { deal: Deal; buy: boolean; usdt: string }) {
  const where = deal.step === 'CANCELLED' || deal.step === 'REFUND' ? 'returning' : deal.step === 'RELEASE' || deal.step === 'DONE' ? 'released' : deal.escrowFunded ? 'locked' : 'waiting';
  const words = { waiting: 'Not in yet', locked: 'Locked by INRP2P', released: 'Released', returning: buy ? 'Going back to the seller' : deal.unwind?.status === 'SENT' ? 'Back with you' : 'Going back to you' }[where];
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
      <ClaimProof chat={deal.chat} paymentRef={filed.ref} />
      <div className={pay.rule} data-tone="warning">
        <ShieldIcon className={pay.ruleIcon} />
        <p>
          <strong>Open your bank app first.</strong> Confirm only once {inr} is in your account — confirming releases {usdt} to the buyer and cannot be undone. Not there
          yet? Don’t confirm — give it a few minutes, or tell INRP2P below.
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

/** The seller's "it hasn't arrived": the deal stops and INRP2P decides from the seller's bank. */
function SellerNotArrived({ view, inr }: { view: PortalTrade; inr: string }) {
  const cmd = useCommand();
  return (
    <>
      <NotArrived
        inr={inr}
        busy={cmd.busy}
        onSubmit={async (reason, note) => {
          const out = await cmd.run(`Tell INRP2P ${inr} has not arrived`, (key) => openDisputeAction({ tradeRef: view.trade.ref, reason, note }, key));
          return out.ok ? { ok: true } : { ok: false, error: out.message };
        }}
      />
      {cmd.dialog}
    </>
  );
}

/** The buyer's side of the seller's dispute, for INRP2P. */
function BuyerSide({ view, deal, inr }: { view: PortalTrade; deal: Deal; inr: string }) {
  const cmd = useCommand();
  return (
    <>
      <AddYourSide
        dispute={deal.dispute!}
        inr={inr}
        busy={cmd.busy}
        onSubmit={async (note) => {
          const out = await cmd.run('Send your details to INRP2P', (key) => answerDisputeAction({ tradeRef: view.trade.ref, note }, key));
          return out.ok ? { ok: true } : { ok: false, error: out.message };
        }}
      />
      {cmd.dialog}
    </>
  );
}

/** The client's USDT on its way back from the escrow of a deal its buyer did not pay. */
function RefundState({ unwind, usdt }: { unwind: NonNullable<Deal['unwind']>; usdt: string }) {
  const why = unwind.reason === 'NOT_PAID' ? 'INRP2P found the buyer’s payment did not arrive.' : 'The buyer did not pay in time.';
  return (
    <Waiting>
      <strong>{why}</strong>{' '}
      {unwind.status === 'SENDING'
        ? `Your ${usdt} is on its way back to the wallet you sent it from.`
        : unwind.status === 'SENT'
          ? `Your ${usdt} is back in the wallet you sent it from.`
          : `INRP2P is sending your ${usdt} back to the wallet you sent it from. Nothing to do.`}
    </Waiting>
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

/**
 * A seller's own deposit into the escrow (a client selling USDT): its time, on the deposit card. The price holds for this
 * window, not for ever — after it the deal is cancelled, and USDT that still arrives goes back.
 */
export function DepositTimer({ deal }: { deal: Deal }) {
  const now = useServerClock(deal.now, deal.dueBy !== null);
  if (deal.step !== 'ESCROW' || !deal.dueBy) return null;
  return <StepTimer remaining={Date.parse(deal.dueBy) - now} verb="Send within" />;
}

/** Time left for the step: calm until the last five minutes, amber then (and through a final period); never a flashing alarm. */
function StepTimer({ remaining, verb, final = false }: { remaining: number; verb: string; final?: boolean }) {
  const state = remaining <= 0 ? 'over' : final || remaining <= 5 * 60_000 ? 'soon' : 'calm';
  return (
    <span className={pay.timer} data-state={state} role="timer" aria-live="off">
      <ClockIcon className={pay.inlineIcon} />
      {remaining <= 0 ? 'Time’s up' : <>{verb} <span className="ix-num">{formatCountdown(remaining)}</span></>}
    </span>
  );
}
