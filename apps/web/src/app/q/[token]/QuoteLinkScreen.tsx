'use client';

import { useState } from 'react';
import { Money, Rate } from '@inrp2p/kernel';
import type { QuoteLinkView } from '@inrp2p/quotes';
import { AcceptanceVerification, Button, FirmQuote, type FirmQuoteState, type VerificationState } from '@inrp2p/ui';
import { newIntentKey } from '../../../components/useCommand.tsx';
import { acceptViaLinkAction, rejectViaLinkAction, requestLinkOtpAction } from '../../../server/actions/link.ts';
import styles from './link.module.css';

type Stage =
  | { kind: 'quote' }
  | { kind: 'dismissed' }
  | { kind: 'verify'; intent: 'accept' | 'reject' }
  | { kind: 'accepted'; tradeRef: string }
  | { kind: 'rejected' };

/**
 * Two steps, in this order, always: read the quote, then prove who you are.
 *
 * The decision is made by the server, in one command, against a code it issued — this component holds no
 * authority and keeps no secret. It shows masked recipients the server chose, sends the code back, and reports
 * whatever the server answered in the server's own words, because an OTP failure message that guesses is a
 * message that tells an attacker something.
 */
export function QuoteLinkScreen({ view, token }: { view: QuoteLinkView; token: string }) {
  const [stage, setStage] = useState<Stage>({ kind: 'quote' });
  const [recipientId, setRecipientId] = useState(view.recipients[0]?.clientUserId ?? '');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const quote = view.quote;
  const live = quote.status === 'SENT';

  if (stage.kind === 'accepted') {
    return (
      <section className={styles.outcome} aria-label="Accepted">
        <h1 className={styles.outcomeTitle}>Accepted</h1>
        <p className={styles.body}>
          {quote.ref} is now trade {stage.tradeRef}. Sign in to the exchange to follow it — the trade reference is all you need.
        </p>
      </section>
    );
  }

  if (stage.kind === 'dismissed') {
    // D-15 / SECURITY §2.3: "Not now" is a local dismissal and nothing else. The quote stays SENT until it is
    // formally rejected with a code, cancelled by the desk, superseded or simply runs out. Saying so is the
    // point — a client who thinks they have declined, and has not, is a client the desk will chase.
    return (
      <section className={styles.outcome} aria-label="Put aside">
        <h1 className={styles.outcomeTitle}>Put aside</h1>
        <p className={styles.body}>
          Nothing has been sent to the desk. {quote.ref} is still open until it runs out, so you can come back to this link and accept it while it lasts.
        </p>
        <Button intent="secondary" fullWidth onClick={() => setStage({ kind: 'quote' })}>
          Back to the quote
        </Button>
        <Button intent="ghost" size="sm" onClick={() => setStage({ kind: 'verify', intent: 'reject' })}>
          Tell the desk you are declining
        </Button>
      </section>
    );
  }

  if (stage.kind === 'rejected') {
    return (
      <section className={styles.outcome} aria-label="Declined">
        <h1 className={styles.outcomeTitle}>Declined</h1>
        <p className={styles.body}>{quote.ref} was declined. The desk has been told; ask for a new price whenever you are ready.</p>
      </section>
    );
  }

  if (stage.kind === 'verify') {
    const state: VerificationState = challengeId ? (error ? 'invalid' : 'sent') : 'choose';
    return (
      <>
        <AcceptanceVerification
          state={state}
          intent={stage.intent}
          recipients={view.recipients.map((r) => ({ id: r.clientUserId, masked: r.destination }))}
          selectedRecipientId={recipientId}
          onSelectRecipient={setRecipientId}
          code={code}
          onCodeChange={setCode}
          busy={busy}
          {...(attemptsRemaining === undefined ? {} : { attemptsRemaining })}
          onSend={() => {
            setError(null);
            setBusy(true);
            void requestLinkOtpAction({ token, clientUserId: recipientId })
              .then((out) => {
                if (out.ok) setChallengeId(out.result.challengeId);
                else setError(out.message);
              })
              .finally(() => setBusy(false));
          }}
          onConfirm={() => {
            if (!challengeId) return;
            setError(null);
            setBusy(true);
            const key = newIntentKey();
            const decide = stage.intent === 'accept' ? acceptViaLinkAction : rejectViaLinkAction;
            void decide({ token, challengeId, code }, key)
              .then((out) => {
                if (!out.ok) {
                  setError(out.message);
                  // The server says how many tries are left; the page repeats that and never guesses it.
                  const left = out.details?.attemptsRemaining;
                  setAttemptsRemaining(typeof left === 'number' ? left : undefined);
                  return;
                }
                setStage(stage.intent === 'accept' ? { kind: 'accepted', tradeRef: (out.result as { tradeRef: string }).tradeRef } : { kind: 'rejected' });
              })
              .finally(() => setBusy(false));
          }}
          onCancel={() => {
            setStage({ kind: 'quote' });
            setChallengeId(null);
            setCode('');
            setError(null);
          }}
        />
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </>
    );
  }

  const state: FirmQuoteState = live ? 'LOCKED' : quote.status === 'EXPIRED' ? 'EXPIRED' : 'UNAVAILABLE';
  const expiresAt = quote.expiresAt ? new Date(quote.expiresAt) : undefined;
  return (
    <>
      <FirmQuote
        state={state}
        direction={quote.direction}
        base={Money.parse(quote.base.amount, 'USDT')}
        inr={Money.parse(quote.inr.amount, 'INR')}
        rate={Rate.parse(quote.clientRate, 'CLIENT')}
        network="TRC20"
        destinationLabel={quote.destination}
        now={new Date(view.serverTime)}
        settlementNote="INR in one or more transfers, tracked per payment reference"
        {...(expiresAt ? { expiresAt } : {})}
        {...(live && view.recipients.length > 0
          ? {
              onAccept: () => setStage({ kind: 'verify', intent: 'accept' }),
              // Local only. Telling the desk is a separate, deliberate act that needs a code (D-15).
              onDecline: () => setStage({ kind: 'dismissed' }),
            }
          : {})}
      />
      {live && view.recipients.length === 0 ? (
        <p className={styles.body}>Nobody on this account is set up to accept quotes yet. Ask the desk to arrange it, and this link will work.</p>
      ) : null}
      {!live && quote.status !== 'EXPIRED' ? (
        <p className={styles.body}>This quote is no longer open.</p>
      ) : null}
      {live && view.recipients.length > 0 ? (
        <Button intent="ghost" size="sm" onClick={() => setStage({ kind: 'verify', intent: 'accept' })}>
          I already have a code
        </Button>
      ) : null}
    </>
  );
}
