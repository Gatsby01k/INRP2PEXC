'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCommand } from '../../../components/useCommand.tsx';
import { openAccountAction } from '../../../server/actions/open-account.ts';
import { AssistantPanel } from '../_assistant/AssistantPanel.tsx';
import { ArrowIcon } from '../_workspace/icons.tsx';
import { sentence } from '../traders/_ui/format.ts';
import shell from '../shell.module.css';
import styles from '../traders/traders.module.css';

type EntityType = 'INDIVIDUAL' | 'COMPANY';

/**
 * The account a new client opens for themselves: a name and whether it is a person or a company. The server makes
 * the signed-in person its administrator, able to accept quotes; the next things a client needs — an authenticator,
 * then the bank accounts and wallets it settles to — are in Destinations, as for every client.
 */
export function OpenAccount({ email }: { email: string }) {
  const router = useRouter();
  const open = useCommand();
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('INDIVIDUAL');
  const submit = async () => {
    const out = await open.run('Open your account', (key) => openAccountAction({ name, entityType }, key));
    if (out.ok) router.push('/exchange');
  };

  return (
    <>
      <main className={shell.main}>
        <section className={shell.surface} aria-labelledby="open-title" data-robot-target="panel">
          <h2 id="open-title" className={shell.cardTitle}>
            Your account
          </h2>
          <form
            className={styles.editForm}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <fieldset className={styles.choices}>
              <legend className={styles.fieldLabel}>You trade as</legend>
              <div className={styles.segmented}>
                {(
                  [
                    ['INDIVIDUAL', 'Individual'],
                    ['COMPANY', 'Company'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className={styles.choice}>
                    <input type="radio" name="entity" checked={entityType === value} onChange={() => setEntityType(value)} />
                    <span className={styles.choiceText}>
                      <span className={styles.choiceName}>{label}</span>
                    </span>
                    <span className={styles.ring} aria-hidden="true" />
                  </label>
                ))}
              </div>
            </fieldset>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{entityType === 'COMPANY' ? 'Company name' : 'Full name'}</span>
              <span className={styles.inputBox}>
                <input className={styles.input} autoComplete={entityType === 'COMPANY' ? 'organization' : 'name'} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
              </span>
              <span className={styles.fieldHint}>Signed in as {email}. You will be the account’s administrator.</span>
            </label>
            <div className={styles.formActions}>
              <button type="submit" className={shell.action} disabled={open.busy || name.trim() === ''} data-robot-target="cta">
                Open account
                <ArrowIcon className={shell.actionIcon} />
              </button>
            </div>
            {open.error ? (
              <p className={shell.error} role="alert">
                {sentence(open.error)}
              </p>
            ) : null}
          </form>
          <p className={styles.note}>
            Every request is priced by a person on the INRP2P desk. Before your first trade, add an authenticator and the bank accounts and wallets you settle to, in Destinations.
          </p>
        </section>
      </main>
      <AssistantPanel state={{ mood: 'ready', label: 'Welcome', title: 'One step to the Exchange', body: 'A name for the account you will trade under.' }} size="compact">
        <div className={styles.navRow}>
          <Link className={shell.textAction} href="/traders">
            Provide capacity instead
          </Link>
        </div>
      </AssistantPanel>
      {open.dialog}
    </>
  );
}
