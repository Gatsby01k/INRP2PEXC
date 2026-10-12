'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientBankAccount, ClientDestinations, ClientWallet } from '@inrp2p/portal';
import { CopyButton } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { readiness } from '../_assistant/model.ts';
import { ArchiveIcon, BankIcon, CheckIcon, ChevronDownIcon, LockIcon, PlusIcon, ShieldIcon, WalletIcon } from '../_workspace/icons.tsx';
import { SecureAccount } from '../_workspace/SecureAccount.tsx';
import { Sheet } from '../_workspace/Sheet.tsx';
import { AddDestination, type DestinationKind } from './AddDestination.tsx';
import { ArchiveDialog, type ArchiveTarget } from './ArchiveDialog.tsx';
import { monogram } from './checks.ts';
import shell from '../shell.module.css';
import styles from './destinations.module.css';

const PURPOSE: Record<ClientWallet['purpose'], string> = {
  DESTINATION: 'Receives the USDT you buy',
  SOURCE: 'Sends the USDT you sell',
  BOTH: 'Sends and receives USDT',
};

const STATUS_WORDS: Record<ClientWallet['status'], string> = { ACTIVE: 'Active', PENDING_REVIEW: 'Pending review', REJECTED: 'Rejected', ARCHIVED: 'Archived' };

const live = (s: ClientWallet['status']) => s === 'ACTIVE' || s === 'PENDING_REVIEW';

/**
 * Bank & wallets: where this client's money is allowed to go, and so which directions they can trade.
 *
 * What it answers first is the question a client actually has — can I sell, can I buy, and where will the money
 * land — and the lists follow. An administrator changes them here, each change confirmed with their authenticator
 * (TD-11, D-08); anyone else sees them and is told who can. Archived rows are kept, folded away — destinations are
 * archived, never edited (S8), so the archived ones are how a client recognises an account they used to be paid
 * into. The account number a client gave is never shown back: the server seals it and keeps the last four (D-09).
 */
