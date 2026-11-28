'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Money, Rate } from '@inrp2p/kernel';
import type { ClientDestinations, OpenRequest } from '@inrp2p/portal';
import type { ClientQuoteView } from '@inrp2p/quotes';
import { ArcLoader, EXPIRING_THRESHOLD_MS } from '@inrp2p/ui';
import { formatCountdown, formatInr, formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { acceptQuoteAction, rejectQuoteAction } from '../../../server/actions/client.ts';
import { playSound } from '../_assistant/sound.ts';
import { RobotFigure } from '../_assistant/RobotFigure.tsx';
import { ArrowIcon, InfoIcon, RateIcon } from '../_workspace/icons.tsx';
import { StateRing } from '../_workspace/StateRing.tsx';
import { Digits } from '../_workspace/Odometer.tsx';
import { legAmount } from './amounts.ts';
import shell from '../shell.module.css';
import { Amount } from '../../../components/Amount.tsx';
import { Coin } from '../../../components/Coin.tsx';
import { BankMark } from '../../../components/PayMarks.tsx';
import { RequestSheet } from './RequestSheet.tsx';
import styles from './exchange.module.css';
import stage from './stage.module.css';

const R = 10;
const C = 2 * Math.PI * R;

/**
 * How long the quote is still held: one thin arc in the brand's orange that runs down to nothing, the time left
 * inside it, turning amber in the last seconds — never flashing. Drawn against the whole time the desk held it for
 * (sent → expiry), on the database's clock.
 */
export function Countdown({ sentAt, expiresAt, now, variant = 'pill', label }: {
  sentAt: Date | null;
  expiresAt: Date;
  now: number;
  variant?: 'pill' | 'ring';
  /** What the time is for, as a screen reader says it ("Send within"): a deal's step is not a price held. */
  label?: string | undefined;
}) {
  const first = useRef(Math.max(1, expiresAt.getTime() - now));
  const total = sentAt ? Math.max(1, expiresAt.getTime() - sentAt.getTime()) : first.current;
  const remaining = Math.max(0, expiresAt.getTime() - now);
  const fraction = Math.min(1, remaining / total);
  if (variant === 'ring') {
    // The stage's visor: a disc of the robot's black glass, the ring running down round the time left, both lit.
    const r = 35;
    const c = 2 * Math.PI * r;
    return (
      <span className={stage.ringTimer} data-state={remaining <= EXPIRING_THRESHOLD_MS ? 'expiring' : 'held'} role="timer" aria-live="off">
        <svg viewBox="0 0 84 84" aria-hidden="true" focusable="false">
          <circle className={stage.ringTrack} cx="42" cy="42" r={r} />
          <circle className={stage.ringArc} cx="42" cy="42" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} />
        </svg>
        <Digits text={formatCountdown(remaining)} down className={stage.ringTime} />
        <span className="ix-visually-hidden">{label ? `${label} ${formatCountdown(remaining)}, until ${formatIstTime(expiresAt)}` : `, held until ${formatIstTime(expiresAt)}`}</span>
      </span>
    );
  }
  return (
    <span className={styles.timer} data-state={remaining <= EXPIRING_THRESHOLD_MS ? 'expiring' : 'held'} role="timer" aria-live="off">
      <svg className={styles.timerRing} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle className={styles.timerTrack} cx="12" cy="12" r={R} />
        <circle className={styles.timerArc} cx="12" cy="12" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - fraction)} />
      </svg>
      <span className={styles.timerText}>
        <Digits text={formatCountdown(remaining)} down className={styles.timerTime} />
        <span className={styles.timerLabel}>held</span>
      </span>
      <span className="ix-visually-hidden">, held until {formatIstTime(expiresAt)}</span>
    </span>
  );
}

/**
 * A firm quote the desk has sent, in two parts side by side: what the client asked — what they give and where the
 * money lands — and the quote's stage: what they get, as large as the page allows, the rate locked inside it, how
 * long it is held on the robot's visor, and the decision, with the robot standing in its halo beside it.
 * Accepting opens the trade and takes the client straight to it; declining is a formal answer to the desk, so it
 * asks once before it is sent.
 */
