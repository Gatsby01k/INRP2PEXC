'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ClientPerson } from '@inrp2p/portal';
import { useCommand } from '../../../components/useCommand.tsx';
import { setCanAcceptQuotesAction } from '../../../server/actions/client.ts';
import { Switch } from '../_workspace/Field.tsx';
import { AddEmail } from '../_workspace/AddEmail.tsx';
import { CheckIcon, LockIcon, MailIcon, ShieldIcon, SignOutIcon, UsersIcon } from '../_workspace/icons.tsx';
import { SecureAccount } from '../_workspace/SecureAccount.tsx';
import { TelegramCard } from '../_workspace/TelegramCard.tsx';
import { TelegramConnect } from '../_workspace/TelegramConnect.tsx';
import type { TelegramLinkView, TelegramView } from '@inrp2p/clients';
import { Sheet } from '../_workspace/Sheet.tsx';
import shell from '../shell.module.css';
import styles from './account.module.css';

const ROLE: Record<string, string> = { CLIENT_ADMIN: 'Administrator', CLIENT_TRADER: 'Trader', CLIENT_VIEWER: 'Viewer' };

/**
 * The person's Telegram on this page: the full card when Log In with Telegram is set up (sign-in, codes, alerts —
 * ADR 0026), the alerts card alone when only the bot is, nothing when neither is.
 */
export type AccountTelegram =
  | { readonly mode: 'LOGIN'; readonly view: TelegramView; readonly outcome?: { readonly state: 'linked' | 'failed'; readonly error: string | null } }
  | { readonly mode: 'ALERTS'; readonly view: TelegramLinkView }
  | null;

/**
 * The signed-in person and their account, in three parts: who they are, how they sign in and confirm what matters, and
 * — for an administrator of an account with the Exchange — the people on it and which of them may commit to a quote.
 * Removing or replacing an authenticator is the desk's to do after confirming who is asking, so it is offered nowhere here.
 */
export function AccountScreen({
  name,
  label,
  email,
  role,
  canAccept,
  hasAuthenticator,
  signInMethod,
  people,
  isAdmin,
  telegram,
}: {
  name: string;
  /** How they are shown: their email, or their Telegram when they signed up with it and added no email. */
  label: string;
  /** Their email; null when Telegram opened the account and they have not added one (ADR 0026). */
  email: string | null;
  /** Null for someone with no client yet. */
  role: string | null;
  /** Null without the Exchange: there are no quotes to accept. */
  canAccept: boolean | null;
  hasAuthenticator: boolean;
  signInMethod: 'EMAIL' | 'TELEGRAM';
  people: readonly ClientPerson[];
  isAdmin: boolean;
  telegram: AccountTelegram;
}) {
  const router = useRouter();
  const [securing, setSecuring] = useState(false);
  const [addingEmail, setAddingEmail] = useState(false);
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
            {name.trim().charAt(0).toUpperCase()}
          </span>
          <div className={styles.profileText}>
            <h2 className={styles.profileName}>{name}</h2>
            <p className={styles.profileMeta}>
              {label}
              {role ? ` · ${ROLE[role] ?? 'Viewer'}` : ''}
            </p>
          </div>
          <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => void signOut()} disabled={leaving}>
            <SignOutIcon />
            {leaving ? 'Signing out…' : 'Sign out'}
          </button>
        </section>

        <section className={shell.card} aria-labelledby="security-title" id="sign-in">
          <h2 id="security-title" className={shell.cardTitle}>
            Sign-in and security
          </h2>
          <p className={styles.securityNote}>
            You stay signed in on this device for up to 30 days. A new bank account or wallet, a withdrawal, new settlement details and who may act for your account are
            confirmed with a code from somewhere other than where you signed in.
          </p>
          <ul className={styles.items}>
            {email ? (
              <li className={styles.item}>
                <span className={styles.itemIcon} data-tone="ok" aria-hidden="true">
                  <CheckIcon />
                </span>
                <span className={styles.itemText}>
                  <span className={styles.itemTitle}>
                    Email code {signInMethod === 'EMAIL' ? <span className={styles.state} data-on="">This session</span> : null}
                  </span>
                  <span className={styles.itemDetail}>A one-time code sent to {email} signs you in and can confirm changes.</span>
                </span>
              </li>
            ) : (
              <li className={styles.item} id="email">
                <span className={styles.itemIcon} data-tone="neutral" aria-hidden="true">
                  <MailIcon />
                </span>
                <span className={styles.itemText}>
                  <span className={styles.itemTitle}>
                    Email <span className={styles.state}>Not added</span>
                  </span>
                  <span className={styles.itemDetail}>You signed up with Telegram. Add your email to sign in with a code too, and to confirm the changes you make from Telegram.</span>
                </span>
                <button type="button" className={shell.action} data-size="sm" data-tone="ink" onClick={() => setAddingEmail(true)}>
                  Add email
                </button>
              </li>
            )}
            <li className={styles.item}>
              <span className={styles.itemIcon} data-tone={hasAuthenticator ? 'ok' : 'neutral'} aria-hidden="true">
                {hasAuthenticator ? <ShieldIcon /> : <LockIcon />}
              </span>
              <span className={styles.itemText}>
                <span className={styles.itemTitle}>
                  Authenticator app <span className={styles.state} data-on={hasAuthenticator || undefined}>{hasAuthenticator ? 'On' : 'Optional'}</span>
                </span>
                <span className={styles.itemDetail}>
                  {hasAuthenticator
                    ? 'Confirms changes with a code from your phone. Lost it? Use a recovery code, or ask the desk to reset it after they confirm it is you.'
                    : 'Another way to confirm changes, without waiting for an email or a message.'}
                </span>
              </span>
              {hasAuthenticator ? null : (
                <button type="button" className={shell.secondaryAction} data-size="sm" onClick={() => setSecuring(true)}>
                  Set up
                </button>
              )}
            </li>
            {canAccept === null ? null : (
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
            )}
          </ul>
        </section>

        {telegram?.mode === 'LOGIN' ? (
          <TelegramCard
            view={telegram.view}
            returnTo="/account"
            outcome={telegram.outcome}
            title={signInMethod === 'TELEGRAM' && telegram.view.login ? 'Telegram · this session' : 'Telegram'}
            onlyWayIn={email === null}
          />
        ) : telegram?.mode === 'ALERTS' ? (
          <TelegramConnect view={telegram.view} botConfigured />
        ) : null}

        {isAdmin ? (
          <section className={shell.card} aria-labelledby="team-title">
            <div className={styles.teamHead}>
              <div>
                <h2 id="team-title" className={shell.cardTitle}>
                  Who may accept quotes
                </h2>
                <p className={styles.teamNote}>Accepting a quote commits {name} to the trade. Each change is confirmed with a code.</p>
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
                {cmd.error}
              </p>
            ) : null}
          </section>
        ) : null}
      </main>

      {cmd.dialog}
      <Sheet open={securing} onClose={() => setSecuring(false)} eyebrow="Account & security" title="Set up your authenticator" description="Six-digit codes from your phone confirm the changes that matter.">
        <SecureAccount
          email={label}
          onDone={() => {
            setSecuring(false);
            router.refresh();
          }}
        />
      </Sheet>
      <Sheet
        open={addingEmail}
        onClose={() => setAddingEmail(false)}
        eyebrow="Account & security"
        title="Add your email"
        description="It signs you in with a code too, and confirms a new bank account, a withdrawal or a team change you make from Telegram."
      >
        <AddEmail
          intro={false}
          onDone={() => {
            setAddingEmail(false);
            router.refresh();
          }}
        />
      </Sheet>
    </>
  );
}
