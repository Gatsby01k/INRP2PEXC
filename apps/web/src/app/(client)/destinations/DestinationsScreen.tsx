'use client';

import type { ClientDestinations, ClientWallet } from '@inrp2p/portal';
import { CopyButton } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { AssistantPanel } from '../_assistant/AssistantPanel.tsx';
import { destinationsAssistant, readiness } from '../_assistant/model.ts';
import { BankIcon, CheckIcon, InfoIcon, ShieldIcon, WalletIcon } from '../_workspace/icons.tsx';
import shell from '../shell.module.css';
import styles from './destinations.module.css';

const ROLE: Record<string, string> = { CLIENT_ADMIN: 'Administrator', CLIENT_TRADER: 'Trader', CLIENT_VIEWER: 'Viewer' };

const PURPOSE: Record<ClientWallet['purpose'], string> = {
  DESTINATION: 'Receives the USDT you buy',
  SOURCE: 'Sends the USDT you sell',
  BOTH: 'Sends and receives USDT',
};

function Status({ active }: { active: boolean }) {
  return (
    <span className={styles.status} data-active={active}>
      <span className={styles.statusDot} aria-hidden="true" />
      {active ? 'Active' : 'Archived'}
    </span>
  );
}

/**
 * The destinations screen: where this client's money is allowed to go, and so which directions they can trade.
 *
 * It **shows** and does not change (TD-11): the screen says plainly that the desk makes these changes, which is
 * what actually happens. Archived rows are shown rather than hidden — destinations are archived, never edited (S8),
 * so the archived ones are how a client recognises the account they used to be paid into. The account number a
 * client gave is never shown back to them: the server seals it and keeps the last four digits (D-09).
 */
export function DestinationsScreen({ destinations, clientName, role, canAccept }: { destinations: ClientDestinations; clientName: string; role: string; canAccept: boolean }) {
  const { banks, wallets } = destinations;
  const ready = readiness(destinations);
  const primaryBank = banks.find((b) => b.status === 'ACTIVE');
  const primaryWallet = wallets.find((w) => w.status === 'ACTIVE' && w.purpose !== 'SOURCE');

  return (
    <>
      <main className={shell.main} data-robot-target="panel">
        <section className={`${shell.card} ${styles.overview}`} aria-label="Your account">
          <div className={styles.identity}>
            <span className={styles.initial} aria-hidden="true">
              {clientName.trim().charAt(0).toUpperCase()}
            </span>
            <span className={styles.identityText}>
              <span className={styles.clientName}>{clientName}</span>
              <span className={shell.muted}>Client of the INRP2P desk</span>
            </span>
          </div>
          <dl className={styles.overviewFacts}>
            <div>
              <dt>Your role</dt>
              <dd>{ROLE[role] ?? 'Viewer'}</dd>
            </div>
            <div>
              <dt>Quotes</dt>
              <dd>{canAccept ? 'You can accept them' : 'You can see them'}</dd>
            </div>
            <div>
              <dt>Sign-in</dt>
              <dd>Code to your work email</dd>
            </div>
          </dl>
        </section>

        <section className={shell.card} aria-labelledby="banks-title">
          <div className={shell.cardHead}>
            <h2 id="banks-title" className={shell.cardTitle}>
              Bank accounts <span className={styles.count}>{banks.length}</span>
            </h2>
            <span className={shell.muted}>For INR payouts when you sell</span>
          </div>
          {banks.length === 0 ? (
            <p className={styles.none}>No bank account yet. INR payouts need somewhere to land — ask the desk to add one.</p>
          ) : (
            <ul className={styles.rows}>
              {banks.map((b) => (
                <li key={b.id} className={styles.row} data-archived={b.status === 'ARCHIVED' || undefined}>
                  <span className={styles.icon}>
                    <BankIcon />
                  </span>
                  <span className={styles.main}>
                    <span className={styles.name}>
                      {b.bankName} <span className="ix-num">•••• {b.last4}</span>
                    </span>
                    <span className={styles.meta}>
                      {b.holderName} · {b.ifsc}
                      {b.rails.length > 0 ? ` · ${b.rails.join(' / ')}` : ''}
                    </span>
                  </span>
                  <span className={styles.tags}>
                    {b.verified ? (
                      <span className={styles.verified}>
                        <ShieldIcon className={styles.tagIcon} />
                        Verified
                      </span>
                    ) : null}
                    <Status active={b.status === 'ACTIVE'} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={shell.card} aria-labelledby="wallets-title">
          <div className={shell.cardHead}>
            <h2 id="wallets-title" className={shell.cardTitle}>
              Wallets <span className={styles.count}>{wallets.length}</span>
            </h2>
            <span className={shell.muted}>USDT on TRC20</span>
          </div>
          {wallets.length === 0 ? (
            <p className={styles.none}>No wallet yet. A wallet is where the USDT you buy is delivered — ask the desk to add one.</p>
          ) : (
            <ul className={styles.rows}>
              {wallets.map((w) => (
                <li key={w.id} className={styles.row} data-archived={w.status === 'ARCHIVED' || undefined}>
                  <span className={styles.icon}>
                    <WalletIcon />
                  </span>
                  <span className={styles.main}>
                    <span className={styles.name} title={w.address}>
                      TRC20 · <span className="ix-num">{shortenAddress(w.address)}</span>
                      <span className="ix-visually-hidden"> full address {w.address}</span>
                    </span>
                    <span className={styles.meta}>
                      {w.label} · {PURPOSE[w.purpose]}
                    </span>
                  </span>
                  <span className={styles.tags}>
                    <CopyButton value={w.address} label={`address of ${w.label}`} />
                    <Status active={w.status === 'ACTIVE'} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className={shell.info}>
          <InfoIcon className={shell.infoIcon} />
          <span>
            Destinations are added and archived by the desk, so both sides have agreed an account before anything is paid into it. Ask on your usual channel — the
            change appears here, and you are notified of it.
          </span>
        </p>
      </main>
      <AssistantPanel state={destinationsAssistant(destinations)} size="compact">
        <ul className={styles.readiness} aria-label="What you can trade">
          <li data-ready={ready.sell}>
            <span className={styles.readyMark} aria-hidden="true">
              {ready.sell ? <CheckIcon /> : null}
            </span>
            <span>
              <strong>Sell USDT</strong>
              <span>{primaryBank ? `INR to ${primaryBank.bankName} •••• ${primaryBank.last4}` : 'Needs a bank account'}</span>
            </span>
          </li>
          <li data-ready={ready.buy}>
            <span className={styles.readyMark} aria-hidden="true">
              {ready.buy ? <CheckIcon /> : null}
            </span>
            <span>
              <strong>Buy USDT</strong>
              <span>{primaryWallet ? `USDT to TRC20 · ${shortenAddress(primaryWallet.address)}` : 'Needs a wallet'}</span>
            </span>
          </li>
        </ul>
      </AssistantPanel>
    </>
  );
}
