'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RobotFigure } from '../_assistant/RobotFigure.tsx';
import { BankIcon, CheckIcon, WalletIcon } from '../_workspace/icons.tsx';
import { SecureAccount } from '../_workspace/SecureAccount.tsx';
import { Sheet } from '../_workspace/Sheet.tsx';
import { AddDestination, type DestinationKind } from '../destinations/AddDestination.tsx';
import type { Who } from './RequestForm.tsx';
import shell from '../shell.module.css';
import styles from './exchange.module.css';

type Status = 'done' | 'current' | 'next';

/**
 * A new client's first visit: the robot welcomes them, and the two things that stand between them and a first
 * quote are laid out as steps they can take from here — an authenticator, then somewhere to be paid. Each opens in a
 * sheet over the page and comes back to it. Once there is somewhere to pay them, this is gone for good.
 *
 * Someone who cannot add destinations (not an administrator) is told who can, and nothing is offered that the
 * server would refuse.
 */
export function SetupGuide({ who }: { who: Who }) {
  const router = useRouter();
  const [securing, setSecuring] = useState(false);
  const [adding, setAdding] = useState<DestinationKind | null>(null);
  const [kind, setKind] = useState<DestinationKind>('bank');
  const secure: Status = who.hasAuthenticator ? 'done' : 'current';
  const destination: Status = who.hasAuthenticator || !who.isAdmin ? 'current' : 'next';

  const add = (k: DestinationKind) => {
    setKind(k);
    setAdding(k);
  };

  return (
    <section className={styles.setup} aria-labelledby="setup-title">
      <div className={styles.setupStage} aria-hidden="true">
        <RobotFigure mood="ready" className={styles.setupFigure} />
      </div>
      <div className={styles.setupBody}>
        <div>
          <p className={styles.setupEyebrow}>Getting started</p>
          <h2 id="setup-title" className={styles.setupTitle}>
            Welcome to the desk, {who.clientName}.
          </h2>
          <p className={styles.setupLede}>{who.isAdmin ? 'Two steps, and you can ask for your first quote.' : 'One step stands between you and your first quote.'}</p>
        </div>
        <ol className={styles.steps}>
          {who.isAdmin ? (
            <Step
              n={1}
              status={secure}
              title="Turn on your authenticator"
              body="A code from your phone confirms every change to where you are paid."
              action={
                secure === 'done' ? null : (
                  <button type="button" className={shell.action} data-size="sm" data-tone="ink" onClick={() => setSecuring(true)}>
                    Set up
                  </button>
                )
              }
            />
          ) : null}
          <Step
            n={who.isAdmin ? 2 : 1}
            status={destination}
            title="Add where you are paid"
            body={who.isAdmin ? 'A bank account to sell USDT for INR, or a wallet to buy USDT.' : `An administrator of ${who.clientName} adds the bank accounts and wallets you are paid to.`}
            stacked
            action={
              who.isAdmin ? (
                <>
                  <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => add('bank')}>
                    <BankIcon />
                    Bank account
                  </button>
                  <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => add('wallet')}>
                    <WalletIcon />
                    Wallet
                  </button>
                </>
              ) : null
            }
          />
          <Step n={who.isAdmin ? 3 : 2} status="next" title="Request your first quote" body="Choose an amount below. The desk prices it and sends you a firm quote to accept." />
        </ol>
      </div>

      <Sheet open={securing} onClose={() => setSecuring(false)} eyebrow="Getting started" title="Turn on your authenticator" description="Six-digit codes from your phone confirm the changes that matter.">
        <SecureAccount
          email={who.email}
          onDone={() => {
            setSecuring(false);
            router.refresh();
          }}
        />
      </Sheet>
      <AddDestination
        open={adding !== null}
        kind={adding ?? kind}
        onClose={() => setAdding(null)}
        hasAuthenticator={who.hasAuthenticator}
        email={who.email}
        holderName={who.clientName}
        next="exchange"
      />
    </section>
  );
}

function Step({ n, status, title, body, action, stacked = false }: { n: number; status: Status; title: string; body: string; action?: React.ReactNode; stacked?: boolean }) {
  return (
    <li className={styles.step} data-status={status} data-stacked={stacked || undefined} {...(status === 'current' ? { 'aria-current': 'step' as const } : {})}>
      <span className={styles.stepMark} aria-hidden="true">
        {status === 'done' ? <CheckIcon /> : n}
      </span>
      <span className={styles.stepText}>
        <span className={styles.stepTitle}>
          {title}
          {status === 'done' ? <span className="ix-visually-hidden">, done</span> : null}
        </span>
        <span className={styles.stepBody}>{body}</span>
      </span>
      {action ? <span className={styles.stepActions}>{action}</span> : null}
    </li>
  );
}
