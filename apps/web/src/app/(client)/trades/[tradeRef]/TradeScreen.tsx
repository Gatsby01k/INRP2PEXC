'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Money, Rate } from '@inrp2p/kernel';
import type { PortalTrade } from '@inrp2p/portal';
import { CopyButton, DepositAddress, SettlementProgress, TransactionHash } from '@inrp2p/ui';
import { formatInr, formatIstDateTime, formatIstTime, formatRate, formatUsdtHeadline, maskUtr, shortenHash } from '@inrp2p/ui/format';
import { StateMark, useAssistantState } from '../../_assistant/AssistantPanel.tsx';
import { type Step, at, tradeAssistant } from '../../_assistant/model.ts';
import { CheckIcon, ClockIcon, DownloadIcon, InfoIcon, PauseIcon, ReceiptIcon } from '../../_workspace/icons.tsx';
import { SuccessMark } from '../../_workspace/SuccessMark.tsx';
import { DealRail } from '../../_workspace/DealRail.tsx';
import { type Figure, Figures, Track } from '../../_workspace/OrderSummary.tsx';
import { DepositTimer, P2pDealCard, P2pDealChat } from './P2pDeal.tsx';
import shell from '../../shell.module.css';
import styles from './trade.module.css';

type LegStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

const LEG_STATUS: Record<string, LegStatus> = {
  DRAFT: 'PENDING',
  PENDING: 'PENDING',
  SENT: 'PROCESSING',
  PROCESSING: 'PROCESSING',
  EVIDENCE_RECORDED: 'PROCESSING',
  CONFIRMED: 'COMPLETED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

const LEG_WORDS: Record<LegStatus, string> = { PENDING: 'Scheduled', PROCESSING: 'On its way', COMPLETED: 'Received', FAILED: 'Failed', CANCELLED: 'Cancelled' };

const STAGE_LABELS = {
  SELL_USDT: ['Quote accepted', 'USDT received', 'INR paid out', 'Settled'],
  BUY_USDT: ['Quote accepted', 'INR received', 'USDT sent', 'Settled'],
} as const;

/** P2P (ADR 0019): the same four stages, in the words of a deal where the rupees go straight to the other side. */
const P2P_STAGE_LABELS = {
  SELL_USDT: ['Quote accepted', 'USDT in escrow', 'INR from the buyer', 'Settled'],
  BUY_USDT: ['Quote accepted', 'INR confirmed', 'USDT released', 'Settled'],
} as const;

/** A public explorer for a TRON transaction, where the client can check it themselves. */
const explorer = (hash: string) => `https://tronscan.org/#/transaction/${hash}`;

/** The portal's four stages, labelled for the direction; a cancelled trade stops at the stage it was waiting on. */
function stepsOf(view: PortalTrade): (Step & { at: string | null })[] {
  const cancelled = view.trade.status === 'CANCELLED';
  // A P2P SELL whose buyer did not pay unwinds (ADR 0020 §2.15): the step it stopped at says so; a disputed one waits on INRP2P.
  const refund = view.p2p?.step === 'REFUND';
  const disputed = view.p2p?.dispute?.status === 'OPEN';
  return view.stages.map((s, i) => {
    const label = (view.p2p ? P2P_STAGE_LABELS : STAGE_LABELS)[view.trade.direction][i] ?? s.key;
    if ((cancelled || refund) && s.status === 'current') return { label, status: 'exception' as const, detail: refund ? 'not paid — USDT going back' : 'cancelled', at: s.at };
    if (disputed && s.status === 'current') return { label, status: s.status, detail: 'INRP2P is checking', at: s.at };
    return { label, status: s.status, ...(s.detail ? { detail: s.detail } : {}), at: s.at };
  });
}

interface Event {
  readonly at: string;
  readonly title: string;
  readonly detail?: string;
  readonly tone: 'done' | 'progress' | 'neutral';
  readonly href?: string;
}

/** What has happened on the trade, newest first: every step of record, each payment with its reference. */
function eventsOf(view: PortalTrade, sell: boolean, rate: string): Event[] {
  const { trade, settlement } = view;
  const events: Event[] = [{ at: trade.openedAt, title: 'Trade opened', detail: `Quote accepted at ${rate} per USDT`, tone: 'done' }];
  if (view.incoming) {
    events.push({
      at: view.incoming.detectedAt,
      title: view.incoming.state === 'CONFIRMED' ? 'Your USDT arrived and is final' : 'Your USDT was seen on-chain',
      detail: `${formatUsdtHeadline(Money.parse(view.incoming.amount, 'USDT'))} · tx ${shortenHash(view.incoming.txHash)}`,
      tone: view.incoming.state === 'CONFIRMED' ? 'done' : 'progress',
      href: explorer(view.incoming.txHash),
    });
  }
  const funded = view.stages[1];
  if (!sell && funded?.status === 'done' && funded.at) events.push({ at: funded.at, title: 'Your INR was confirmed', tone: 'done' });
  for (const p of settlement.payments) {
    if (!p.confirmedAt) continue;
    const amount = settlement.expected.currency === 'INR' ? formatInr(Money.parse(p.amount, 'INR')) : formatUsdtHeadline(Money.parse(p.amount, 'USDT'));
    events.push({
      at: p.confirmedAt,
      title: sell ? `${amount} paid to ${view.destination}` : `${amount} sent to your wallet`,
      ...(p.reference ? { detail: sell ? `UTR ${maskUtr(p.reference)}` : `tx ${shortenHash(p.reference)}` } : {}),
      tone: 'done',
      ...(!sell && p.reference ? { href: explorer(p.reference) } : {}),
    });
  }
  if (view.completedAt) events.push({ at: view.completedAt, title: 'Settled in full', tone: 'done' });
  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The headline of a P2P deal (ADR 0019): what the deal waits on, said the way the client lives it. */
function p2pHeadline(deal: NonNullable<PortalTrade['p2p']>, sell: boolean, usdt: string, inr: string): { title: string; body: string } | null {
  // A dispute (block 9): the seller said the rupees did not arrive, and INRP2P decides from the seller's bank.
  if (deal.dispute?.status === 'OPEN') {
    return sell
      ? { title: 'INRP2P is checking the payment', body: `You said ${inr} has not arrived. Your USDT stays locked in escrow until INRP2P decides — from your bank’s evidence, not the buyer’s word.` }
      : { title: 'The seller says your payment has not arrived', body: `INRP2P is checking it with the seller’s bank. Your ${usdt} stays locked in escrow meanwhile — add your bank’s details below.` };
  }
  if (deal.step === 'REFUND') {
    return {
      title: `Your ${usdt} is going back to you`,
      body: `${deal.unwind?.reason === 'NOT_PAID' ? 'INRP2P found the buyer’s payment did not arrive' : 'The buyer did not pay in time'}, so the trade is cancelled once your USDT is back. Nothing of yours is kept.`,
    };
  }
  if (sell) {
    if (deal.step === 'ESCROW') return { title: `Send your ${usdt} to the escrow`, body: `Once it is locked there, the buyer pays you ${inr} straight to your account. Nothing leaves the escrow until you confirm the rupees arrived.` };
    if (deal.step === 'PAY') return { title: `The buyer is paying you ${inr}`, body: 'Your USDT is locked in INRP2P’s escrow. It is released only when you confirm the money is in your account.' };
    if (deal.step === 'CONFIRM') return { title: `Check your bank for ${inr}`, body: 'The buyer says they paid. Confirm it once you see the credit — that releases the escrow.' };
    if (deal.step === 'RELEASE') return { title: 'Done on your side', body: 'You confirmed the INR; INRP2P is releasing the escrow to the buyer.' };
    return null;
  }
  if (deal.step === 'ESCROW') return { title: `Securing your ${usdt}`, body: 'The seller is putting the USDT in INRP2P’s escrow first. You pay only once it is locked for you.' };
  if (deal.step === 'PAY') return { title: `Your ${usdt} is locked in escrow`, body: `Now pay the seller ${inr} straight from your own account and tell us the reference. The escrow releases the USDT to you as soon as the seller confirms it.` };
  if (deal.step === 'CONFIRM') return { title: 'The seller is confirming your payment', body: `As soon as they see your ${inr}, the escrow releases your ${usdt}.` };
  if (deal.step === 'RELEASE') return { title: `Your ${usdt} is on its way`, body: 'Payment confirmed. INRP2P is sending the USDT from escrow to your wallet.' };
  return null;
}

/** How often the screen looks again while money is still moving, or a settled trade's receipt is still to come. */
const LIVE_POLL_MS = 10_000;

/**
 * The trade screen answers one question — where is my money — the way the best money-tracking screens do: the state
 * in a sentence, as the page's headline; the journey as one track the money moves along; the one thing the client
 * has to do, if anything, as the page's only call to action; the payments as they land; and underneath, everything
 * that has happened, with times and references. The terms sit beside it for reference.
 *
 * Everything here came from the domain's client projections. There is no figure on this page the desk has not
 * already committed to, and nothing about how the desk sourced the other side of the trade (SECURITY §5).
 */
export function TradeScreen({ view, justOpened = false }: { view: PortalTrade; justOpened?: boolean }) {
  const router = useRouter();
  // Arriving straight from accepting the quote: said once, with the mark closing — and not again on a reload.
  const [welcome, setWelcome] = useState(justOpened);
  useEffect(() => {
    if (!justOpened) return;
    window.history.replaceState(null, '', window.location.pathname);
    const t = window.setTimeout(() => setWelcome(false), 9000);
    return () => window.clearTimeout(t);
  }, [justOpened]);
  const { trade, settlement } = view;
  const moving = trade.status !== 'COMPLETED' && trade.status !== 'CANCELLED';
  const receiptDue = trade.status === 'COMPLETED' && !view.receipt;
  const status = tradeAssistant(view);
  useAssistantState(status);

  // The trade's state changes on the desk's side and the chain's, not the client's: while it can still change,
  // the page looks again every few seconds (only while it is being looked at), so a transfer arriving, a payment
  // going out or the trade settling is seen as it happens.
  useEffect(() => {
    if (!moving && !receiptDue) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [moving, receiptDue, router]);

  const steps = stepsOf(view);
  const sell = trade.direction === 'SELL_USDT';
  const usdt = formatUsdtHeadline(Money.parse(trade.base.amount, 'USDT'));
  const inr = formatInr(Money.parse(trade.inr.amount, 'INR'));
  const rate = formatRate(Rate.parse(trade.clientRate, 'CLIENT'));
  const inrSettlement = settlement.expected.currency === 'INR';
  const receipt = `/api/receipts/${encodeURIComponent(trade.ref)}`;
  const p2p = view.p2p;
  // P2P (ADR 0019): a buyer's move begins only once the seller's USDT is in escrow.
  const yourMove = trade.status === 'AWAITING_FIRST_LEG' && !view.onHold && !(p2p && !sell && p2p.step === 'ESCROW');
  const events = eventsOf(view, sell, rate);
  const exactAmount = trade.depositInstructions ? Money.parse(trade.depositInstructions.amount, 'USDT').toDecimalString() : null;
  // While the trade waits on the client, the headline says what it is waiting for; the card below says how.
  const p2pHead = p2p && (!view.onHold || p2p.dispute?.status === 'OPEN') ? p2pHeadline(p2p, sell, usdt, inr) : null;
  const headline = p2pHead
    ? p2pHead
    : yourMove
    ? {
        title: sell ? `Waiting for your ${usdt}` : `Waiting for your ${inr}`,
        body: sell
          ? 'Send it to this trade’s own address below. Your INR follows as soon as it is final on-chain.'
          : 'Pay it from your own account, as shown below, then tell us the reference. Your USDT follows as soon as the payment is confirmed.',
      }
    : { title: status.title, body: status.body };

  // What each stop of the journey says under its name: when it was reached, or what it is waiting for.
  const trackNote: NonNullable<Parameters<typeof Track>[0]['note']> = (s) =>
              s.status === 'done' && 'at' in s && s.at
                ? formatIstTime(new Date(s.at as string))
                : s.status === 'current'
                  ? view.onHold && p2p?.dispute?.status !== 'OPEN'
                    ? 'on hold'
                    : (s.detail ?? 'in progress')
                  : s.status === 'exception'
                    ? (s.detail ?? 'cancelled')
                    : '';

  const figures: Figure[] = [
    { label: sell ? 'You sell' : 'You pay', value: sell ? usdt : inr },
    { label: 'You receive', value: sell ? inr : usdt },
    { label: 'Rate', value: `${rate}` },
    ...(trade.networkFee ? [{ label: 'Network fee', value: formatUsdtHeadline(Money.parse(trade.networkFee.amount, 'USDT')) }] : []),
  ];

  return (
    <>
      <main className={shell.main} {...(p2p ? { 'data-deal-rail': '' } : {})}>
        {welcome ? (
          <section className={styles.opened} role="status">
            <SuccessMark size={40} />
            <span className={styles.openedText}>
              <strong>Quote accepted — {trade.ref} is open.</strong>
              <span>
                {rate} per USDT is fixed for the whole {sell ? usdt : inr}. {sell ? 'Send your USDT below to get paid.' : 'Pay the INR to receive your USDT.'}
              </span>
            </span>
            <button type="button" className={styles.openedClose} onClick={() => setWelcome(false)} aria-label="Dismiss">
              ×
            </button>
          </section>
        ) : null}
        <section className={`${shell.card} ${styles.hero}`} data-mood={status.mood} aria-labelledby="state-title">
          {view.onHold && p2p?.dispute?.status !== 'OPEN' ? (
            <p className={styles.hold} role="status">
              <PauseIcon />
              Paused while the desk checks something. Nothing is lost.
            </p>
          ) : null}
          <div className={styles.state} aria-live="polite">
            <StateMark mood={status.mood} />
            <div className={styles.stateText}>
              <h2 id="state-title" className={styles.stateTitle}>
                {headline.title}
              </h2>
              <p className={styles.stateBody}>{headline.body}</p>
            </div>
          </div>

          {p2p ? (
            <div className={styles.progress} role="group" aria-label="Trade progress">
              <div className={styles.rail}>
                <DealRail viewer={sell ? 'seller' : 'buyer'} step={p2p.step} usdt={usdt} inr={inr} label={headline.title} />
              </div>
              <Track steps={steps} label="Stops" note={trackNote} />
            </div>
          ) : (
            <Track steps={steps} label="Trade progress" note={trackNote} />
          )}
          <Figures figures={figures} />
          {view.incoming ? (
            <div className={styles.transfer}>
              <span className={shell.label}>Your transfer</span>
              <TransactionHash hash={view.incoming.txHash} explorerUrl={explorer(view.incoming.txHash)} finality={view.incoming.state === 'CONFIRMED' ? 'Confirmed' : 'Seen, not final'} copy={false} />
            </div>
          ) : null}
        </section>

        {sell && trade.depositInstructions && view.incoming === null && trade.status !== 'CANCELLED' ? (
          <section className={`${shell.card} ${styles.action}`} aria-labelledby="deposit-title" data-attention={yourMove || undefined}>
            <div className={`${styles.actionHead} ${shell.cap}`}>
              <div className={styles.actionHeadText}>
                <span className={styles.actionBadge}>Your move</span>
                <h2 id="deposit-title" className={styles.actionTitle}>
                  Send your USDT
                </h2>
              </div>
              {p2p ? <DepositTimer deal={p2p} /> : null}
            </div>
            <p className={styles.actionText}>
              {p2p
                ? 'This address is the deal’s escrow: INRP2P holds your USDT there and releases it to the buyer only after you confirm their INR reached your account. If nothing arrives in time, the deal is cancelled.'
                : 'Scan the code or copy the address into your wallet. The transfer is picked up on-chain the moment it lands — there is nothing to tell the desk.'}
            </p>
            <DepositAddress
              address={trade.depositInstructions.address}
              amount={Money.parse(trade.depositInstructions.amount, 'USDT')}
              network="TRC20"
              tradeRef={trade.ref}
              framed={false}
            />
            {exactAmount ? (
              <div className={styles.copyRow}>
                <span className={shell.muted}>Exact amount for your wallet</span>
                <span className={styles.copyValue}>
                  <span className="ix-num">{exactAmount} USDT</span>
                  <CopyButton value={exactAmount} label="exact USDT amount" />
                </span>
              </div>
            ) : null}
          </section>
        ) : null}

        {p2p ? <P2pDealCard view={view} /> : null}

        {settlement.payments.length > 0 ? (
          <section className={shell.card} aria-label={inrSettlement ? 'INR settlement' : 'USDT delivery'}>
            <div className={shell.cardHead}>
              <h2 className={shell.cardTitle}>{inrSettlement ? 'Your INR' : 'Your USDT'}</h2>
              <span className={shell.muted}>
                {/* The figures are on the bar below for INR; the head says only how the payments stand. */}
                {settlement.remaining.amount.replace(/[0.]/g, '') === ''
                  ? 'Paid in full'
                  : inrSettlement
                    ? `${settlement.payments.length} payment${settlement.payments.length === 1 ? '' : 's'} so far`
                    : `${formatUsdtHeadline(Money.parse(settlement.remaining.amount, 'USDT'))} still to come`}
              </span>
            </div>
            {inrSettlement ? <SettlementProgress received={Money.parse(settlement.paid.amount, 'INR')} total={Money.parse(settlement.expected.amount, 'INR')} /> : null}
            <ul className={styles.payments}>
              {settlement.payments.map((p) => {
                const state = LEG_STATUS[p.status] ?? 'PENDING';
                return (
                  <li key={p.ref} className={styles.payment} data-state={state.toLowerCase()}>
                    <span className={styles.paymentMark} aria-hidden="true">
                      {state === 'COMPLETED' ? <CheckIcon /> : <ClockIcon />}
                    </span>
                    <span className={styles.paymentAmount}>
                      {inrSettlement ? formatInr(Money.parse(p.amount, 'INR')) : formatUsdtHeadline(Money.parse(p.amount, 'USDT'))}
                    </span>
                    <span className={styles.paymentMeta}>
                      {LEG_WORDS[state]}
                      {p.reference ? ` · ${inrSettlement ? `UTR ${maskUtr(p.reference)}` : `tx ${shortenHash(p.reference)}`}` : ''}
                    </span>
                    <span className={styles.paymentTime}>{p.confirmedAt ? formatIstDateTime(new Date(p.confirmedAt)).split(', ')[1] : ''}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </main>

      <aside className={`${shell.aside} ${styles.side}`} aria-label="Chat and details">
        {p2p ? <P2pDealChat view={view} /> : null}

        <section className={shell.card} aria-labelledby="summary-title">
          <h2 id="summary-title" className={shell.cardTitle}>
            Details
          </h2>
          <dl className={shell.facts}>
            <div>
              <dt>Reference</dt>
              <dd className={styles.refValue}>
                <span className="ix-num">{trade.ref}</span>
                <CopyButton value={trade.ref} label="trade reference" />
              </dd>
            </div>
            <div>
              <dt>{sell ? 'INR to' : 'USDT to'}</dt>
              <dd>{view.destination}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>USDT on TRON (TRC20)</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{at(trade.openedAt)}</dd>
            </div>
          </dl>
          {view.receipt ? (
            <div className={styles.receipt}>
              <ReceiptIcon className={styles.receiptIcon} />
              <span className={styles.receiptText}>Settlement receipt</span>
              <a className={shell.secondaryAction} data-size="sm" href={receipt} target="_blank" rel="noreferrer">
                View
              </a>
              <a className={shell.secondaryAction} data-size="sm" href={`${receipt}?format=pdf`} download>
                <DownloadIcon />
                PDF
              </a>
            </div>
          ) : trade.status === 'COMPLETED' ? (
            <p className={shell.muted}>The settlement receipt is being issued.</p>
          ) : null}
        </section>

        <section className={shell.card} aria-labelledby="activity-title">
          <h2 id="activity-title" className={shell.cardTitle}>
            Activity
          </h2>
          <ol className={styles.timeline}>
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`} className={styles.event} data-tone={e.tone}>
                <span className={styles.eventDot} aria-hidden="true" />
                <span className={styles.eventText}>
                  <span className={styles.eventTitle}>{e.title}</span>
                  {e.detail ? (
                    e.href ? (
                      <a className={styles.eventDetail} href={e.href} target="_blank" rel="noreferrer noopener">
                        {e.detail} ↗
                      </a>
                    ) : (
                      <span className={styles.eventDetail}>{e.detail}</span>
                    )
                  ) : null}
                </span>
                <time className={styles.eventTime} dateTime={e.at}>
                  {formatIstDateTime(new Date(e.at)).replace(' IST', '')}
                </time>
              </li>
            ))}
          </ol>
        </section>

        <p className={styles.help}>
          <InfoIcon className={styles.helpIcon} />
          <span>
            A question about this trade? Quote <strong className="ix-num">{trade.ref}</strong> when you contact the desk.
          </span>
        </p>
      </aside>
    </>
  );
}
