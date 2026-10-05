'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientDestinations, ClientPerson } from '@inrp2p/portal';
import { Button } from '@inrp2p/ui';
import { shortenAddress } from '@inrp2p/ui/format';
import { type TotpSetup, TotpEnrolment } from '../../../components/TotpEnrolment.tsx';
import { useCommand } from '../../../components/useCommand.tsx';
import {
  addBankAccountAction, addWalletAction, archiveBankAccountAction, archiveWalletAction, setCanAcceptQuotesAction,
} from '../../../server/actions/client.ts';
import shell from '../shell.module.css';
import styles from './destinations.module.css';

/**
 * The client's own controls (TD-11): an authenticator for everyone, and — for an administrator — adding and archiving
 * destinations and deciding who may accept quotes. Each change is a sensitive client-admin action (SECURITY §2.2): the
 * command asks for a step-up and this page answers with the authenticator dialog, keeping the same intent key.
 */
export function ManageDestinations({ destinations, people, isAdmin, hasAuthenticator }: {
  destinations: ClientDestinations;
  people: readonly ClientPerson[];
  isAdmin: boolean;
  hasAuthenticator: boolean;
}) {
  return (
    <>
      <Authenticator enrolled={hasAuthenticator} />
      {isAdmin ? <AdminControls destinations={destinations} people={people} hasAuthenticator={hasAuthenticator} /> : null}
    </>
  );
}