export function DestinationsScreen({
  destinations,
  clientName,
  email,
  isAdmin,
  hasAuthenticator,
}: {
  destinations: ClientDestinations;
  clientName: string;
  email: string;
  isAdmin: boolean;
  hasAuthenticator: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState<DestinationKind | null>(null);
  const [lastKind, setLastKind] = useState<DestinationKind>('bank');
  const [archiving, setArchiving] = useState<ArchiveTarget | null>(null);
  const [securing, setSecuring] = useState(false);
  const ready = readiness(destinations);
  const banks = destinations.banks.filter((b) => live(b.status));
  const wallets = destinations.wallets.filter((w) => live(w.status));
  const archivedBanks = destinations.banks.filter((b) => !live(b.status));
  const archivedWallets = destinations.wallets.filter((w) => !live(w.status));
  const primaryBank = banks.find((b) => b.status === 'ACTIVE');
  const primaryWallet = wallets.find((w) => w.status === 'ACTIVE' && w.purpose !== 'SOURCE');

  const add = (kind: DestinationKind) => {
    setLastKind(kind);
    setAdding(kind);
  };

  return (
    <>
      <main className={shell.main}>
        {banks.length + wallets.length > 0 ? (
          <section className={styles.readiness} aria-label="What you can trade">
            <Readiness title="Sell USDT" ready={ready.sell} detail={primaryBank ? `INR paid to ${primaryBank.bankName} •••• ${primaryBank.last4}` : 'Needs a bank account for the INR'} />
            <Readiness title="Buy USDT" ready={ready.buy} detail={primaryWallet ? `USDT delivered to ${primaryWallet.label}` : 'Needs a wallet for the USDT'} />
          </section>
        ) : null}

        <section className={shell.card} aria-labelledby="banks-title">
          <div className={styles.sectionHead}>
            <div>
              <h2 id="banks-title" className={shell.cardTitle}>
                Bank accounts
              </h2>
              <p className={styles.sectionNote}>INR from the USDT you sell is paid to these.</p>
            </div>
            {isAdmin && banks.length > 0 ? (
              <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => add('bank')}>
                <PlusIcon />
                Add
              </button>
            ) : null}
          </div>
          {banks.length === 0 ? (
            <Empty
              icon={<BankIcon />}
              text="No bank account yet. Add one to sell USDT for INR."
              who={clientName}
              isAdmin={isAdmin}
              actionLabel="Add bank account"
              onAction={() => add('bank')}
            />
          ) : (
            <ul className={styles.rows}>
              {banks.map((b) => (
                <BankRow key={b.id} bank={b} {...(isAdmin ? { onArchive: () => setArchiving({ kind: 'bank', id: b.id, name: `${b.bankName} •••• ${b.last4}` }) } : {})} />
              ))}
            </ul>
          )}
        </section>

        <section className={shell.card} aria-labelledby="wallets-title">
          <div className={styles.sectionHead}>
            <div>
              <h2 id="wallets-title" className={shell.cardTitle}>
                USDT wallets
              </h2>
              <p className={styles.sectionNote}>TRC20 wallets the USDT you buy is delivered to.</p>
            </div>
            {isAdmin && wallets.length > 0 ? (
              <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => add('wallet')}>
                <PlusIcon />
                Add
              </button>
            ) : null}
          </div>
          {wallets.length === 0 ? (
            <Empty
              icon={<WalletIcon />}
              text="No wallet yet. Add one to buy USDT."
              who={clientName}
              isAdmin={isAdmin}
              actionLabel="Add wallet"
              onAction={() => add('wallet')}
            />
          ) : (
            <ul className={styles.rows}>
              {wallets.map((w) => (
                <WalletRow key={w.id} wallet={w} {...(isAdmin ? { onArchive: () => setArchiving({ kind: 'wallet', id: w.id, name: w.label }) } : {})} />
              ))}
            </ul>
          )}
        </section>

        {archivedBanks.length + archivedWallets.length > 0 ? (
          <details className={styles.archived}>
            <summary>
              <ChevronDownIcon className={styles.archivedChevron} />
              Archived <span className={styles.count}>{archivedBanks.length + archivedWallets.length}</span>
            </summary>
            <ul className={styles.rows}>
              {archivedBanks.map((b) => (
                <BankRow key={b.id} bank={b} />
              ))}
              {archivedWallets.map((w) => (
                <WalletRow key={w.id} wallet={w} />
              ))}
            </ul>
          </details>
        ) : null}
      </main>

      <aside className={shell.aside}>
        <section className={styles.security} data-on={hasAuthenticator || undefined} aria-labelledby="security-title">
          <span className={styles.securityIcon} aria-hidden="true">
            {hasAuthenticator ? <ShieldIcon /> : <LockIcon />}
          </span>
          <div className={styles.securityText}>
            <h2 id="security-title" className={styles.asideTitle}>
              {hasAuthenticator ? 'Authenticator on' : 'Authenticator off'}
            </h2>
            <p className={styles.asideBody}>
              {hasAuthenticator
                ? 'Every change on this page is confirmed with a code from your phone.'
                : isAdmin
                  ? 'Set one up to add or archive accounts. It takes about a minute.'
                  : 'An authenticator protects your sign-in and the changes you can make.'}
            </p>
          </div>
          {hasAuthenticator ? null : (
            <button type="button" className={shell.action} data-size="sm" data-tone="ink" onClick={() => setSecuring(true)}>
              Set up
            </button>
          )}
        </section>

        <section className={styles.trust} aria-labelledby="trust-title">
          <h2 id="trust-title" className={styles.asideTitle}>
            How your accounts are protected
          </h2>
          <ul className={styles.trustList}>
            <li>
              <CheckIcon />
              <span>Money from your trades goes only to the accounts and wallets listed here.</span>
            </li>
            <li>
              <CheckIcon />
              <span>Account numbers are encrypted when saved; only the last four digits are ever shown.</span>
            </li>
            <li>
              <CheckIcon />
              <span>Every addition or archive needs an administrator’s authenticator, and every administrator is told.</span>
            </li>
          </ul>
        </section>
      </aside>

      <AddDestination
        open={adding !== null}
        kind={adding ?? lastKind}
        onClose={() => setAdding(null)}
        hasAuthenticator={hasAuthenticator}
        email={email}
        holderName={clientName}
      />
      <ArchiveDialog target={archiving} onClose={() => setArchiving(null)} />
      <Sheet open={securing} onClose={() => setSecuring(false)} eyebrow="Account & security" title="Set up your authenticator" description="Six-digit codes from your phone confirm the changes that matter.">
        <SecureAccount
          email={email}
          onDone={() => {
            setSecuring(false);
            router.refresh();
          }}
        />
      </Sheet>
    </>
  );
}

