'use client';

import { useEffect, useRef } from 'react';
import { Money } from '@inrp2p/kernel';
import type { PortalTrade } from '@inrp2p/portal';
import { CopyButton, QrCode } from '@inrp2p/ui';
import { formatInr, formatUsdtHeadline, shortenHash } from '@inrp2p/ui/format';
import { robotCues } from '../../../(public)/_landing/robot/cues.ts';
import { RobotFigure } from '../../_assistant/RobotFigure.tsx';
import { RailMark } from '../../../../components/PayMarks.tsx';
import { ArrowIcon, DownloadIcon, ReceiptIcon } from '../../_workspace/icons.tsx';
import { Amount } from '../../../../components/Amount.tsx';
import { StateRing } from '../../_workspace/StateRing.tsx';
import { SuccessMark } from '../../_workspace/SuccessMark.tsx';
import { Countdown } from '../../exchange/QuoteCard.tsx';
import { useServerClock } from '../../exchange/useServerClock.ts';
import shell from '../../shell.module.css';
import stage from '../../exchange/stage.module.css';
import ds from './deal-stage.module.css';

/** Who the deal waits on now, as the stage tells it: the viewer, the other side, INRP2P, or nobody any more. */
type Beat = 'mine' | 'theirs' | 'moving' | 'done' | 'trouble' | 'over';

/** The four stops, as short as a glance needs them. */
const STOPS = {
  SELL_USDT: ['Accepted', 'Escrow', 'Rupees', 'Done'],
  BUY_USDT: ['Accepted', 'Payment', 'Release', 'Done'],
} as const;