export function QuoteCard({ quote, canAccept, now, request, destinations }: { quote: ClientQuoteView; canAccept: boolean; now: number; request: OpenRequest | null; destinations: ClientDestinations }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [declining, setDeclining] = useState(false);
  const expiresAt = new Date(quote.expiresAt!);
  const sell = quote.direction === 'SELL_USDT';
  const rate = formatRate(Rate.parse(quote.clientRate, 'CLIENT'));
  const usdt = legAmount(quote.base.amount, 'USDT');
  const inr = legAmount(quote.inr.amount, 'INR');
  // ADR 0028: the deal's network as the client's own line — paid on top when buying, out of the USDT sent when selling.
  const fee = quote.networkFee ? legAmount(quote.networkFee.amount, 'USDT') : null;
  // The rupees as a statement sets them, to the paisa: the figure the stage is about.
  const inrExact = formatInr(Money.parse(quote.inr.amount, 'INR'), { fraction: 'always' }).replace('₹', '');
  const landBank = sell ? destinations.banks.find((b) => quote.destination.includes(b.last4) && quote.destination.includes(b.bankName)) : undefined;

  const accept = async () => {
    robotCues.emit({ kind: 'wait', on: true });
    const out = await run('Accept this quote', (key) => acceptQuoteAction({ quoteRef: quote.ref }, key));
    robotCues.emit({ kind: 'wait', on: false });
    if (out.ok) {
      robotCues.emit({ kind: 'lock' });
      playSound('success');
      router.push(`/trades/${out.result.tradeRef}?opened=1`);
    } else {
      robotCues.emit({ kind: 'problem' });
    }
  };
  const decline = async () => {
    const out = await run('Decline this quote', (key) => rejectQuoteAction({ quoteRef: quote.ref }, key));
    if (!out.ok) robotCues.emit({ kind: 'problem' });
    setDeclining(false);
  };

  return (
    <>
      <section className={stage.deal} aria-label="Firm quote" data-robot-target="panel">
        {/* What was asked: the client's own side of the deal, and where its money lands. */}
        <RequestSheet
          direction={quote.direction}
          amount={sell ? usdt : inr}
          currency={sell ? 'USDT' : 'INR'}
          destination={quote.destination}
          destinations={destinations}
          targetRate={request?.targetRate ? formatRate(Rate.parse(request.targetRate, 'CLIENT')) : null}
          sentAt={request ? formatIstTime(new Date(request.createdAt)) : null}
          reference={request?.ref ?? null}
          networkFee={
            fee
              ? sell
                ? `${fee} USDT — what TRON charges for this deal’s escrow, out of what you send`
                : `${fee} USDT — what TRON charges for this deal’s escrow, on top`
              : quote.networkFeeIncluded
                ? `Included in the rate (₹${legAmount(quote.networkFeeIncluded.amount, 'INR')})`
                : null
          }
        />

        {/* The quote's face is a stage: the figure the client gets as a monument on the mark's orange, the robot
            standing in its halo and answering what happens, the time left on its visor, and the decision. */}
        <div className={`${shell.brandField} ${stage.stage}`}>
          <div className={stage.halo} aria-hidden="true">
            <i />
            <svg className={stage.haloArcs} viewBox="0 0 400 400" focusable="false">
              <path d="M 27.6 230.4 A 175 175 0 0 1 117.8 45.5" />
              <path d="M 282.2 45.5 A 175 175 0 0 1 372.4 230.4" />
              <path d="M 297.9 345 A 175 175 0 0 1 102.1 345" />
            </svg>
            <svg className={stage.haloOrbit} viewBox="0 0 400 400" focusable="false">
              <circle cx="200" cy="200" r="194" />
              <circle className={stage.haloNode} cx="200" cy="6" r="6" />
              <circle className={stage.haloNode} cx="32" cy="297" r="5" />
              <circle className={stage.haloNode} cx="368" cy="297" r="5" />
            </svg>
          </div>
          <RobotFigure mood="focused" className={stage.robot} />

          <header className={stage.stageHead}>
            <span className={stage.chip}>
              <StateRing state="lock" />
              <span>Firm quote</span>
            </span>
            <span className={stage.ref}>{quote.ref}</span>
          </header>

          <div className={stage.get}>
            <span className={stage.getLabel}>You receive</span>
            <span className={stage.getFigure}>
              <Amount value={sell ? `₹${inrExact}` : usdt} />
              {sell ? null : <span className={stage.getUnit}>USDT</span>}
            </span>
          </div>

          <div className={stage.facts}>
            <span className={stage.fact} data-robot-target="rate">
              <RateIcon />
              <span>
                <span className={stage.factFigure}>{rate}</span>/USDT
              </span>
            </span>
            <span className={stage.fact}>
              {landBank ? <BankMark ifsc={landBank.ifsc} name={landBank.bankName} size={22} /> : <Coin currency={sell ? 'INR' : 'USDT'} size={22} />}
              <span>to {quote.destination}</span>
            </span>
            <span className={stage.fact}>
              {fee ? (sell ? `${fee} USDT of what you send pays the network` : `Includes your USDT and ${fee} USDT of network`) : sell ? 'Nothing is deducted' : 'Nothing is added'}
            </span>
          </div>

          <div className={stage.decide}>
            {canAccept ? (
              declining ? (
                <div className={stage.confirm} role="group" aria-label="Decline this quote">
                  <p>Decline this price? Your request stays open for a new one.</p>
                  <div className={stage.confirmActions}>
                    <button type="button" className={shell.secondaryAction} onClick={() => void decline()} disabled={busy}>
                      {busy ? <ArcLoader size="sm" label="Declining" tone="inherit" /> : null}
                      Decline quote
                    </button>
                    <button type="button" className={`${shell.textAction} ${stage.onField}`} onClick={() => setDeclining(false)} disabled={busy}>
                      Keep it
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={stage.decideRow}>
                    <Countdown sentAt={quote.sentAt ? new Date(quote.sentAt) : null} expiresAt={expiresAt} now={now} variant="ring" />
                    <button type="button" className={stage.accept} data-robot-target="cta" onClick={() => void accept()} disabled={busy} aria-busy={busy || undefined}>
                      {busy ? <ArcLoader size="sm" label="Accepting" tone="inherit" /> : null}
                      <span>Accept quote at {rate}</span>
                      {busy ? null : <ArrowIcon className={shell.actionIcon} />}
                    </button>
                  </div>
                  <button type="button" className={`${shell.textAction} ${stage.onField}`} onClick={() => setDeclining(true)} disabled={busy}>
                    Decline
                  </button>
                </>
              )
            ) : (
              <p className={stage.cannot}>
                <InfoIcon className={shell.infoIcon} />
                <span>Only someone with acceptance rights can take this price.</span>
              </p>
            )}
            {error ? (
              <p className={stage.error} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </section>
      {dialog}
    </>
  );
}
