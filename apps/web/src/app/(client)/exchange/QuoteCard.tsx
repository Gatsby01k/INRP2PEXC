'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Rate } from '@inrp2p/kernel';
import type { ClientQuoteView } from '@inrp2p/quotes';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader, EXPIRING_THRESHOLD_MS } from '@inrp2p/ui';
import { formatCountdown, formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { acceptQuoteAction, rejectQuoteAction } from '../../../server/actions/client.ts';
import { requestSteps } from '../_assistant/model.ts';
import { ArrowIcon, ClockIcon, InfoIcon } from '../_workspace/icons.tsx';
import { Stepper } from '../_workspace/Stepper.tsx';
import { legAmount } from './amounts.ts';
import { LEGS } from './Legs.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

/**
 * A firm quote the desk has sent, counting down on the database's clock. Accepting opens the trade and takes the
 * client straight to it; declining is a formal answer to the desk, so it asks once before it is sent.
 */
export function QuoteCard({ view, quote, canAccept, now }: { view: ExchangeView; quote: ClientQuoteView; canAccept: boolean; now: number }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [declining, setDeclining] = useState(false);
  const expiresAt = new Date(quote.expiresAt!);
  const remaining = Math.max(0, expiresAt.getTime() - now);
  const expiring = remaining <= EXPIRING_THRESHOLD_MS;
  const sell = quote.direction === 'SELL_USDT';

  const accept = async () => {
    robotCues.emit({ kind: 'wait', on: true });
    const out = await run('Accept this quote', (key) => acceptQuoteAction({ quoteRef: quote.ref }, key));
    robotCues.emit({ kind: 'wait', on: false });
    if (out.ok) {
      robotCues.emit({ kind: 'lock' });
      router.push(`/trades/${out.result.tradeRef}`);
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
      <section className={shell.surface} aria-label="Firm quote" data-robot-target="panel">
        <div className={styles.head}>
          <div className={styles.headText}>
            <span className={shell.label}>Firm quote</span>
            <span className={styles.ref}>{quote.ref}</span>
          </div>
          <span className={styles.countdown} data-state={expiring ? 'expiring' : 'held'} role="timer" aria-live="off">
            <ClockIcon />
            <span>
              Held for <span className={styles.countdownTime}>{formatCountdown(remaining)}</span>
            </span>
            <span className="ix-visually-hidden">, until {formatIstTime(expiresAt)}</span>
          </span>
        </div>

        <div className={styles.legs}>
          {LEGS[quote.direction].map((leg) => (
            <div key={leg.currency} className={styles.leg} data-fixed="true">
              <span className={styles.legLabel}>{leg.label}</span>
              <div className={styles.legBox}>
                <span className={styles.legValue}>{legAmount(leg.currency === 'USDT' ? quote.base.amount : quote.inr.amount, leg.currency)}</span>
                <span className={styles.currency}>
                  <span className={styles.coin} data-coin={leg.currency} aria-hidden="true">
                    {leg.currency === 'INR' ? '₹' : '₮'}
                  </span>
                  {leg.currency}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className={styles.rate} data-robot-target="rate">
          <div className={styles.headText}>
            <span className={shell.label}>Your rate</span>
            <span className={styles.rateFigure}>
              <span className={styles.rateValue}>{formatRate(Rate.parse(quote.clientRate, 'CLIENT'))}</span>
              <span className={styles.rateUnit}>/ USDT</span>
            </span>
          </div>
          <span className={styles.rateNote}>Locked until {formatIstTime(expiresAt)}</span>
        </div>

        <dl className={shell.facts}>
          <div>
            <dt>{sell ? 'Receive INR to' : 'Deliver USDT to'}</dt>
            <dd>{quote.destination}</dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>USDT on TRC20</dd>
          </div>
          <div>
            <dt>Settlement</dt>
            <dd>{sell ? 'INR in one or more transfers, each with its bank reference' : 'USDT to your wallet once your INR is confirmed'}</dd>
          </div>
        </dl>

        <hr className={styles.divider} />
        <Stepper steps={requestSteps(view, now)} label="From request to trade" />

        {canAccept ? (
          declining ? (
            <div className={styles.confirmRow} role="group" aria-label="Decline this quote">
              <p>Declining tells the desk you will not take this price, and it can no longer be accepted. Your request stays open for a new quote.</p>
              <button type="button" className={shell.secondaryAction} onClick={() => void decline()} disabled={busy}>
                {busy ? <ArcLoader size="sm" label="Declining" tone="inherit" /> : null}
                Decline quote
              </button>
              <button type="button" className={shell.textAction} onClick={() => setDeclining(false)} disabled={busy}>
                Keep it
              </button>
            </div>
          ) : (
            <div className={styles.actions}>
              <button
                type="button"
                className={shell.action}
                data-robot-target="cta"
                onClick={() => void accept()}
                disabled={busy}
                aria-busy={busy || undefined}
                onPointerEnter={() => robotCues.setFocus('cta')}
                onPointerLeave={() => robotCues.setFocus('none')}
                onFocus={() => robotCues.setFocus('cta')}
                onBlur={() => robotCues.setFocus('none')}
              >
                {busy ? <ArcLoader size="sm" label="Accepting" tone="inherit" /> : null}
                <span>Accept quote</span>
                {busy ? null : <ArrowIcon className={shell.actionIcon} />}
              </button>
              <button type="button" className={shell.secondaryAction} onClick={() => setDeclining(true)} disabled={busy}>
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
