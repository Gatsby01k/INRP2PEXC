'use client';

import { useState } from 'react';
import { Rate } from '@inrp2p/kernel';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { withdrawRequestAction } from '../../../server/actions/client.ts';
import { at } from '../_assistant/model.ts';
import { InfoIcon } from '../_workspace/icons.tsx';
import { legAmount } from './amounts.ts';
import { LEGS, LegStatic } from './Legs.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

/**
 * A request the desk has, as the same ticket the client filled in — now still, with the side the desk is pricing
 * saying so — and above it the one thing that is happening: the desk is pricing it, and the quote will appear right
 * here. If the desk's last quote for it ran out, that is said first. Withdrawing closes it for good, so it asks once.
 */
export function PricingCard({ view }: { view: ExchangeView }) {
  const { run, busy, error, dialog } = useCommand();
  const [withdrawing, setWithdrawing] = useState(false);
  const request = view.request!;
  const expired = view.quote;
  const sell = request.direction === 'SELL_USDT';

  const withdraw = async () => {
    const out = await run('Withdraw this request', (key) => withdrawRequestAction({ requestRef: request.ref }, key));
    if (!out.ok) robotCues.emit({ kind: 'problem' });
    setWithdrawing(false);
  };

  return (
    <>
      <section className={`${shell.surface} ${styles.ticket}`} aria-label="Request with the desk" data-robot-target="panel">
        <header className={styles.quoteHead}>
          <div className={styles.quoteId}>
            <span className={shell.label}>Request</span>
            <span className={styles.quoteRef}>
              {request.ref}
              <span className={styles.side}>{sell ? 'Sell USDT' : 'Buy USDT'}</span>
            </span>
          </div>
          <span className={shell.muted}>Sent {at(request.createdAt)}</span>
        </header>

        {expired ? (
          <p className={shell.info} data-tone="warning" role="status">
            <InfoIcon className={shell.infoIcon} />
            <span>
              Quote {expired.ref} at {formatRate(Rate.parse(expired.clientRate, 'CLIENT'))}
              {expired.expiresAt ? ` ran out at ${formatIstTime(new Date(expired.expiresAt))}` : ' ran out'} before it was accepted. The desk has been told and may send a new
              one here.
            </span>
          </p>
        ) : null}

        <div className={styles.pricing} role="status">
          <ArcLoader size="md" label="The desk is pricing this request" />
          <span className={styles.pricingText}>
            <span className={styles.pricingTitle}>The desk is pricing your request</span>
            <span className={styles.pricingBody}>Your firm quote appears right here the moment it is sent — no need to reload.</span>
          </span>
        </div>

        <div className={styles.legs} data-robot-target="amount">
          {LEGS[request.direction].map((leg) => (
            <LegStatic key={leg.currency} label={leg.label} currency={leg.currency} amount={leg.currency === request.currency ? legAmount(request.amount, leg.currency) : null} />
          ))}
        </div>

        <dl className={styles.terms}>
          <div>
            <dt>{sell ? 'INR paid to' : 'USDT delivered to'}</dt>
            <dd>{request.destination}</dd>
          </div>
          {request.targetRate ? (
            <div>
              <dt>Your target rate</dt>
              <dd>{formatRate(Rate.parse(request.targetRate, 'CLIENT'))} per USDT</dd>
            </div>
          ) : null}
        </dl>

        {withdrawing ? (
          <div className={styles.confirmRow} role="group" aria-label="Withdraw this request">
            <p>Withdrawing closes {request.ref}, and the desk stops pricing it.</p>
            <div className={styles.confirmActions}>
              <button type="button" className={shell.secondaryAction} onClick={() => void withdraw()} disabled={busy}>
                {busy ? <ArcLoader size="sm" label="Withdrawing" tone="inherit" /> : null}
                Withdraw request
              </button>
              <button type="button" className={shell.textAction} onClick={() => setWithdrawing(false)} disabled={busy}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div>
            <button type="button" className={shell.textAction} onClick={() => setWithdrawing(true)}>
              Withdraw the request
            </button>
          </div>
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