/** An exact USDT amount as a person reads it and a wallet takes it: every decimal that matters, none that does not. */
function exactUsdt(m: Money): { shown: string; copy: string } {
  const copy = m.toDecimalString().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  const [whole, fraction] = copy.split('.');
  return { shown: `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction.padEnd(2, '0')}` : ''}`, copy };
}

const explorer = (hash: string) => `https://tronscan.org/#/transaction/${hash}`;

/**
 * A P2P deal (ADR 0019) as one stage, the twin of the firm quote's: on the mark's orange, whose move it is and what it
 * is — said once, the figure that moves as the monument, the step's time on the visor ring, the robot in its halo
 * answering the state of record — and, when the move is the viewer's and fits on the stage, the move's instrument
 * itself (the escrow's address to send to). Longer moves (paying, confirming) continue on the sheet right under it.
 * The four stops run along the stage's foot. Nothing here decides anything: every figure is the deal's own.
 */
export function DealStage({ view }: { view: PortalTrade }) {
  const deal = view.p2p!;
  const sell = view.trade.direction === 'SELL_USDT';
  const now = useServerClock(deal.now, deal.dueBy !== null);
  const usdt = formatUsdtHeadline(Money.parse(view.trade.base.amount, 'USDT'));
  const inrExact = formatInr(Money.parse(deal.inr, 'INR'), { fraction: 'always' });
  const usdtUnitless = formatUsdtHeadline(Money.parse(view.trade.base.amount, 'USDT'), { unit: false });
  const Other = sell ? 'Buyer' : 'Seller';
  const disputed = deal.dispute?.status === 'OPEN';
  const mineTurn = deal.turn === (sell ? 'SELLER' : 'BUYER');
  const stopAt = view.stages.findIndex((s) => s.status === 'current');
  const n = stopAt >= 0 ? stopAt + 1 : view.stages.length;
  const filed = deal.payments.findLast((p) => p.status === 'PROCESSING');
  const method = deal.payWindow?.method ?? deal.payments.at(-1)?.rail ?? null;

  const beat: Beat = view.trade.status === 'COMPLETED' || deal.step === 'DONE'
    ? 'done'
    : deal.step === 'CANCELLED'
      ? 'over'
      : disputed || deal.step === 'REFUND' || view.onHold
        ? 'trouble'
        : deal.step === 'RELEASE'
          ? 'moving'
          : mineTurn
            ? 'mine'
            : 'theirs';

  // The step's window, for the ring: from when the step began (the last stop reached, or the buyer's filing) to its end.
  const began = deal.step === 'CONFIRM' && filed ? filed.filedAt : ([...view.stages].reverse().find((s) => s.status === 'done' && s.at)?.at ?? view.trade.openedAt);
  // The ring says what its time is for — the move, in the viewer's words — never "held", which is a price's word.
  const ringLabel = beat === 'mine'
    ? (deal.step === 'ESCROW' ? 'Send within' : deal.step === 'PAY' ? 'Pay within' : 'Confirm within')
    : `${Other} expected within`;
  const ring = deal.dueBy && (beat === 'mine' || beat === 'theirs') ? <Countdown sentAt={new Date(began)} expiresAt={new Date(deal.dueBy)} now={now} variant="ring" label={ringLabel} /> : null;

  // What the stage says: a chip, a label over the figure, the figure, one line under it.
  const chip =
    beat === 'mine' ? `Your move · ${n} of 4` : beat === 'theirs' ? `${Other}’s move · ${n} of 4` : beat === 'moving' ? 'Releasing' : beat === 'done' ? 'Done' : beat === 'over' ? 'Cancelled' : disputed ? 'With INRP2P' : deal.step === 'REFUND' ? 'Going back' : 'On hold';

  const seen = sell && deal.step === 'ESCROW' && view.incoming !== null;
  const deposit = view.trade.depositInstructions;
  const exact = deposit ? exactUsdt(Money.parse(deposit.amount, 'USDT')) : null;

  let label: string;
  let figure: React.ReactNode;
  let line: React.ReactNode;
  let question: string | null = null;
  if (disputed) {
    label = sell ? 'You said it has not arrived' : 'The seller says your payment has not arrived';
    figure = <Amount value={inrExact} />;
    line = sell ? 'Your USDT stays locked while INRP2P checks with your bank.' : `Your ${usdt} stays locked for you while INRP2P checks.`;
  } else if (deal.step === 'REFUND' || (deal.step === 'CANCELLED' && deal.unwind)) {
    const back = deal.unwind ? formatUsdtHeadline(Money.parse(deal.unwind.amount, 'USDT')) : usdt;
    label = deal.unwind?.status === 'SENT' || deal.step === 'CANCELLED' ? 'Back with you' : 'Going back to you';
    figure = <Amount value={back} />;
    line = deal.unwind?.reason === 'NOT_PAID' ? 'The buyer’s payment did not arrive. Nothing of yours is kept.' : 'The buyer did not pay in time. Nothing of yours is kept.';
  } else if (deal.step === 'CANCELLED') {
    label = 'Cancelled';
    figure = <Amount value={sell ? usdt : inrExact} />;
    line = deal.dispute?.status === 'NOT_PAID' && !sell
      ? 'Your payment did not reach the seller. Do not pay again for it.'
      : sell ? 'Nothing left your wallet for this deal.' : 'Nothing was taken from you.';
  } else if (beat === 'done') {
    label = 'You received';
    figure = <Amount value={sell ? inrExact : usdt} />;
    line = sell ? `for ${usdt}` : `for ${inrExact}`;
  } else if (deal.step === 'RELEASE') {
    label = sell ? 'Releasing the escrow to the buyer' : 'On its way to your wallet';
    figure = <Amount value={usdt} />;
    line = sell ? 'Nothing more to do.' : 'Payment confirmed.';
  } else if (deal.step === 'ESCROW') {
    if (sell) {
      label = seen ? 'Seen on TRON · confirming' : 'Send to the deal’s escrow';
      figure = <Amount value={exact ? `${exact.shown} USDT` : usdt} />;
      line = seen ? null : 'USDT on TRON (TRC20). It counts the moment it lands.';
    } else {
      label = 'The seller is locking it for you';
      figure = <Amount value={usdt} />;
      line = 'You pay only once it is in escrow.';
    }
  } else if (deal.step === 'PAY') {
    label = sell ? 'The buyer is paying you' : 'Pay the seller';
    figure = <Amount value={inrExact} />;
    line = sell
      ? deal.payWindow?.final
        ? 'Their time is up — if they do not file now, your USDT comes back.'
        : <>{method ? <RailMark rail={method} /> : null}<span>to {view.destination}</span></>
      : deal.payWindow?.final
        ? 'Final minutes to file your payment.'
        : 'Exactly this amount, in one payment.';
  } else {
    // CONFIRM
    if (sell) {
      question = `Did ${inrExact} arrive?`;
      label = 'The buyer says they paid';
      figure = null;
      const ago = filed ? Math.max(0, Math.floor((now - Date.parse(filed.filedAt)) / 60_000)) : 0;
      line = filed ? <>{filed.rail ? <RailMark rail={filed.rail} /> : null}<span>{ago < 1 ? 'just now' : `${ago} min ago`} · to {view.destination}</span></> : null;
    } else {
      label = 'The seller is checking your payment';
      figure = <Amount value={usdt} />;
      line = deal.receiptLate ? `${method ?? 'This rail'} is taking longer — INRP2P is following it up.` : 'Released to you the moment they confirm.';
    }
  }

  if (view.onHold && !disputed && beat === 'trouble') line = 'Paused while INRP2P checks something. Nothing is lost.';

  const mood = beat === 'mine' ? 'focused' : beat === 'theirs' ? 'waiting' : beat === 'moving' ? 'verifying' : beat === 'done' ? 'success' : beat === 'trouble' ? 'alert' : 'ready';

  // The robot answers the moments, not the polling: a new move of the viewer's draws its eye; a deal coming right locks in.
  const moment = `${deal.step}:${beat}:${seen ? 'seen' : ''}`;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (last.current !== null && last.current !== moment) {
      if (beat === 'mine') robotCues.emit({ kind: 'rate' });
      else if (beat === 'moving' || beat === 'done') robotCues.emit({ kind: 'lock' });
      else if (beat === 'trouble') robotCues.emit({ kind: 'problem' });
    }
    last.current = moment;
  }, [moment, beat]);

  const stops = STOPS[view.trade.direction];

  return (
    <section className={`${shell.brandField} ${stage.stage} ${ds.stage}`} data-beat={beat} aria-labelledby="deal-move" data-robot-target="panel">
      <div className={`${stage.halo} ${ds.halo}`} aria-hidden="true">
        <i />
        {beat === 'theirs' || beat === 'moving' ? (
          <>
            <span className={stage.radar} />
            <span className={stage.radar} />
          </>
        ) : null}
        <svg className={stage.haloArcs} viewBox="0 0 400 400" focusable="false">
          <path d="M 27.6 230.4 A 175 175 0 0 1 117.8 45.5" />
          <path d="M 282.2 45.5 A 175 175 0 0 1 372.4 230.4" />
          <path d="M 297.9 345 A 175 175 0 0 1 102.1 345" />
        </svg>
        <svg className={stage.haloOrbit} viewBox="0 0 400 400" focusable="false">
          <circle cx="200" cy="200" r="194" />
          <circle className={stage.haloNode} cx="32" cy="297" r="6" />
          <circle className={stage.haloNode} cx="368" cy="297" r="6" />
        </svg>
      </div>
      <RobotFigure mood={mood} className={`${stage.robot} ${ds.robot}`} />

      <header className={ds.head}>
        <span className={`${stage.chip} ${ds.chip}`} data-beat={beat}>
          {beat === 'done' ? <SuccessMark size={18} /> : <StateRing state={beat === 'mine' ? 'turn' : beat === 'theirs' ? 'wait' : beat === 'moving' ? 'lock' : beat === 'trouble' ? 'check' : 'off'} className={ds.chipRing} />}
          {chip}
        </span>
      </header>

      <div className={ds.move}>
        {question ? (
          <h2 id="deal-move" className={ds.question}>
            Did <span className={ds.questionFigure}><Amount value={inrExact} /></span> arrive?
          </h2>
        ) : (
          <>
            <h2 id="deal-move" className={ds.label}>{label}</h2>
            {figure ? (
              <p className={ds.figure}>
                {figure}
              </p>
            ) : null}
          </>
        )}
        {question ? <p className={ds.label}>{label}</p> : null}
        {line ? <p className={ds.line}>{line}</p> : null}
        {ring ? <div className={ds.timer}>{ring}</div> : null}
      </div>

      {sell && deal.step === 'ESCROW' && deposit && !seen && beat !== 'over' ? (
        <div className={ds.ticket} aria-label="Deposit instructions" role="group">
          <QrCode value={deposit.address} label={`QR code for deposit address ${deposit.address}`} className={ds.qr} />
          <div className={ds.ticketText}>
            <span className={ds.ticketCap}>Escrow address · TRC20 · this deal only</span>
            <span className={ds.address}>
              <code>{deposit.address}</code>
              <CopyButton value={deposit.address} label="deposit address" />
            </span>
            <span className={ds.exact}>
              <span className={ds.ticketCap}>Send exactly</span>
              <span className={ds.exactValue}>
                <span className="ix-num">{exact!.shown} USDT</span>
                <CopyButton value={exact!.copy} label="exact USDT amount" />
              </span>
            </span>
          </div>
          <p className={ds.watch} role="status">
            <span className={ds.scan} aria-hidden="true" />
            Watching TRON · no button to press
          </p>
        </div>
      ) : null}

      {seen && view.incoming ? (
        <a className={ds.seen} href={explorer(view.incoming.txHash)} target="_blank" rel="noreferrer noopener">
          <span className={ds.scan} aria-hidden="true" />
          <span>
            <b>{formatUsdtHeadline(Money.parse(view.incoming.amount, 'USDT'))}</b> arrived · tx {shortenHash(view.incoming.txHash)}
          </span>
          <span className={ds.seenState}>{view.incoming.state === 'CONFIRMED' ? 'Final' : 'Confirming'} ↗</span>
        </a>
      ) : null}

      {beat === 'done' && view.receipt ? (
        <div className={ds.doneMoves}>
          <a className={stage.accept} href={`/api/receipts/${encodeURIComponent(view.trade.ref)}`} target="_blank" rel="noreferrer">
            <ReceiptIcon />
            <span>Receipt</span>
            <ArrowIcon className={shell.actionIcon} />
          </a>
          <a className={ds.pdf} href={`/api/receipts/${encodeURIComponent(view.trade.ref)}?format=pdf`} download>
            <DownloadIcon />
            PDF
          </a>
        </div>
      ) : null}

      <ol className={ds.stops} role="group" aria-label="Trade progress">
        {view.stages.map((s, i) => {
          const status = (beat === 'over' || beat === 'trouble') && s.status === 'current' ? 'exception' : s.status;
          return (
            <li key={s.key} className={ds.stop} data-status={status} aria-current={status === 'current' ? 'step' : undefined}>
              <span className={ds.stopNode} aria-hidden="true">
                {status === 'done' ? <CheckGlyph /> : status === 'exception' ? '!' : i + 1}
              </span>
              <span className={ds.stopLabel}>{stops[i] ?? s.key}</span>
            </li>
          );
        })}
      </ol>
      <span className="ix-visually-hidden">
        {sell ? 'Selling' : 'Buying'} {usdtUnitless} USDT
      </span>
    </section>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 16 16" focusable="false">
      <path d="M3.5 8.4 6.6 11.4 12.5 4.8" />
    </svg>
  );
}
