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
import { LEGS } from './Legs.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

/**
 * A request the desk has, as a ticket: what was asked — the side the client fixed, and the side the desk is
 * pricing — where it goes, and, if the desk's last quote for it ran out, that it did. Withdrawing closes it for
 * good, so it asks once before it is sent.
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
      <section className={shell.surface} aria-label="Request with the desk" data-robot-target="panel">
        <header className={styles.ticketHead}>
          <div className={styles.ticketId}>
            <span className={shell.label}>Request</span>
            <span className={styles.ticketRef}>{request.ref}</span>
            <span className={styles.side}>{sell ? 'Sell USDT' : 'Buy USDT'}</span>
          </div>
          <span className={styles.pricing}>
            <ArcLoader size="sm" label="The desk is pricing this request" />
            With the desk
          </span>
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

        <dl className={styles.ledger} data-robot-target="amount">
          {LEGS[request.direction].map((leg) => (
            <div key={leg.currency} className={styles.ledgerRow}>
              <dt>{leg.label}</dt>
              <dd>
                {leg.currency === request.currency ? (
                  <span className={styles.figure}>{legAmount(request.amount, leg.currency)}</span>
                ) : (
                  <span className={styles.figurePending}>Priced by the desk</span>
                )}
                <span className={styles.unit}>{leg.currency}</span>
              </dd>
            </div>
          ))}
        </dl>

        <dl className={`${shell.facts} ${styles.terms}`}>
          <div>
            <dt>{sell ? 'Receive INR to' : 'Deliver USDT to'}</dt>
            <dd>{request.destination}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd>{at(request.createdAt)}</dd>
          </div>
        </dl>

        <p className={shell.info}>
          <InfoIcon className={shell.infoIcon} />
          <span>The desk’s quote appears here as soon as it is sent — no need to reload. It also arrives in Notifications.</span>
        </p>

        {withdrawing ? (
          <div className={styles.confirmRow} role="group" aria-label="Withdraw this request">
            <p>Withdrawing closes {request.ref}, and the desk stops pricing it.</p>
            <button type="button" className={shell.secondaryAction} onClick={() => void withdraw()} disabled={busy}>
              {busy ? <ArcLoader size="sm" label="Withdrawing" tone="inherit" /> : null}
              Withdraw request
            </button>
            <button type="button" className={shell.textAction} onClick={() => setWithdrawing(false)} disabled={busy}>
              Keep it
            </button>
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
