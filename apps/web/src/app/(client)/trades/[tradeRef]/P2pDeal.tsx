'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { PortalTrade } from '@inrp2p/portal';
import { CopyButton } from '@inrp2p/ui';
import { Amount } from '../../../../components/Amount.tsx';
import { BankMark, RailMark } from '../../../../components/PayMarks.tsx';
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
import { RobotSays } from '../../_robot/RobotSays.tsx';
import { payerNameSpeech } from '../../_robot/speech.ts';
import { FieldHalo } from '../../_workspace/FieldHalo.tsx';
import { Hint } from '../../_workspace/Hint.tsx';
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
export function P2pDealCard({ view, staged = false }: { view: PortalTrade; staged?: boolean }) {
  const deal = view.p2p!;
  const buy = view.trade.direction === 'BUY_USDT';
  const usdt = formatUsdtHeadline(Money.parse(view.trade.base.amount, 'USDT'));
  const inr = formatInr(Money.parse(deal.inr, 'INR'), { fraction: 'always' });
  const now = useServerClock(deal.now, deal.dueBy !== null);
  const remaining = deal.dueBy ? Date.parse(deal.dueBy) - now : null;
  const disputed = deal.dispute?.status === 'OPEN';
  const decidedUnpaid = deal.dispute?.status === 'NOT_PAID';
  const [reporting, setReporting] = useState(false);
  // A seller's own deposit has its card already (the trade's address); this one starts once the USDT is in.
  if (deal.step === 'DONE' || (deal.step === 'CANCELLED' && !deal.escrowReturn && !deal.unwind && !decidedUnpaid) || (!buy && deal.step === 'ESCROW')) return null;

  const final = deal.step === 'PAY' && deal.payWindow?.final === true;
  // How much of the step's time is left, for the ring: from when the buyer said it paid to the confirm deadline.
  const filedAt = deal.step === 'CONFIRM' ? deal.payments.findLast((p) => p.status === 'PROCESSING')?.filedAt : undefined;
  const share = remaining !== null && filedAt && deal.dueBy ? remaining / Math.max(1, Date.parse(deal.dueBy) - Date.parse(filedAt)) : 1;
  const yoursNow = !disputed && ((buy && deal.step === 'PAY') || (!buy && deal.step === 'CONFIRM'));
  const timer =
    remaining !== null ? (
      <StepTimer remaining={remaining} verb={final ? 'Final' : deal.turn === (buy ? 'BUYER' : 'SELLER') ? 'Within' : 'Expected within'} final={final} ring={yoursNow} share={share} />
    ) : null;
  // Where the deal is, as the journey counts it: the stop being waited on, of the four.
  const stop = Math.max(1, view.stages.findIndex((s) => s.status === 'current') + 1);
  const method = deal.payWindow?.method ?? deal.payments.at(-1)?.rail ?? null;
  const yours = !disputed && ((buy && deal.step === 'PAY') || (!buy && deal.step === 'CONFIRM'));

  // Under the deal's stage (`DealStage`) the card is only the move's sheet: the stage already says whose move, the figure,
  // the time and where the USDT is — so the card carries the form, the dispute and the payments, or nothing at all.
  if (staged) {
    const form = (buy && deal.step === 'PAY') || deal.step === 'CONFIRM';
    const list = deal.payments.length > 0 && !(!buy && deal.step === 'CONFIRM');
    if (!form && !list) return null;
    return (
      <section className={`${shell.card} ${pay.card} ${styles.card} ${styles.sheet}`} aria-label={yours ? 'Your move' : 'Payments'} {...(yours ? { 'data-attention': '' } : {})}>
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
        {!buy && deal.step === 'CONFIRM' && !disputed ? (
          <>
            <ConfirmReceipt view={view} deal={deal} inr={inr} usdt={usdt} now={now} late={deal.receiptLate ? (method ?? 'this rail') : null} onNotArrived={() => setReporting(true)} compact />
            <SellerNotArrived view={view} inr={inr} open={reporting} onOpenChange={setReporting} />
          </>
        ) : null}
        {!buy && deal.step === 'CONFIRM' && disputed ? (
          <DisputeUnderReview dispute={deal.dispute!}>
            <ConfirmReceipt view={view} deal={deal} inr={inr} usdt={usdt} now={now} late={null} onNotArrived={() => setReporting(true)} compact />
          </DisputeUnderReview>
        ) : null}
        {list ? <PaymentList payments={deal.payments} buy={buy} /> : null}
      </section>
    );
  }

  return (
    <section className={`${shell.card} ${pay.card} ${styles.card}`} aria-labelledby="deal-title" {...(yours ? { 'data-attention': '' } : {})}>
      <div className={yours ? `${pay.head} ${shell.cap}` : pay.head}>
        {yours ? <FieldHalo /> : null}
        <div className={pay.headText}>
          <span className={pay.badge} data-tone={yours ? undefined : 'quiet'}>
            {disputed ? 'With INRP2P' : yours ? `Your move · step ${stop} of ${view.stages.length}` : deal.step === 'RELEASE' ? 'Releasing' : deal.step === 'REFUND' ? 'Refund' : 'Escrow'}
          </span>
          <h2 id="deal-title" className={pay.title}>
            {titleOf(deal, buy, usdt, inr)}
          </h2>
          {yours && !buy && deal.step === 'CONFIRM' ? (
            <p className={pay.capSub}>
              Open your bank app first. Releasing <span className={styles.wide}>sends {usdt} to the buyer and </span>cannot be undone.
            </p>
          ) : null}
        </div>
        {timer}
      </div>

      {yours && !buy && deal.step === 'CONFIRM' ? null : <EscrowStrip deal={deal} buy={buy} usdt={usdt} />}

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
              <strong>Not confirmed yet.</strong> {method === 'NEFT' || method === 'RTGS' ? `${method} can take longer. ` : ''}INRP2P is on it — your {usdt} stays locked for
              you.
            </>
          ) : (
            <>
              <strong>The seller is checking their bank.</strong> Your {usdt} is released the moment they confirm.{' '}
              {method === 'NEFT' ? 'NEFT can take an hour or two.' : method === 'RTGS' ? 'RTGS usually lands within half an hour.' : ''}
            </>
          )}
        </Waiting>
      ) : null}

      {!buy && deal.step === 'PAY' ? (
        <Waiting>
          {final ? (
            <>
              <strong>The buyer’s time is up.</strong> No payment filed soon, and your {usdt} comes back to your wallet.
            </>
          ) : (
            <>
              <strong>The buyer is paying you {inr}</strong>
              {method ? ` by ${method}` : ''} to {view.destination}. Your USDT stays in escrow until you confirm.
            </>
          )}
        </Waiting>
      ) : null}
      {!buy && deal.step === 'CONFIRM' && !disputed ? (
        <>
          <ConfirmReceipt
            view={view}
            deal={deal}
            inr={inr}
            usdt={usdt}
            now={now}
            late={deal.receiptLate ? (method ?? 'this rail') : null}
            onNotArrived={() => setReporting(true)}
          />
          <SellerNotArrived view={view} inr={inr} open={reporting} onOpenChange={setReporting} />
        </>
      ) : null}
      {!buy && deal.step === 'CONFIRM' && disputed ? (
        <DisputeUnderReview dispute={deal.dispute!}>
          <ConfirmReceipt view={view} deal={deal} inr={inr} usdt={usdt} now={now} late={null} onNotArrived={() => setReporting(true)} />
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

      {/* While the seller checks a claim, the claim itself is the payment shown; otherwise the deal's payments, in order. */}
      {deal.payments.length > 0 && !(!buy && deal.step === 'CONFIRM') ? <PaymentList payments={deal.payments} buy={buy} /> : null}
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
function ConfirmReceipt({
  view,
  deal,
  inr,
  usdt,
  now,
  late,
  onNotArrived,
  compact = false,
}: {
  view: PortalTrade;
  deal: Deal;
  inr: string;
  usdt: string;
  now: number;
  /** The rail whose usual time is over, when it is: said beside the buttons, quietly. */
  late: string | null;
  onNotArrived: () => void;
  /** Under the deal's stage, which already shows the amount and the rail: the claim's facts only. */
  compact?: boolean;
}) {
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
  const minutes = Math.max(0, Math.floor((now - Date.parse(filed.filedAt)) / 60_000));
  return (
    <>
      {/* What the buyer says it sent: the figure, the rail and when, and beside it what the bank must show. */}
      <div className={styles.claim} data-compact={compact || undefined}>
        <div className={styles.claimMain}>
          <span className={styles.claimLabel}>The buyer says they paid</span>
          <span className={styles.claimAmount}>
            <Amount value={formatInr(Money.parse(filed.amount, 'INR'), { fraction: 'always' })} />
          </span>
          <span className={styles.claimMeta}>
            {filed.rail ? <RailMark rail={filed.rail} /> : null}
            <span className={styles.claimWhen}>
              {formatIstDateTime(new Date(filed.filedAt)).split(', ')[1]} · {minutes < 1 ? 'just now' : `${minutes} min ago`}
            </span>
          </span>
        </div>
        <dl className={styles.claimFacts}>
          {filed.utr ? (
            <div>
              <dt>UTR</dt>
              <dd>
                <span className={styles.mono}>{filed.utr}</span>
                <CopyButton value={filed.utr} label="UTR" />
              </dd>
            </div>
          ) : null}
          <div>
            <dt>
              To<span className={styles.wide}> your account</span>
            </dt>
            <dd>
              <AccountTile destination={view.destination} />
            </dd>
          </div>
          <div className={styles.wide}>
            <dt>Counts only from</dt>
            <dd>the buyer’s own account</dd>
          </div>
        </dl>
      </div>
      <ClaimProof chat={deal.chat} paymentRef={filed.ref} />
      {/* ADR 0030's payer check, said by the robot: what the name means, and what to do — never what INRP2P decides. */}
      {verdict && payerNameSpeech(verdict) ? (
        <div role="alert">
          <RobotSays speech={payerNameSpeech(verdict)!} variant="sheet" live={false} />
        </div>
      ) : null}
      <div className={styles.nameRow}>
        <label className={pay.field}>
          <span className={pay.fieldLabel}>Sender’s name, as your bank shows it</span>
          <input className={pay.input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} maxLength={140} placeholder="e.g. RAHUL KUMAR SHARMA" />
        </label>
        {/* Where to find it, one tap away — outside the label, so the label names only its field. */}
        <span className={styles.nameHint}>
          <Hint label="Where to find the sender’s name">
            In the transfer’s details: <b>From</b>, <b>Remitter</b> or <b>Sender</b>. Type it as it is, not as you expect it. Not there yet? Don’t confirm.
          </Hint>
        </span>
      </div>
      <label className={pay.confirm}>
        <input type="checkbox" checked={arrived} onChange={(e) => setArrived(e.target.checked)} />
        <span>
          I see {inr} credited to {view.destination} in my bank app.
        </span>
      </label>
      {/* On a phone the escrow's state is one line above the docked buttons, as the bar has no room for the strip. */}
      <p className={styles.escrowLine}>
        <LockIcon />
        {usdt} locked in INRP2P escrow
      </p>
      <div className={pay.submitRow} data-size="lg">
        <button type="button" className={shell.action} disabled={!ready} aria-busy={cmd.busy || undefined} onClick={() => void submit()}>
          <LockIcon className={pay.inlineIcon} />
          Release {usdt}
        </button>
        <button type="button" className={shell.secondaryAction} onClick={onNotArrived}>
          <span className={styles.wide}>It hasn’t arrived</span>
          <span className={styles.narrow}>Not yet</span>
        </button>
        {late ? (
          <span className={styles.lateNote} role="status">
            <ClockIcon />
            <span>
              <strong>Longer than usual for {late}</strong> — INRP2P is following it up. Releasing sends {usdt} and cannot be undone.
            </span>
          </span>
        ) : (
          <span className={styles.lateNote}>
            <ShieldIcon />
            <span>Only the buyer’s own account counts.</span>
          </span>
        )}
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

/** "HDFC Bank •••• 8219" as the mock-up sets it: the bank's own small tile, then its name and the account's last digits. */
function AccountTile({ destination }: { destination: string }) {
  const m = /^(.*?)\s*(•+\s*\d{3,4})$/.exec(destination);
  if (!m) return <>{destination}</>;
  return (
    <span className={styles.accountTile}>
      <BankMark ifsc="" name={m[1]!} size={24} />
      {m[1]!.replace(/ Bank$/, '')} {m[2]}
    </span>
  );
}

function SellerNotArrived({ view, inr, open, onOpenChange }: { view: PortalTrade; inr: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const cmd = useCommand();
  return (
    <>
      <NotArrived
        inr={inr}
        busy={cmd.busy}
        open={open}
        onOpenChange={onOpenChange}
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

/** Time left for the step: calm until the last five minutes, amber then (and through a final period); never a flashing alarm. */
function StepTimer({ remaining, verb, final = false, ring = false, share = 1 }: { remaining: number; verb: string; final?: boolean; ring?: boolean; share?: number }) {
  const state = remaining <= 0 ? 'over' : final || remaining <= 5 * 60_000 ? 'soon' : 'calm';
  if (ring) {
    // In the field the time is a display: the robot's visor as a disc, the time lit, what it is under it.
    return (
      <span className={pay.ringTimer} data-state={state} role="timer" aria-live="off">
        <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
          <circle className={pay.ringTrack} cx="50" cy="50" r="43" />
          <circle className={pay.ringArc} cx="50" cy="50" r="43" strokeDasharray="270.2" strokeDashoffset={remaining <= 0 ? 270.2 : 270.2 * (1 - Math.min(1, Math.max(0.04, share)))} />
        </svg>
        <span className={pay.ringText}>
          <b>{remaining <= 0 ? '0:00' : formatCountdown(remaining)}</b>
          <small>{remaining <= 0 ? 'Time’s up' : verb === 'Final' ? 'final' : 'left'}</small>
        </span>
        <span className="ix-visually-hidden">{remaining <= 0 ? 'Time’s up' : `${verb} ${formatCountdown(remaining)}`}</span>
      </span>
    );
  }
  return (
    <span className={pay.timer} data-state={state} role="timer" aria-live="off">
      <ClockIcon className={pay.inlineIcon} />
      {remaining <= 0 ? 'Time’s up' : <>{verb} <span className="ix-num">{formatCountdown(remaining)}</span></>}
    </span>
  );
}
