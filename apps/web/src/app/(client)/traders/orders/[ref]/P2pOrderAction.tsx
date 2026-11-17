'use client';

import { useState } from 'react';
import { Money } from '@inrp2p/kernel';
import type { TraderOrderDetail } from '@inrp2p/traders';
import { CopyButton, DepositAddress } from '@inrp2p/ui';
import { formatCountdown, formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../../components/useCommand.tsx';
import {
  answerOrderDisputeAction, callOrderSupportAction, chooseOrderMethodAction, confirmOrderPaymentReceivedAction, disputeOrderPaymentAction, orderDeliveryAddressAction,
  postOrderMessageAction, reportOrderPayeeNameAction, submitOrderPaymentAction,
} from '../../../../../server/actions/traders.ts';
import { ClaimProof } from '../../../_workspace/ClaimProof.tsx';
import { DealChat } from '../../../_workspace/DealChat.tsx';
import { PayInr } from '../../../_workspace/PayInr.tsx';
import { AddYourSide, DisputeUnderReview, NotArrived } from '../../../_workspace/P2pDispute.tsx';
import { useServerClock } from '../../../exchange/useServerClock.ts';
import { ClockIcon, InfoIcon, LockIcon, ShieldIcon } from '../../../_workspace/icons.tsx';
import { inr, sentence, usdt } from '../../_ui/format.ts';
import shell from '../../../shell.module.css';
import styles from '../../traders.module.css';
import pay from '../../../trades/[tradeRef]/payment.module.css';

type Deal = NonNullable<TraderOrderDetail['p2p']>;

/**
 * A P2P order's "what happens now" (ADR 0019), from the trader's side. Selling USDT: put it in the deal's escrow, wait
 * for the buyer's rupees, confirm they reached your own account. Buying: wait for the seller's USDT in escrow, pay the
 * seller's account straight from yours, and the seller confirms. The other side is "the buyer" or "the seller" — the
 * only thing the trader learns of it is the account it must pay.
 */
export function P2pOrderAction({ detail, canAct }: { detail: TraderOrderDetail; canAct: boolean }) {
  const deal = detail.p2p!;
  const o = detail.order;
  const sells = o.side === 'SELL_USDT';
  const now = useServerClock(deal.now, deal.dueBy !== null);
  const remaining = deal.dueBy ? Date.parse(deal.dueBy) - now : null;
  const disputed = deal.dispute?.status === 'OPEN';
  const final = deal.step === 'PAY' && deal.payWindow?.final === true;
  const method = deal.payWindow?.method ?? deal.payments.at(-1)?.rail ?? null;
  const yours = !disputed && ((sells && (deal.step === 'ESCROW' || deal.step === 'CONFIRM')) || (!sells && deal.step === 'PAY'));

  const title = (() => {
    if (disputed) return sells ? `You said ${inr(deal.inr)} has not arrived` : `The seller says your ${inr(deal.inr)} has not arrived`;
    switch (deal.step) {
      case 'ESCROW':
        return sells ? `Put ${usdt(o.usdt)} in escrow` : 'Waiting for the seller’s USDT';
      case 'PAY':
        return sells ? `The buyer is paying you ${inr(deal.inr)}` : `Pay ${inr(deal.inr)} to the seller`;
      case 'CONFIRM':
        return sells ? `Did ${inr(deal.inr)} arrive?` : 'The seller is confirming your payment';
      case 'RELEASE':
        return sells ? 'Releasing the escrow to the buyer' : `${usdt(o.usdt)} is on its way to you`;
      case 'REFUND':
        return 'The seller’s USDT is going back to them';
      case 'CANCELLED':
        return deal.escrowReturn ? `Your ${usdt(deal.escrowReturn.amount)} is going back to you` : 'Cancelled';
      default:
        return 'Completed';
    }
  })();

  const body = (() => {
    if (!canAct && (yours || disputed)) return <p className={styles.note}>Someone who can accept quotes for your account does this.</p>;
    if (disputed) return sells ? (
      <DisputeUnderReview dispute={deal.dispute!}>
        <ConfirmReceived detail={detail} deal={deal} />
      </DisputeUnderReview>
    ) : (
      <PayerSide detail={detail} deal={deal} />
    );
    switch (deal.step) {
      case 'ESCROW':
        return sells ? (
          <Escrow detail={detail} />
        ) : (
          <p className={styles.note}>INRP2P holds the seller’s USDT for you before you pay anything. The seller’s account appears here as soon as it is locked.</p>
        );
      case 'PAY':
        return sells ? (
          <p className={styles.note}>
            {final
              ? `The buyer’s time to pay is up. If they do not file their payment in the final minutes, the deal is cancelled and your ${usdt(o.usdt)} goes back to your registered wallet.`
              : `Your USDT is locked in escrow. The buyer pays ${inr(deal.inr)}${method ? ` by ${method}` : ''} straight to ${detail.youReceiveAt}; you will be asked to confirm when they say they have paid.`}
          </p>
        ) : (
          <PayInr
            deal={deal}
            fromAccounts={detail.payFrom.length > 1 ? detail.payFrom : null}
            // Its registered account is where it pays from unless it says otherwise (a UPI ID of its own).
            {...(detail.payFrom[0] ? { defaultFrom: detail.payFrom[0].id } : {})}
            attachFields={{ ref: detail.order.ref }}
            choose={(m, key) => chooseOrderMethodAction({ ref: detail.order.ref, method: m }, key)}
            claim={async (input, key) => {
              const out = await submitOrderPaymentAction(
                { ref: detail.order.ref, rail: input.rail, utr: input.utr, payeeNameConfirmed: input.payeeNameConfirmed, ...(input.from?.kind === 'UPI' ? { fromUpiId: input.from.id } : {}) },
                key,
              );
              return out.ok ? { ok: true, result: { legRef: out.result.settlementRef } } : out;
            }}
            report={(shownName, key) => reportOrderPayeeNameAction({ ref: detail.order.ref, shownName }, key)}
            attach={postOrderMessageAction}
          />
        );
      case 'CONFIRM':
        return sells ? (
          <>
            {deal.receiptLate ? (
              <p className={shell.info} data-tone="warning" role="status">
                <ClockIcon className={shell.infoIcon} />
                <span>Longer than usual{method ? ` for ${method}` : ''}. Check your bank app; if the money is not there, say so below — INRP2P is following it up.</span>
              </p>
            ) : null}
            <ConfirmReceived detail={detail} deal={deal} />
            <PayeeNotArrived detail={detail} deal={deal} />
          </>
        ) : (
          <p className={styles.note}>
            {deal.receiptLate
              ? `The seller has not confirmed your payment yet. ${method === 'NEFT' || method === 'RTGS' ? `${method} can take longer. ` : ''}INRP2P is checking it with them — nothing is cancelled for a bank’s delay.`
              : `The seller is checking your payment in their bank app. Once they confirm, INRP2P releases ${usdt(o.usdt)} to your registered wallet.`}
          </p>
        );
      case 'RELEASE':
        return <p className={styles.note}>{sells ? 'You confirmed the INR. Nothing more to do on this order.' : 'The seller confirmed your payment. INRP2P is sending the USDT from escrow to your registered wallet.'}</p>;
      case 'REFUND':
        return (
          <p className={styles.note}>
            {deal.unwind?.reason === 'NOT_PAID' ? 'INRP2P found your payment did not reach the seller.' : 'The time to pay ran out.'} The deal is cancelled and the seller’s USDT goes back
            to them. Do not pay now — a payment would not count.
          </p>
        );
      case 'CANCELLED': {
        const why = deal.dispute?.status === 'NOT_PAID' ? (sells ? 'INRP2P found the buyer’s payment did not arrive.' : 'INRP2P found your payment did not reach the seller.') : deal.unwind ? 'The time to pay ran out.' : 'The buyer did not pay in time.';
        return (
          <p className={styles.note}>
            {deal.escrowReturn
              ? deal.escrowReturn.status === 'SENT'
                ? `${why} ${usdt(deal.escrowReturn.amount)} went back to your registered wallet.`
                : `${why} INRP2P is sending ${usdt(deal.escrowReturn.amount)} back from the escrow to your registered wallet.`
              : deal.unwind
                ? `${why} The seller’s USDT went back to them.`
                : (o.closeNote ?? 'Nothing is held for this order.')}
          </p>
        );
      }
      default:
        return <p className={styles.note}>Settled in full on both sides.</p>;
    }
  })();

  const badge = disputed ? 'With INRP2P' : yours ? 'Your move' : deal.step === 'RELEASE' ? 'Releasing' : deal.step === 'REFUND' ? 'Refund' : deal.step === 'CANCELLED' ? 'Closed' : deal.step === 'DONE' ? 'Done' : 'Escrow';
  return (
    <section className={`${shell.card} ${pay.card}`} aria-labelledby="next-title" data-robot-target="panel" {...(yours ? { 'data-attention': '' } : {})}>
      <div className={yours ? `${pay.head} ${shell.cap}` : pay.head}>
        <div className={pay.headText}>
          <span className={pay.badge} data-tone={yours ? undefined : 'quiet'}>
            {badge}
          </span>
          <h2 id="next-title" className={pay.title}>
            {title}
          </h2>
        </div>
        {remaining !== null ? (
          <span className={pay.timer} data-state={remaining <= 0 ? 'over' : final || remaining <= 5 * 60_000 ? 'soon' : 'calm'} role="timer" aria-live="off">
            <ClockIcon className={pay.inlineIcon} />
            {remaining <= 0 ? 'Time’s up' : <>{final ? 'Final' : yours ? 'Within' : 'Expected within'} <span className="ix-num">{formatCountdown(remaining)}</span></>}
          </span>
        ) : null}
      </div>
      <p className={styles.p2pEscrow} data-state={deal.escrowFunded && deal.step !== 'CANCELLED' ? 'locked' : 'open'}>
        <LockIcon className={styles.p2pEscrowIcon} />
        {deal.step === 'CANCELLED'
          ? 'Escrow closed'
          : deal.step === 'REFUND'
            ? 'Escrow going back to the seller'
          : deal.escrowFunded
            ? `${usdt(o.usdt)} locked in INRP2P escrow${deal.step === 'RELEASE' || deal.step === 'DONE' ? ' — releasing' : ''}`
            : 'Escrow not funded yet'}
      </p>
      {body}
    </section>
  );
}

/** Selling: this order's own address is the deal's escrow. */
function Escrow({ detail }: { detail: TraderOrderDetail }) {
  const { run, busy, error, dialog } = useCommand();
  const show = () => run(`Show the escrow address for ${detail.order.ref}`, (key) => orderDeliveryAddressAction({ ref: detail.order.ref }, key));
  if (detail.sendTo && detail.youOwe) {
    return (
      <div className={styles.instructions}>
        <DepositAddress address={detail.sendTo} amount={Money.parse(detail.youOwe, 'USDT')} network="TRC20" tradeRef={detail.order.ref} purpose="order" />
        <p className={styles.note}>Send from your registered wallet only. The buyer pays you only once this is final; if they don’t pay in time, it comes back to your wallet.</p>
      </div>
    );
  }
  return (
    <div className={styles.instructions}>
      <p className={styles.note}>The buyer pays nothing until your USDT is in this order’s escrow address. If they don’t pay in time, INRP2P sends it back to your registered wallet.</p>
      <div className={styles.formActions}>
        <button type="button" className={shell.action} disabled={busy} onClick={() => void show()}>
          Show the escrow address
        </button>
      </div>
      {error ? (
        <p className={shell.error} role="alert">
          {sentence(error)}
        </p>
      ) : null}
      {dialog}
    </div>
  );
}

/** Selling: the buyer's rupees, as the trader's own bank shows them — and who sent them. */
function ConfirmReceived({ detail, deal }: { detail: TraderOrderDetail; deal: Deal }) {
  const { run, busy, error, dialog } = useCommand();
  const [name, setName] = useState('');
  const [seen, setSeen] = useState(false);
  const [verdict, setVerdict] = useState<string | null>(null);
  const filed = deal.payments.filter((p) => p.status === 'PROCESSING').at(-1);
  const submit = async () => {
    const out = await run(`Confirm ${inr(deal.inr)} received`, (key) => confirmOrderPaymentReceivedAction({ ref: detail.order.ref, senderName: name.trim() }, key));
    if (out.ok) setVerdict(out.result.verdict);
  };
  return (
    <div className={styles.instructions}>
      {filed ? (
        <dl className={styles.payTo}>
          <div>
            <dt>The buyer says they paid</dt>
            <dd>{inr(filed.amount)}</dd>
            <span />
          </div>
          <div>
            <dt>{filed.rail ?? 'Bank'} reference</dt>
            <dd className="ix-num">{filed.utr ?? '—'}</dd>
            {filed.utr ? <CopyButton value={filed.utr} label="Copy UTR" /> : <span />}
          </div>
          <div>
            <dt>To</dt>
            <dd>
              {detail.youReceiveAt} · {formatIstDateTime(new Date(filed.filedAt)).split(', ')[1]}
            </dd>
            <span />
          </div>
        </dl>
      ) : null}
      {filed ? <ClaimProof chat={deal.chat} paymentRef={filed.ref} /> : null}
      <p className={shell.info} data-tone="warning">
        <InfoIcon className={shell.infoIcon} />
        <span>
          Open your bank app first. Confirm only once the money is in your account — confirming releases your escrowed USDT to the buyer and cannot be undone. Not there yet?
          Don’t confirm — give it a few minutes, or tell INRP2P below.
        </span>
      </p>
      {verdict && verdict !== 'MATCH' ? (
        <p className={shell.info} data-tone="warning" role="alert">
          <ShieldIcon className={shell.infoIcon} />
          <span>
            {verdict === 'PARTIAL'
              ? 'That name is close to the buyer’s, but not the same. The desk checks it; the escrow stays locked meanwhile.'
              : 'That is not the buyer’s registered account. Don’t spend this money — it goes back to whoever sent it. The desk has been told; the escrow stays locked.'}
          </span>
        </p>
      ) : null}
      <form
        className={styles.editForm}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Sender’s name, as your bank shows it</span>
          <input className="ix-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} maxLength={140} placeholder="e.g. RAHUL KUMAR SHARMA" />
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} />
          <span>I see {inr(deal.inr)} credited to my account in my bank app.</span>
        </label>
        <div className={`${styles.formActions} ${pay.submitRow}`}>
          <button type="submit" className={shell.action} disabled={busy || name.trim().length < 2 || !seen}>
            Release the escrow
          </button>
        </div>
        {error ? (
          <p className={shell.error} role="alert">
            {sentence(error)}
          </p>
        ) : null}
      </form>
      {dialog}
    </div>
  );
}

