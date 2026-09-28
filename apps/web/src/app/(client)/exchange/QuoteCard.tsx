'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Rate } from '@inrp2p/kernel';
import type { ClientQuoteView } from '@inrp2p/quotes';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { acceptQuoteAction, rejectQuoteAction } from '../../../server/actions/client.ts';
import { playSound } from '../_assistant/sound.ts';
import { ArrowIcon, InfoIcon } from '../_workspace/icons.tsx';
import { HeldFor } from './HeldFor.tsx';
import { legAmount } from './amounts.ts';
import { LEGS } from './Legs.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

/**
 * A firm quote the desk has sent, as an execution ticket: which quote and which side, how long it is held, what
 * leaves and what arrives, at what rate, on what terms — and the decision. The countdown runs on the database's
 * clock. Accepting opens the trade and takes the client straight to it; declining is a formal answer to the desk,
 * so it asks once before it is sent.
 */
export function QuoteCard({ quote, canAccept, now }: { quote: ClientQuoteView; canAccept: boolean; now: number }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [declining, setDeclining] = useState(false);
  const expiresAt = new Date(quote.expiresAt!);
  const sell = quote.direction === 'SELL_USDT';
  const rate = formatRate(Rate.parse(quote.clientRate, 'CLIENT'));

  const accept = async () => {
    robotCues.emit({ kind: 'wait', on: true });
    const out = await run('Accept this quote', (key) => acceptQuoteAction({ quoteRef: quote.ref }, key));
    robotCues.emit({ kind: 'wait', on: false });
    if (out.ok) {
      robotCues.emit({ kind: 'lock' });
      playSound('success');
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
        <header className={styles.ticketHead}>
          <div className={styles.ticketId}>
            <span className={shell.label}>Firm quote</span>
            <span className={styles.ticketRef}>{quote.ref}</span>
            <span className={styles.side}>{sell ? 'Sell USDT' : 'Buy USDT'}</span>
          </div>
          <HeldFor expiresAt={expiresAt} now={now} />
        </header>

        <dl className={styles.ledger}>
          {LEGS[quote.direction].map((leg) => (
            <div key={leg.currency} className={styles.ledgerRow}>
              <dt>{leg.label}</dt>
              <dd>
                <span className={styles.figure}>{legAmount(leg.currency === 'USDT' ? quote.base.amount : quote.inr.amount, leg.currency)}</span>
                <span className={styles.unit}>{leg.currency}</span>
              </dd>
            </div>
          ))}
        </dl>

        <div className={styles.rate} data-robot-target="rate">
          <div className={styles.headText}>
            <span className={shell.label}>Your rate</span>
            <span className={styles.rateFigure}>
              <span className={styles.rateValue}>{rate}</span>
              <span className={styles.rateUnit}>/ USDT</span>
            </span>
          </div>
          <span className={styles.rateNote}>Locked until {formatIstTime(expiresAt)}</span>
        </div>

        <dl className={`${shell.facts} ${styles.terms}`}>
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
              <button type="button" className={shell.action} data-robot-target="cta" onClick={() => void accept()} disabled={busy} aria-busy={busy || undefined}>
                {busy ? <ArcLoader size="sm" label="Accepting" tone="inherit" /> : null}
                <span>Accept quote at {rate}</span>
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
