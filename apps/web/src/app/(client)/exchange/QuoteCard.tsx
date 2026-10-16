'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Rate } from '@inrp2p/kernel';
import type { ClientQuoteView } from '@inrp2p/quotes';
import { ArcLoader, EXPIRING_THRESHOLD_MS } from '@inrp2p/ui';
import { formatCountdown, formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { acceptQuoteAction, rejectQuoteAction } from '../../../server/actions/client.ts';
import { playSound } from '../_assistant/sound.ts';
import { ArrowIcon, InfoIcon, LockIcon } from '../_workspace/icons.tsx';
import { legAmount } from './amounts.ts';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

const R = 34;
const C = 2 * Math.PI * R;

/**
 * How long the quote is still held: one thin arc in the brand's orange that runs down to nothing, the time left
 * inside it, turning amber in the last seconds — never flashing. Drawn against the whole time the desk held it for
 * (sent → expiry), on the database's clock.
 */
export function Countdown({ sentAt, expiresAt, now }: { sentAt: Date | null; expiresAt: Date; now: number }) {
  const first = useRef(Math.max(1, expiresAt.getTime() - now));
  const total = sentAt ? Math.max(1, expiresAt.getTime() - sentAt.getTime()) : first.current;
  const remaining = Math.max(0, expiresAt.getTime() - now);
  const fraction = Math.min(1, remaining / total);
  return (
    <span className={styles.timer} data-state={remaining <= EXPIRING_THRESHOLD_MS ? 'expiring' : 'held'} role="timer" aria-live="off">
      <svg className={styles.timerRing} viewBox="0 0 76 76" aria-hidden="true" focusable="false">
        <circle className={styles.timerTrack} cx="38" cy="38" r={R} />
        <circle className={styles.timerArc} cx="38" cy="38" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - fraction)} />
      </svg>
      <span className={styles.timerText}>
        <span className={styles.timerTime}>{formatCountdown(remaining)}</span>
        <span className={styles.timerLabel}>held</span>
      </span>
      <span className="ix-visually-hidden">, held until {formatIstTime(expiresAt)}</span>
    </span>
  );
}

/**
 * A firm quote the desk has sent, as an execution ticket: what the client gets — as large as the page allows —
 * for what they give, the rate locked inside it, how long it is held, where the money lands, and the decision.
 * Accepting opens the trade and takes the client straight to it; declining is a formal answer to the desk, so it
 * asks once before it is sent.
 */
export function QuoteCard({ quote, canAccept, now }: { quote: ClientQuoteView; canAccept: boolean; now: number }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [declining, setDeclining] = useState(false);
  const expiresAt = new Date(quote.expiresAt!);
  const sell = quote.direction === 'SELL_USDT';
  const rate = formatRate(Rate.parse(quote.clientRate, 'CLIENT'));
  const usdt = legAmount(quote.base.amount, 'USDT');
  const inr = legAmount(quote.inr.amount, 'INR');

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
      <section className={`${shell.surface} ${styles.ticket}`} aria-label="Firm quote" data-robot-target="panel">
        <header className={styles.quoteHead}>
          <div className={styles.quoteId}>
            <span className={shell.label}>Firm quote</span>
            <span className={styles.quoteRef}>
              {quote.ref}
              <span className={styles.side}>{sell ? 'Sell USDT' : 'Buy USDT'}</span>
            </span>
          </div>
          <Countdown sentAt={quote.sentAt ? new Date(quote.sentAt) : null} expiresAt={expiresAt} now={now} />
        </header>

        <div className={styles.hero}>
          <span className={styles.heroLabel}>You receive</span>
          <span className={styles.heroFigure}>
            {sell ? `₹${inr}` : usdt}
            <span className={styles.heroUnit}>{sell ? 'INR' : 'USDT'}</span>
          </span>
          <span className={styles.heroSub}>{sell ? `You send ${usdt} USDT` : `You pay ₹${inr}`} · exactly, nothing is deducted</span>
        </div>

        <div className={styles.rate} data-robot-target="rate">
          <span className={styles.rateMain}>
            <span className={styles.rateLock} aria-hidden="true">
              <LockIcon />
            </span>
            <span>
              <span className={styles.rateValue}>{rate}</span>
              <span className={styles.rateUnit}>per USDT</span>
            </span>
          </span>
          <span className={styles.rateNote}>Locked until {formatIstTime(expiresAt)}</span>
        </div>

        <dl className={styles.terms}>
          <div>
            <dt>{sell ? 'INR paid to' : 'USDT delivered to'}</dt>
            <dd>{quote.destination}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>USDT on TRON (TRC20)</dd>
          </div>
          {quote.networkFeeIncluded ? (
            <div>
              <dt>Fees</dt>
              <dd>Included in the rate, with the TRC20 network fee of ₹{legAmount(quote.networkFeeIncluded.amount, 'INR')}</dd>
            </div>
          ) : null}
          <div>
            <dt>Settlement</dt>
            <dd>{sell ? 'Send your USDT to the trade’s own address; INR follows in one or more transfers, each with its bank reference.' : 'Pay the INR; the USDT is sent to your wallet once it is confirmed.'}</dd>
          </div>
        </dl>

        {canAccept ? (
          declining ? (
            <div className={styles.confirmRow} role="group" aria-label="Decline this quote">
              <p>Declining tells the desk you will not take this price, and it can no longer be accepted. Your request stays open for a new quote.</p>
              <div className={styles.confirmActions}>
                <button type="button" className={shell.secondaryAction} onClick={() => void decline()} disabled={busy}>
                  {busy ? <ArcLoader size="sm" label="Declining" tone="inherit" /> : null}
                  Decline quote
                </button>
                <button type="button" className={shell.textAction} onClick={() => setDeclining(false)} disabled={busy}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.decide}>
              <button type="button" className={`${shell.action} ${shell.wide}`} data-robot-target="cta" onClick={() => void accept()} disabled={busy} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Accepting" tone="inherit" /> : null}
                <span>Accept quote at {rate}</span>
                {busy ? null : <ArrowIcon className={shell.actionIcon} />}
              </button>
              <button type="button" className={`${shell.textAction} ${styles.decline}`} onClick={() => setDeclining(true)} disabled={busy}>
                Decline
              </button>
            </div>
          )
        ) : (
          <p className={shell.info} data-tone="warning">
            <InfoIcon className={shell.infoIcon} />
            <span>Your account can see quotes but not accept them. Someone with acceptance rights has to decide on this one.</span>
          </p>
        )}
        {error ? (
          <p className={shell.error} role="alert">
            {error}
          </p>
        ) : null}
      </section>
      {dialog}
    </>
  );
}