/** Selling: the buyer's rupees are not in the trader's account — the deal stops and INRP2P decides from its bank. */
function PayeeNotArrived({ detail, deal }: { detail: TraderOrderDetail; deal: Deal }) {
  const { run, busy, dialog } = useCommand();
  return (
    <>
      <NotArrived
        inr={inr(deal.inr)}
        busy={busy}
        onSubmit={async (reason, note) => {
          const out = await run(`Tell INRP2P ${inr(deal.inr)} has not arrived`, (key) => disputeOrderPaymentAction({ ref: detail.order.ref, reason, note }, key));
          return out.ok ? { ok: true } : { ok: false, error: sentence(out.message) };
        }}
      />
      {dialog}
    </>
  );
}

/** Buying: the seller says the trader's rupees did not arrive — the trader's side, for INRP2P. */
function PayerSide({ detail, deal }: { detail: TraderOrderDetail; deal: Deal }) {
  const { run, busy, dialog } = useCommand();
  return (
    <>
      <AddYourSide
        dispute={deal.dispute!}
        inr={inr(deal.inr)}
        busy={busy}
        onSubmit={async (note) => {
          const out = await run('Send your details to INRP2P', (key) => answerOrderDisputeAction({ ref: detail.order.ref, note }, key));
          return out.ok ? { ok: true } : { ok: false, error: sentence(out.message) };
        }}
      />
      {dialog}
    </>
  );
}

/** The order's chat (ADR 0023): the trader and the other side by its role, INRP2P when called; kept after the order closes. */
export function P2pOrderChat({ detail }: { detail: TraderOrderDetail }) {
  return (
    <DealChat
      chat={detail.p2p!.chat}
      fields={{ ref: detail.order.ref }}
      send={postOrderMessageAction}
      callSupport={(note, key) => callOrderSupportAction({ ref: detail.order.ref, note }, key)}
    />
  );
}
