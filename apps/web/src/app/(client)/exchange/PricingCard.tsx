'use client';

import { useState } from 'react';
import { Rate } from '@inrp2p/kernel';
import type { ExchangeView } from '@inrp2p/portal';
import { ArcLoader } from '@inrp2p/ui';
import { formatIstTime, formatRate } from '@inrp2p/ui/format';
import { robotCues } from '../../(public)/_landing/robot/cues.ts';
import { useCommand } from '../../../components/useCommand.tsx';
import { repriceAction, withdrawRequestAction } from '../../../server/actions/client.ts';
import type { Step } from '../_assistant/model.ts';
import { InfoIcon } from '../_workspace/icons.tsx';
import { legAmount } from './amounts.ts';
import shell from '../shell.module.css';
import styles from './exchange.module.css';
import stage from './stage.module.css';
import { StagePanel } from './StagePanel.tsx';
import { RobotSays } from '../_robot/RobotSays.tsx';
import { pricingSpeech } from '../_robot/speech.ts';
import { RequestSheet } from './RequestSheet.tsx';

/**
 * A request the desk has: the same ticket the client filled in, now still, on its sheet — and beside it the stage,
 * saying the one thing that is happening: the desk is pricing it, and the quote will appear right there. If the
 * desk's last quote for it ran out, the stage says that too. Withdrawing closes it for good, so it asks once.
 */
export function PricingCard({ view, steps }: { view: ExchangeView; steps?: readonly Step[] }) {
  const { run, busy, error, dialog } = useCommand();
  const [withdrawing, setWithdrawing] = useState(false);
  const request = view.request!;
  const expired = view.quote;

  const withdraw = async () => {
    const out = await run('Withdraw this request', (key) => withdrawRequestAction({ requestRef: request.ref }, key));
    if (!out.ok) robotCues.emit({ kind: 'problem' });
    setWithdrawing(false);
  };
  // ADR 0025: a price that ran out is asked for again in one tap, at the market as it is now.
  const reprice = async () => {
    const out = await run('Get a new price', (key) => repriceAction({ requestRef: request.ref }, key));
    if (!out.ok) robotCues.emit({ kind: 'problem' });
  };
  const gathering = request.gatheringUntil !== null;

  return (
    <>
      <section className={stage.deal} data-even="" aria-label="Request with the desk" data-robot-target="panel">
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
            <button type="button" className={`${shell.secondaryAction} ${shell.wide}`} onClick={() => setWithdrawing(true)}>
              Withdraw the request
            </button>
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
              <ArcLoader size="sm" tone="inherit" label={gathering ? 'Getting the best price for this amount' : 'The desk is pricing this request'} />
              <span>{gathering ? 'Gathering prices' : 'With the desk'}</span>
            </>
          }
          refText={request.ref}
          title={gathering ? 'Getting the best price for this amount' : 'The desk is pricing your request'}
          body={
            gathering
              ? `A larger amount takes a moment longer: your firm price appears right here by ${formatIstTime(new Date(request.gatheringUntil!))} — no need to reload.`
              : 'It appears here the moment it is sent.'
          }
          steps={steps}
          robot={expired ? undefined : <RobotSays speech={pricingSpeech(request)} live={false} />}
        >
          {expired ? (
            <p className={stage.stageNote} role="status">
              <InfoIcon />
              <span>
                Quote {expired.ref} at {formatRate(Rate.parse(expired.clientRate, 'CLIENT'))}
                {expired.expiresAt ? ` ran out at ${formatIstTime(new Date(expired.expiresAt))}` : ' ran out'} before it was accepted.
                {request.canReprice ? ' Get a new price at the market as it is now.' : ' The desk has been told and may send a new one here.'}
              </span>
            </p>
          ) : null}
          {request.canReprice && expired ? (
            <button type="button" className={stage.accept} onClick={() => void reprice()} disabled={busy}>
              {busy ? <ArcLoader size="sm" label="Getting a new price" tone="inherit" /> : null}
              Get a new price
            </button>
          ) : null}
        </StagePanel>
      </section>
      {dialog}
    </>
  );
}
