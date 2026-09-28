'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Money } from '@inrp2p/kernel';
import type { PaymentRow, TraderOrderDetail } from '@inrp2p/traders';
import { CopyButton, DepositAddress, UTRField, normalizeUtr } from '@inrp2p/ui';
import { formatIstDateTime } from '@inrp2p/ui/format';
import { useCommand } from '../../../../../components/useCommand.tsx';
import { orderDeliveryAddressAction, submitOrderPaymentAction } from '../../../../../server/actions/traders.ts';
import { AssistantPanel } from '../../../_assistant/AssistantPanel.tsx';
import { traderOrderAssistant } from '../../../_assistant/traders.ts';
import { InfoIcon } from '../../../_workspace/icons.tsx';
import { Stepper } from '../../../_workspace/Stepper.tsx';
import { useServerClock } from '../../../exchange/useServerClock.ts';
import { OfferCard } from '../../_ui/OfferCard.tsx';
import { amountIn, inr, rate, sentence, usdt } from '../../_ui/format.ts';
import shell from '../../../shell.module.css';
import styles from '../../traders.module.css';

const RAILS = ['IMPS', 'NEFT', 'RTGS', 'UPI'] as const;

function Payments({ title, rows, empty }: { title: string; rows: readonly PaymentRow[]; empty: string }) {
  return (
    <div className={styles.instructions}>
      <span className={shell.label}>{title}</span>
      {rows.length === 0 ? (
        <p className={styles.note}>{empty}</p>
      ) : (
        <ul className={styles.evidence}>
          {rows.map((p, i) => (
            <li key={`${p.reference ?? 'row'}:${i}`}>
              <span className={styles.orderText}>
                <span className={styles.orderMain}>{amountIn(p.currency, p.amount)}</span>
                <span className={`${styles.orderMeta} ${styles.mono}`}>{p.reference ?? '—'}</span>
              </span>
              <span className={styles.pill} data-tone={p.status === 'CONFIRMED' ? 'done' : p.status === 'FAILED' ? 'neutral' : 'waiting'}>
                <span className={styles.pillDot} aria-hidden="true" />
                {p.status === 'CONFIRMED' ? `Confirmed ${formatIstDateTime(new Date(p.at)).split(', ')[1]}` : p.status === 'FAILED' ? 'Failed' : 'Being checked'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Buy USDT, the trader's turn: where to pay, and the reference it gives back once it has paid. */
function PayInr({ detail }: { detail: TraderOrderDetail }) {
  const { run, busy, error, dialog } = useCommand();
  const [rail, setRail] = useState<(typeof RAILS)[number]>('IMPS');
  const [utr, setUtr] = useState('');
  const payTo = detail.payTo;
  if (!payTo) {
    return (
      <p className={shell.info} data-tone="warning">
        <InfoIcon className={shell.infoIcon} />
        <span>INRP2P has not published its collection account details yet. Contact the desk before you pay.</span>
      </p>
    );
  }
  const submit = () => run(`Send payment reference for ${detail.order.ref}`, (key) => submitOrderPaymentAction({ ref: detail.order.ref, rail, utr: normalizeUtr(utr) }, key));
  return (
    <div className={styles.instructions}>
      <dl className={styles.payTo}>
        <div>
          <dt>Amount</dt>
          <dd>{inr(detail.youOwe!)}</dd>
          <CopyButton value={Money.parse(detail.youOwe!, 'INR').toDecimalString()} label="Copy amount" />
        </div>
        <div>
          <dt>Beneficiary</dt>
          <dd>{payTo.beneficiary}</dd>
          <CopyButton value={payTo.beneficiary} label="Copy beneficiary" />
        </div>
        <div>
          <dt>Account number</dt>
          <dd>{payTo.accountNumber}</dd>
          <CopyButton value={payTo.accountNumber} label="Copy account number" />
        </div>
        <div>
          <dt>IFSC</dt>
          <dd>
            {payTo.ifsc} · {payTo.bankName}
          </dd>
          <CopyButton value={payTo.ifsc} label="Copy IFSC" />
        </div>
        <div>
          <dt>Narration</dt>
          <dd>{payTo.narration}</dd>
          <CopyButton value={payTo.narration} label="Copy narration" />
        </div>
      </dl>
      <p className={styles.note}>Pay from your registered account only. A payment from any other account cannot be matched to this order.</p>
      <form
        className={styles.editForm}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={styles.pair}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Paid by</span>
            <select className="ix-input" value={rail} onChange={(e) => setRail(e.target.value as (typeof RAILS)[number])}>
              {RAILS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <UTRField value={utr} onChange={setUtr} label="Bank reference (UTR)" />
        </div>
        <div className={styles.formActions}>
          <button type="submit" className={shell.action} disabled={busy || normalizeUtr(utr).length < 6}>
            I have paid
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

/** Sell USDT, the trader's turn: this order's own address, issued once, and the exact amount. */
function SendUsdt({ detail }: { detail: TraderOrderDetail }) {
  const { run, busy, error, dialog } = useCommand();
  const show = () => run(`Show the address for ${detail.order.ref}`, (key) => orderDeliveryAddressAction({ ref: detail.order.ref }, key));
  if (detail.sendTo && detail.youOwe) {
    return (
      <div className={styles.instructions}>
        <DepositAddress address={detail.sendTo} amount={Money.parse(detail.youOwe, 'USDT')} network="TRC20" tradeRef={detail.order.ref} purpose="order" />
        <p className={styles.note}>Send from your registered wallet only. The transfer is picked up on-chain; there is no reference to type.</p>
      </div>
    );
  }
  return (
    <div className={styles.instructions}>
      <p className={styles.note}>This order has its own deposit address. USDT that reaches it from your registered wallet settles your side when it is final on TRON.</p>
      <div className={styles.formActions}>
        <button type="button" className={shell.action} disabled={busy} onClick={() => void show()}>
          Show the order’s address
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

function NextAction({ detail, canAct }: { detail: TraderOrderDetail; canAct: boolean }) {
  const o = detail.order;
  const buy = o.side === 'BUY_USDT';
  const body = (() => {
    switch (o.stage) {
      case 'YOUR_TURN':
        if (!canAct) return <p className={styles.note}>Someone who can accept quotes for your account sends this and records it.</p>;
        return buy ? <PayInr detail={detail} /> : <SendUsdt detail={detail} />;
      case 'HELD':
        return <p className={styles.note}>Your capacity is held while the trade is confirmed with the other side{o.holdUntil ? `, until ${formatIstDateTime(new Date(o.holdUntil)).split(', ')[1]} at the latest` : ''}. Nothing to send yet.</p>;
      case 'AWAITING_FUNDING':
        return <p className={styles.note}>The trade is open. Wait until the other side’s funds are confirmed — you will be told, here and in Notifications, when it is your turn.</p>;
      case 'CHECKING_YOURS':
        return <p className={styles.note}>{buy ? 'INRP2P is checking your payment against its bank account.' : 'Your USDT is on-chain. It counts once it is final on TRON.'}</p>;
      case 'REVIEW':
        return (
          <p className={shell.info} data-tone="warning">
            <InfoIcon className={shell.infoIcon} />
            <span>A transfer reached this order’s address from a wallet that is not your registered wallet, or more than the order needs. It was not counted; the desk is reviewing it.</span>
          </p>
        );
      case 'INRP2P_SENDING':
        return <p className={styles.note}>Your side is confirmed. INRP2P is sending {buy ? `${usdt(o.usdt)} to your registered wallet` : `${inr(o.inr)} to your registered bank account`}.</p>;
      case 'CHECKING_INRP2P':
        return <p className={styles.note}>INRP2P’s payment to you is recorded and being confirmed.</p>;
      case 'COMPLETED':
        return <p className={styles.note}>Settled in full on both sides.{o.reward ? ` Reward earned: ${inr(o.reward)}.` : ''}</p>;
      default:
        return <p className={styles.note}>{o.closeNote ?? 'Nothing is held for this order.'}</p>;
    }
  })();
  const title: Record<string, string> = {
    YOUR_TURN: buy ? `Send ${detail.youOwe ? inr(detail.youOwe) : 'your INR'}` : `Send ${detail.youOwe ? usdt(detail.youOwe) : 'your USDT'}`,
    HELD: 'Waiting for confirmation',
    AWAITING_FUNDING: 'Waiting for the other side',
    CHECKING_YOURS: 'Checking your payment',
    REVIEW: 'Under review',
    INRP2P_SENDING: buy ? 'Your USDT is on its way' : 'Your INR is on its way',
    CHECKING_INRP2P: 'Confirming INRP2P’s payment',
    COMPLETED: 'Completed',
    CLOSED: 'Closed',
  };
  return (
    <section className={o.stage === 'YOUR_TURN' ? `${shell.surface} ${styles.offer}` : shell.card} aria-labelledby="next-title" data-robot-target="panel">
      <span className={shell.label}>What happens now</span>
      <h2 id="next-title" className={shell.cardTitle}>
        {title[o.stage] ?? 'Order'}
      </h2>
      {body}
    </section>
  );
}

/**
 * One order: what is happening and what the trader does now, then what was agreed and every payment on it. Built
 * only from the trader projection — the other side is "the other side", never a name, a rate or a reference.
 */
export function OrderScreen({ detail, canAct }: { detail: TraderOrderDetail; canAct: boolean }) {
  const router = useRouter();
  const o = detail.order;
  const live = o.status === 'OFFERED' || o.status === 'ACCEPTED' || o.status === 'IN_PROGRESS';
  const now = useServerClock(detail.now, o.status === 'OFFERED');
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [live, router]);
  const buy = o.side === 'BUY_USDT';

  return (
    <>
      <main className={shell.main}>
        {o.status === 'OFFERED' ? (
          <OfferCard order={o} now={now} canAct={canAct} receiveAt={detail.youReceiveAt} />
        ) : (
          <>
            {detail.steps.length > 0 ? (
              <section className={shell.card} aria-labelledby="progress-title">
                <h2 id="progress-title" className={shell.cardTitle}>
                  Progress
                </h2>
                <Stepper steps={detail.steps} label="Order progress" />
              </section>
            ) : null}
            <NextAction detail={detail} canAct={canAct} />
          </>
        )}

        <section className={shell.card} aria-labelledby="terms-title">
          <h2 id="terms-title" className={shell.cardTitle}>
            The order
          </h2>
          <div className={styles.twoCol}>
            <dl className={shell.facts}>
              <div>
                <dt>Direction</dt>
                <dd>{buy ? 'You buy USDT with INR' : 'You sell USDT for INR'}</dd>
              </div>
              <div>
                <dt>Amount</dt>
                <dd className="ix-num">{usdt(o.usdt)}</dd>
              </div>
              <div>
                <dt>{buy ? 'You pay' : 'You receive'}</dt>
                <dd className="ix-num">{inr(o.inr)}</dd>
              </div>
              <div>
                <dt>Rate</dt>
                <dd className="ix-num">{rate(o.rate)}</dd>
              </div>
            </dl>
            <dl className={shell.facts}>
              <div>
                <dt>Settlement</dt>
                <dd>{detail.method}</dd>
              </div>
              <div>
                <dt>You receive at</dt>
                <dd>{detail.youReceiveAt}</dd>
              </div>
              {o.startedAt ? (
                <div>
                  <dt>Started</dt>
                  <dd>{formatIstDateTime(new Date(o.startedAt))}</dd>
                </div>
              ) : null}
              <div>
                <dt>Reward</dt>
                <dd>{o.reward ? `${inr(o.reward)} on completion` : 'None on this order'}</dd>
              </div>
            </dl>
          </div>
        </section>

        {o.status === 'IN_PROGRESS' || o.status === 'COMPLETED' ? (
          <section className={shell.card} aria-labelledby="evidence-title">
            <h2 id="evidence-title" className={shell.cardTitle}>
              Payments
            </h2>
            <div className={styles.twoCol}>
              <Payments title={buy ? 'Your INR' : 'Your USDT'} rows={detail.yourPayments} empty="Nothing recorded yet." />
              <Payments title={buy ? 'USDT from INRP2P' : 'INR from INRP2P'} rows={detail.inrp2pPayments} empty="Nothing sent yet." />
            </div>
          </section>
        ) : null}
      </main>
      <AssistantPanel state={traderOrderAssistant(detail)} steps={detail.steps.length > 0 && o.status !== 'OFFERED' ? detail.steps : null}>
        <div className={styles.navRow}>
          <Link className={shell.textAction} href="/traders/orders">
            All orders
          </Link>
          <Link className={shell.textAction} href="/traders">
            Traders
          </Link>
        </div>
      </AssistantPanel>
    </>
  );
}
