'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientPerson } from '@inrp2p/portal';
import { useCommand } from '../../../components/useCommand.tsx';
import { setCanAcceptQuotesAction } from '../../../server/actions/client.ts';
import { Switch } from '../_workspace/Field.tsx';
import { CheckIcon, LockIcon, ShieldIcon, SignOutIcon, UsersIcon } from '../_workspace/icons.tsx';
import { SecureAccount } from '../_workspace/SecureAccount.tsx';
import { TelegramConnect } from '../_workspace/TelegramConnect.tsx';
import type { TelegramLinkView } from '@inrp2p/clients';
import { Sheet } from '../_workspace/Sheet.tsx';
import shell from '../shell.module.css';
import styles from './account.module.css';

const ROLE: Record<string, string> = { CLIENT_ADMIN: 'Administrator', CLIENT_TRADER: 'Trader', CLIENT_VIEWER: 'Viewer' };

/**
 * The signed-in person and their account, in three parts: who they are, how their sign-in and changes are protected,
 * and — for an administrator — the people on the account and which of them may commit to a quote. Removing or
 * replacing an authenticator is the desk's to do after confirming who is asking, so it is offered nowhere here.
 */
export function AccountScreen({
  clientName,
  email,
  role,
  canAccept,
  hasAuthenticator,
  people,
  isAdmin,
  telegram,
}: {
  clientName: string;
  email: string;
  role: string;
  canAccept: boolean;
  hasAuthenticator: boolean;
  people: readonly ClientPerson[];
  isAdmin: boolean;
  telegram: { view: TelegramLinkView; botConfigured: boolean };
}) {
  const router = useRouter();
  const [securing, setSecuring] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const cmd = useCommand();

  const signOut = async () => {
    setLeaving(true);
    try {
      await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } finally {
      router.push('/sign-in');
      router.refresh();
    }
  };

  return (
    <>
      <main className={shell.main}>
        <section className={`${shell.card} ${styles.profile}`} aria-label="Your account">
          <span className={styles.avatar} aria-hidden="true">
            {clientName.trim().charAt(0).toUpperCase()}
          </span>
          <div className={styles.profileText}>
            <h2 className={styles.profileName}>{clientName}</h2>
            <p className={styles.profileMeta}>
              {email} · {ROLE[role] ?? 'Viewer'}
            </p>
          </div>
          <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => void signOut()} disabled={leaving}>
            <SignOutIcon />
            {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        </section>

        <section className={shell.card} aria-labelledby="security-title">
          <h2 id="security-title" className={shell.cardTitle}>
            Sign-in and security
          </h2>
          <ul className={styles.items}>
            <li className={styles.item}>
              <span className={styles.itemIcon} data-tone="ok" aria-hidden="true">
                <CheckIcon />
              </span>
              <span className={styles.itemText}>
                <span className={styles.itemTitle}>Email code</span>
                <span className={styles.itemDetail}>You sign in with a one-time code sent to {email}.</span>
              </span>
            </li>
            <li className={styles.item}>
              <span className={styles.itemIcon} data-tone={hasAuthenticator ? 'ok' : 'warn'} aria-hidden="true">
                {hasAuthenticator ? <ShieldIcon /> : <LockIcon />}
              </span>
              <span className={styles.itemText}>
                <span className={styles.itemTitle}>
                  Authenticator app <span className={styles.state} data-on={hasAuthenticator || undefined}>{hasAuthenticator ? 'On' : 'Off'}</span>
                </span>
                <span className={styles.itemDetail}>
                  {hasAuthenticator
                    ? 'Confirms changes to your bank accounts, wallets and who may accept quotes. Lost your phone? Use a recovery code, or ask the desk to reset it after they confirm it is you.'
                    : 'Needed to add or archive bank accounts and wallets, and to change who may accept quotes.'}
                </span>
              </span>
              {hasAuthenticator ? null : (
                <button type="button" className={shell.action} data-size="sm" data-tone="ink" onClick={() => setSecuring(true)}>
                  Set up
                </button>
              )}
            </li>
            <li className={styles.item}>
              <span className={styles.itemIcon} data-tone={canAccept ? 'ok' : 'neutral'} aria-hidden="true">
                <CheckIcon />
              </span>
              <span className={styles.itemText}>
                <span className={styles.itemTitle}>Quotes</span>
                <span className={styles.itemDetail}>
                  {canAccept ? 'You can accept firm quotes for this account.' : 'You can see quotes. Someone with acceptance rights on this account accepts them.'}
                </span>
              </span>
            </li>
          </ul>
        </section>

        <TelegramConnect view={telegram.view} botConfigured={telegram.botConfigured} />

        {isAdmin ? (
          <section className={shell.card} aria-labelledby="team-title">
            <div className={styles.teamHead}>
              <div>
                <h2 id="team-title" className={shell.cardTitle}>
                  Who may accept quotes
                </h2>
                <p className={styles.teamNote}>Accepting a quote commits {clientName} to the trade. Each change is confirmed with your authenticator.</p>
              </div>
              <UsersIcon className={styles.teamIcon} />
            </div>
            <ul className={styles.people}>
              {people.map((p) => (
                <li key={p.clientUserId} className={styles.person} data-disabled={p.status !== 'ACTIVE' || undefined}>
                  <span className={styles.personAvatar} aria-hidden="true">
                    {p.name.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className={styles.itemText}>
                    <span className={styles.itemTitle}>{p.name}</span>
                    <span className={styles.itemDetail}>
                      {p.email} · {ROLE[p.role] ?? 'Viewer'}
                      {p.authenticator ? ' · authenticator on' : ''}
                      {p.status !== 'ACTIVE' ? ' · disabled' : ''}
                    </span>
                  </span>
                  <Switch
                    checked={p.canAcceptQuotes}
                    label={`${p.name} can accept quotes`}
                    disabled={cmd.busy || p.status !== 'ACTIVE'}
                    onChange={(next) =>
                      void cmd.run(`${next ? 'Allow' : 'Stop'} ${p.name} accepting quotes`, (key) => setCanAcceptQuotesAction({ clientUserId: p.clientUserId, canAcceptQuotes: next }, key))
                    }
                  />
                </li>
              ))}
            </ul>
            {cmd.error ? (
              <p className={shell.error} role="alert">
                {cmd.error === 'MFA_ENROLLMENT_REQUIRED' ? 'Set up your authenticator first.' : cmd.error}
              </p>
            ) : null}
          </section>
        ) : null}
      </main>

      {cmd.dialog}
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