function Readiness({ title, ready, detail }: { title: string; ready: boolean; detail: string }) {
  return (
    <div className={styles.ready} data-ready={ready || undefined}>
      <span className={styles.readyMark} aria-hidden="true">
        {ready ? <CheckIcon /> : null}
      </span>
      <span className={styles.readyText}>
        <span className={styles.readyTitle}>
          {title}
          <span className={styles.readyState}>{ready ? 'Ready' : 'Not set up'}</span>
        </span>
        <span className={styles.readyDetail}>{detail}</span>
      </span>
    </div>
  );
}

function Empty({ icon, text, who, isAdmin, actionLabel, onAction }: { icon: React.ReactNode; text: string; who: string; isAdmin: boolean; actionLabel: string; onAction: () => void }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">
        {icon}
      </span>
      <p className={styles.emptyText}>{isAdmin ? text : `${text.split('.')[0]}. An administrator of ${who} can add one.`}</p>
      {isAdmin ? (
        <button type="button" className={shell.action} data-size="sm" onClick={onAction}>
          <PlusIcon className={shell.actionIcon} />
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function StatusTag({ status }: { status: ClientWallet['status'] }) {
  return (
    <span className={styles.status} data-state={status.toLowerCase()}>
      <span className={styles.statusDot} aria-hidden="true" />
      {STATUS_WORDS[status]}
    </span>
  );
}

function BankRow({ bank: b, onArchive }: { bank: ClientBankAccount; onArchive?: () => void }) {
  return (
    <li className={styles.row} data-archived={!live(b.status) || undefined}>
      <span className={styles.monogram} aria-hidden="true">
        {monogram(b.bankName)}
      </span>
      <span className={styles.main}>
        <span className={styles.name}>
          {b.bankName} <span className="ix-num">•••• {b.last4}</span>
          {b.verified ? (
            <span className={styles.verified}>
              <ShieldIcon />
              Verified
            </span>
          ) : null}
        </span>
        <span className={styles.meta}>
          {b.holderName} · <span className="ix-num">{b.ifsc}</span>
          {b.rails.length > 0 ? ` · ${b.rails.join(' / ')}` : ''}
        </span>
      </span>
      <span className={styles.tags}>
        {b.status !== 'ACTIVE' ? <StatusTag status={b.status} /> : null}
        {onArchive && b.status === 'ACTIVE' ? (
          <button type="button" className={styles.rowAction} onClick={onArchive} title="Archive">
            <ArchiveIcon />
            <span className={styles.rowActionText}>Archive</span>
          </button>
        ) : null}
      </span>
    </li>
  );
}

function WalletRow({ wallet: w, onArchive }: { wallet: ClientWallet; onArchive?: () => void }) {
  return (
    <li className={styles.row} data-archived={!live(w.status) || undefined}>
      <span className={styles.monogram} data-kind="wallet" aria-hidden="true">
        T
      </span>
      <span className={styles.main}>
        <span className={styles.name}>{w.label}</span>
        <span className={styles.meta}>
          <span className={`${styles.address} ix-num`} title={w.address}>
            {shortenAddress(w.address, 6, 6)}
          </span>
          <span className="ix-visually-hidden"> full address {w.address}</span> · {PURPOSE[w.purpose]}
        </span>
      </span>
      <span className={styles.tags}>
        {w.status !== 'ACTIVE' ? <StatusTag status={w.status} /> : null}
        <CopyButton value={w.address} label={`address of ${w.label}`} />
        {onArchive && w.status === 'ACTIVE' ? (
          <button type="button" className={styles.rowAction} onClick={onArchive} title="Archive">
            <ArchiveIcon />
            <span className={styles.rowActionText}>Archive</span>
          </button>
        ) : null}
      </span>
    </li>
  );
}
