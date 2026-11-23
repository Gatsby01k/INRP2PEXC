'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Rate } from '@inrp2p/kernel';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstDateTime, formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { withdrawRequestAction } from '../../../server/actions/client.ts';
import { requestAmount, type Step } from '../_assistant/model.ts';
import { ArrowIcon, BellIcon, ClockIcon, InfoIcon, MailIcon, PlaneIcon } from '../_workspace/icons.tsx';
import { legAmount } from './amounts.ts';
import { RequestSheet } from './RequestSheet.tsx';
import { StagePanel } from './StagePanel.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';
import stage from './stage.module.css';

/** How the client hears that its price is ready: its Telegram, when linked, and its email, when it has a real one. */
export interface WaitingAlerts {
  readonly telegram: { readonly on: boolean; readonly username: string | null };
  readonly email: string | null;
}

/**
 * ADR 0032: a request nothing priced is not turned away. It waits, and this is what the client sees while it does — the
 * request on its sheet, still; beside it the stage, saying in one sentence what happens next: a trader is being found, the
 * price is held for the client when one is, and it is told where it will hear. It can close the page. What a trader takes
 * right now, when there is something, is one tap away — the form comes back with the direction kept.
 */
export function WaitingCard({ view, alerts, steps }: { view: ExchangeView; alerts: WaitingAlerts; steps?: readonly Step[] }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  const [stopping, setStopping] = useState(false);
  const request = view.request!;
  const until = new Date(request.waitingUntil!);
  const sameDay = formatIstDateTime(until).split(',')[0] === formatIstDateTime(new Date(request.createdAt)).split(',')[0];
  const lookingUntil = sameDay ? formatIstTime(until) : formatIstDateTime(until);
  const lapsed = view.quote;

  const stop = async (then?: () => void) => {
    const out = await run('Stop looking for a trader', (key) => withdrawRequestAction({ requestRef: request.ref }, key));
    if (!out.ok) {
      robotCues.emit({ kind: 'problem' });
      return;
    }
    setStopping(false);
    then?.();
  };
  // Another amount is a new request: this one is withdrawn, and the form comes back on the same side.
  const changeAmount = () => void stop(() => router.push(`/exchange?direction=${request.direction === 'BUY_USDT' ? 'buy' : 'sell'}`));

  return (
    <>
      <section className={stage.deal} data-even="" data-waiting="" aria-label="Request waiting for a trader" data-robot-target="panel">
        <RequestSheet
          direction={request.direction}
          amount={legAmount(request.amount, request.currency)}
          currency={request.currency}
          destination={request.destination}
          destinations={view.destinations}
          targetRate={request.targetRate ? formatRate(Rate.parse(request.targetRate, 'CLIENT')) : null}
          sentAt={formatIstTime(new Date(request.createdAt))}
          reference={request.ref}
          networkFee={null}
        >
          {stopping ? (
            <div className={styles.confirmRow} role="group" aria-label="Stop looking for a trader">
              <p>We stop looking for a trader for {request.ref}. Nothing was committed, and you can ask again any time.</p>
              <div className={styles.confirmActions}>
                <button type="button" className={shell.secondaryAction} onClick={() => void stop()} disabled={busy}>
                  {busy ? <ArcLoader size="sm" label="Stopping" tone="inherit" /> : null}
                  Stop looking
                </button>
                <button type="button" className={shell.textAction} onClick={() => setStopping(false)} disabled={busy}>
                  Keep looking
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.waitActions}>
              <button type="button" className={`${shell.secondaryAction} ${shell.wide}`} onClick={changeAmount} disabled={busy}>
                {busy ? <ArcLoader size="sm" label="Changing the amount" tone="inherit" /> : null}
                Change the amount
              </button>
              <button type="button" className={shell.textAction} onClick={() => setStopping(true)} disabled={busy}>
                Stop looking
              </button>
            </div>
          )}
          {error ? (
            <p className={shell.error} role="alert">
              {error}
            </p>
          ) : null}
        </RequestSheet>

        <StagePanel
          mood="waiting"
          live
          chip={
            <>
              <ArcLoader size="sm" tone="inherit" label="Finding you a trader" />
              <span>Finding a trader</span>
            </>
          }
          refText={request.ref}
          title="We’re finding you a trader"
          body={
            <>
              No trader has a price for {requestAmount(request)} this minute. Your request stays on: the moment one does, we hold
              the price for you for 10 minutes and tell you. You can close this page.
            </>
          }
          steps={steps}
        >
          <ul className={stage.facts} aria-label="Where you hear it">
            {alerts.telegram.on ? (
              <li className={stage.fact}>
                <PlaneIcon />
                <span>Telegram{alerts.telegram.username ? ` · @${alerts.telegram.username}` : ''}</span>
              </li>
            ) : null}
            {alerts.email ? (
              <li className={stage.fact}>
                <MailIcon />
                <span>{alerts.email}</span>
              </li>
            ) : null}
            <li className={stage.fact}>
              <BellIcon />
              <span>Right here</span>
            </li>
            <li className={`${stage.fact} ${stage.factQuiet}`}>
              <ClockIcon />
              <span>
                Looking until <span className={stage.factFigure}>{lookingUntil}</span>
              </span>
            </li>
          </ul>
          {request.readyNow ? (
            <p className={stage.stageNote} role="status">
              <InfoIcon />
              <span>{request.readyNow}</span>
            </p>
          ) : null}
          {lapsed ? (
            <p className={stage.stageNote} role="status">
              <InfoIcon />
              <span>Quote {lapsed.ref} ran out before it was accepted. We are looking again.</span>
            </p>
          ) : null}
          {alerts.telegram.on ? null : (
            <Link className={stage.accept} href="/account#telegram">
              <PlaneIcon />
              Tell me on Telegram
              <ArrowIcon />
            </Link>
          )}
        </StagePanel>
      </section>
      {dialog}
    </>
  );
}
