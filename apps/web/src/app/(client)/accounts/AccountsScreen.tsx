'use client';

import type { ClientDestinations } from '@inrp2p/portal';
import { BankAccountRow, EmptyState, WalletRow } from '@inrp2p/ui';
import styles from '../shell.module.css';

/**
 * The destinations screen: where this client's money is allowed to go.
 *
 * It **shows** and does not change. Adding or archiving a destination is a sensitive client-admin action that
 * requires an enrolled authenticator and a fresh TOTP step-up (SECURITY §2.2, D-08) — and client TOTP enrolment
 * does not exist yet (TD-11), so the command would refuse every attempt. A button that cannot work is worse than
 * no button: the screen says plainly that the desk makes these changes today, which is what actually happens.
 *
 * Archived rows are shown rather than hidden. Destinations are archived, never edited (S8), so the archived ones
 * are how a client recognises the account they used to be paid into.
 *
 * The account number a client typed is never shown back to them: the server seals it and keeps the last four
 * digits, which is what everyone — client and desk alike — recognises it by (D-09).
 */
export function AccountsScreen({
  destinations,
  clientName,
  role,
}: {
  destinations: ClientDestinations;
  clientName: string;
  role: string;
}) {
  const banks = destinations.banks;
  const wallets = destinations.wallets;

  return (
    <>
      <section className={styles.panel} aria-label="Your organisation">
        <span className={styles.sectionTitle}>Account</span>
        <div className={styles.row}>
          <span className={styles.muted}>Client</span>
          <span>{clientName}</span>
        </div>
        <div className={styles.row}>
          <span className={styles.muted}>Your role</span>
          <span>{role === 'CLIENT_ADMIN' ? 'Administrator' : role === 'CLIENT_TRADER' ? 'Trader' : 'Viewer'}</span>
        </div>
      </section>

      <section className={styles.panel} aria-label="Bank accounts">
        <span className={styles.sectionTitle}>Bank accounts</span>
        {banks.length === 0 ? (
          <EmptyState title="No bank accounts yet" body="INR payouts need somewhere to land. Ask the desk to add one." />
        ) : (
          banks.map((b) => <BankAccountRow key={b.id} bankName={b.bankName} holderName={b.holderName} last4={b.last4} status={b.status} rail={b.rails[0] ?? 'IMPS'} />)
        )}
      </section>

      <section className={styles.panel} aria-label="Wallets">
        <span className={styles.sectionTitle}>Wallets</span>
        {wallets.length === 0 ? (
          <EmptyState title="No wallets yet" body="A wallet is where USDT you buy is delivered. Ask the desk to add one." />
        ) : (
          wallets.map((w) => <WalletRow key={w.id} address={w.address} network="TRC20" label={w.label} status={w.status} />)
        )}
      </section>

      <p className={styles.notice}>
        Changing where your money goes is done with the desk, so that both sides have agreed the account before anything is paid into it. Ask on your usual channel
        and it will appear here.
      </p>
    </>
  );
}