function Authenticator({ enrolled }: { enrolled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/two-factor/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const json = (await res.json().catch(() => null)) as { totpURI?: string; backupCodes?: string[]; message?: string } | null;
      if (!res.ok || !json?.totpURI || !json.backupCodes) {
        setError(res.status === 403 ? 'For your security, sign in again and then set up the authenticator within ten minutes.' : 'The authenticator could not be set up. Try again.');
        return;
      }
      setSetup({ totpURI: json.totpURI, backupCodes: json.backupCodes });
    } finally {
      setBusy(false);
    }
  };

  const verify = async (code: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/two-factor/verify-totp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      if (!res.ok) {
        setError('That code was not accepted. Try the current one.');
        return;
      }
      setSetup(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={shell.card} aria-labelledby="security-title">
      <div className={shell.cardHead}>
        <h2 id="security-title" className={shell.cardTitle}>Authenticator</h2>
      </div>
      {enrolled ? (
        <p className={shell.muted}>
          On. Changes to your destinations and to who may accept quotes ask for a code from it. Lost it? Contact the desk:
          they confirm it is you and remove it, and you set up a new one.
        </p>
      ) : setup ? (
        <TotpEnrolment setup={setup} onVerify={(c) => void verify(c)} busy={busy} error={error} submitLabel="Turn on the authenticator" />
      ) : (
        <>
          <p className={shell.muted}>
            An authenticator app on your phone confirms the changes that matter: a new bank account or wallet, and who may accept
            quotes. Administrators need one to make those changes themselves.
          </p>
          {error ? (
            <p role="alert" className={styles.formError}>
              {error}
            </p>
          ) : null}
          <div>
            <Button intent="primary" loading={busy} onClick={() => void start()}>
              Set up an authenticator
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function AdminControls({ destinations, people, hasAuthenticator }: { destinations: ClientDestinations; people: readonly ClientPerson[]; hasAuthenticator: boolean }) {
  const cmd = useCommand();
  const [bank, setBank] = useState({ holderName: '', bankName: '', ifsc: '', accountNumber: '' });
  const [wallet, setWallet] = useState<{ address: string; label: string; purpose: 'DESTINATION' | 'SOURCE' | 'BOTH' }>({ address: '', label: '', purpose: 'DESTINATION' });
  const activeBanks = destinations.banks.filter((b) => b.status === 'ACTIVE');
  const activeWallets = destinations.wallets.filter((w) => w.status === 'ACTIVE');
  const archive = (what: string, run: (reason: string, key: string) => Promise<{ ok: boolean }>) => {
    const reason = window.prompt(`Why archive ${what}? (the desk sees this)`);
    if (!reason || reason.trim().length < 3) return;
    void cmd.run(`Archive ${what}`, (key) => run(reason.trim(), key) as never);
  };

  return (
    <section className={shell.card} aria-labelledby="manage-title">
      <div className={shell.cardHead}>
        <h2 id="manage-title" className={shell.cardTitle}>Change destinations and authority</h2>
      </div>
      {!hasAuthenticator ? <p className={shell.muted}>Set up the authenticator above first: every change here asks for a code from it.</p> : null}

      <form
        className={styles.manageForm}
        onSubmit={(e) => {
          e.preventDefault();
          void cmd.run(`Add the ${bank.bankName} account ending ${bank.accountNumber.slice(-4)}`, (key) => addBankAccountAction(bank, key)).then((r) => {
            if (r.ok) setBank({ holderName: '', bankName: '', ifsc: '', accountNumber: '' });
          });
        }}
      >
        <h3 className={styles.manageTitle}>Add a bank account</h3>
        <label>Account holder<input className="ix-input" value={bank.holderName} onChange={(e) => setBank({ ...bank, holderName: e.target.value })} required /></label>
        <label>Bank<input className="ix-input" value={bank.bankName} onChange={(e) => setBank({ ...bank, bankName: e.target.value })} required /></label>
        <label>IFSC<input className="ix-input" value={bank.ifsc} onChange={(e) => setBank({ ...bank, ifsc: e.target.value.toUpperCase() })} required /></label>
        <label>Account number<input className="ix-input" inputMode="numeric" autoComplete="off" value={bank.accountNumber} onChange={(e) => setBank({ ...bank, accountNumber: e.target.value })} required /></label>
        <Button type="submit" intent="primary" disabled={cmd.busy}>Add bank account</Button>
      </form>

      <form
        className={styles.manageForm}
        onSubmit={(e) => {
          e.preventDefault();
          void cmd.run(`Add the wallet ${shortenAddress(wallet.address, 6, 6)}`, (key) => addWalletAction(wallet, key)).then((r) => {
            if (r.ok) setWallet({ address: '', label: '', purpose: 'DESTINATION' });
          });
        }}
      >
        <h3 className={styles.manageTitle}>Add a TRC20 wallet</h3>
        <label>Address<input className="ix-input" value={wallet.address} onChange={(e) => setWallet({ ...wallet, address: e.target.value.trim() })} required /></label>
        <label>Name<input className="ix-input" value={wallet.label} onChange={(e) => setWallet({ ...wallet, label: e.target.value })} required /></label>
        <label>
          Used to
          <select className="ix-input" value={wallet.purpose} onChange={(e) => setWallet({ ...wallet, purpose: e.target.value as typeof wallet.purpose })}>
            <option value="DESTINATION">Receive the USDT you buy</option>
            <option value="SOURCE">Send the USDT you sell</option>
            <option value="BOTH">Both</option>
          </select>
        </label>
        <Button type="submit" intent="primary" disabled={cmd.busy}>Add wallet</Button>
      </form>

      {activeBanks.length + activeWallets.length > 0 ? (
        <div>
          <h3 className={styles.manageTitle}>Archive</h3>
          <ul className={styles.manageList}>
            {activeBanks.map((b) => (
              <li key={b.id}>
                {b.bankName} ••••{b.last4}
                <Button size="sm" disabled={cmd.busy} onClick={() => archive(`${b.bankName} ••••${b.last4}`, (reason, key) => archiveBankAccountAction({ bankAccountId: b.id, reason }, key))}>Archive</Button>
              </li>
            ))}
            {activeWallets.map((w) => (
              <li key={w.id}>
                {w.label} {shortenAddress(w.address, 6, 6)}
                <Button size="sm" disabled={cmd.busy} onClick={() => archive(`${w.label}`, (reason, key) => archiveWalletAction({ walletId: w.id, reason }, key))}>Archive</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {people.length > 0 ? (
        <div>
          <h3 className={styles.manageTitle}>Who may accept quotes</h3>
          <ul className={styles.manageList}>
            {people.map((p) => (
              <li key={p.clientUserId}>
                {p.name} <span className={shell.muted}>{p.email}{p.authenticator ? ' · authenticator on' : ''}</span>
                <label className={styles.toggle}>
                  <input
                    type="checkbox"
                    checked={p.canAcceptQuotes}
                    disabled={cmd.busy || p.status !== 'ACTIVE'}
                    onChange={(e) => void cmd.run(`${e.target.checked ? 'Allow' : 'Stop'} ${p.name} accepting quotes`, (key) => setCanAcceptQuotesAction({ clientUserId: p.clientUserId, canAcceptQuotes: e.target.checked }, key))}
                  />
                  Can accept quotes
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {cmd.error ? (
        <p role="alert" className={styles.formError}>
          {cmd.error === 'MFA_ENROLLMENT_REQUIRED' ? 'Set up the authenticator first.' : cmd.error}
        </p>
      ) : null}
      {cmd.dialog}
    </section>
  );
}
