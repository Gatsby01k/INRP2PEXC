'use client';

import { useState } from 'react';
import { Rate } from '@inrp2p/kernel';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { withdrawRequestAction } from '../../../server/actions/client.ts';
import { at, requestSteps } from '../_assistant/model.ts';
import { InfoIcon } from '../_workspace/icons.tsx';
import { Stepper } from '../_workspace/Stepper.tsx';
import { legAmount } from './amounts.ts';
import { LEGS, LegStatic } from './Legs.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

/**
 * A request the desk has: what was asked, where it goes, how far it has got — and, if the desk's last quote for
 * it ran out, that it did. Withdrawing closes it for good, so it asks once before it is sent.
 */
export function PricingCard({ view, now }: { view: ExchangeView; now: number }) {
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
        <div className={styles.head}>
          <div className={styles.headText}>
            <span className={shell.label}>Request</span>
            <span className={styles.ref}>{request.ref}</span>
          </div>
          <span className={styles.pricing}>
            <ArcLoader size="sm" label="The desk is pricing this request" />
            With the desk
          </span>
        </div>

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

        <div className={styles.legs} data-robot-target="amount">
          {LEGS[request.direction].map((leg) => (
            <LegStatic key={leg.currency} label={leg.label} currency={leg.currency} amount={leg.currency === request.currency ? legAmount(request.amount, leg.currency) : null} />
          ))}
        </div>

        <dl className={shell.facts}>
          <div>
            <dt>{sell ? 'Receive INR to' : 'Deliver USDT to'}</dt>
            <dd>{request.destination}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd>{at(request.createdAt)}</dd>
          </div>
        </dl>

        <hr className={styles.divider} />
        <Stepper steps={requestSteps(view, now)} label="From request to trade" />

        <p className={shell.info}>
          <InfoIcon className={shell.infoIcon} />
          <span>This page shows the desk’s quote as soon as it is sent — no need to reload. It also arrives in Notifications.</span>
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
