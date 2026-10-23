'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArcLoader } from '@inrp2p/ui';
import type { MyInviteRow } from '@inrp2p/clients';
import { useCommand } from '../../../components/useCommand.tsx';
import { openAccountAction } from '../../../server/actions/open-account.ts';
import { RobotFigure } from '../_assistant/RobotFigure.tsx';
import { Field } from '../_workspace/Field.tsx';
import { ArrowIcon, BankIcon, LockIcon, UserIcon, UsersIcon } from '../_workspace/icons.tsx';
import { sentence } from '../traders/_ui/format.ts';
import { Invitations } from './Invitations.tsx';
import shell from '../shell.module.css';
import styles from './open.module.css';

type EntityType = 'INDIVIDUAL' | 'COMPANY';

const KINDS: readonly { value: EntityType; label: string; detail: string; Icon: typeof UserIcon }[] = [
  { value: 'INDIVIDUAL', label: 'Individual', detail: 'In your own name', Icon: UserIcon },
  { value: 'COMPANY', label: 'Company', detail: 'For a business', Icon: UsersIcon },
];

/**
 * The account a new client opens for themselves (D-17): whether it is a person or a company, and its name. The server
 * makes the signed-in person its administrator, able to accept quotes. The two things a client needs before a first
 * trade — an authenticator, then somewhere to be paid — follow on the Exchange, where a guide waits for them.
 */
export function OpenAccount({ email, invites = [], next }: { email: string; invites?: readonly MyInviteRow[]; next?: string }) {
  const router = useRouter();
  const open = useCommand();
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState<EntityType>('COMPANY');
  const submit = async () => {
    const out = await open.run('Open your account', (key) => openAccountAction({ name: name.trim(), entityType }, key));
    if (out.ok) router.push(next ?? '/exchange');
  };

  return (
    <>
      <main className={shell.main}>
        <Invitations invites={invites} />
        <section className={styles.card} aria-labelledby="open-title">
          <div className={styles.stage} aria-hidden="true">
            <RobotFigure mood="ready" className={styles.figure} />
          </div>
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() !== '') void submit();
            }}
          >
            <div>
              <p className={styles.eyebrow}>Welcome to INRP2P</p>
              <h2 id="open-title" className={styles.title}>
                Who will trade on this account?
              </h2>
            </div>

            <fieldset className={styles.kinds}>
              <legend className="ix-visually-hidden">You trade as</legend>
              {KINDS.map(({ value, label, detail, Icon }) => (
                <label key={value} className={styles.kind}>
                  <input type="radio" name="entity" value={value} checked={entityType === value} onChange={() => setEntityType(value)} />
                  <span className={styles.kindIcon} aria-hidden="true">
                    <Icon />
                  </span>
                  <span className={styles.kindText}>
                    <span className={styles.kindLabel}>{label}</span>
                    <span className={styles.kindDetail}>{detail}</span>
                  </span>
                  <span className={styles.kindMark} aria-hidden="true" />
                </label>
              ))}
            </fieldset>

            <Field
              label={entityType === 'COMPANY' ? 'Company name' : 'Full name'}
              autoComplete={entityType === 'COMPANY' ? 'organization' : 'name'}
              maxLength={120}
              value={name}
              placeholder={entityType === 'COMPANY' ? 'Meridian Pay Private Limited' : 'Priya Sharma'}
              hint={`You will be its administrator, signed in as ${email}.`}
              onChange={(e) => setName(e.target.value)}
              data-autofocus=""
            />

            <button type="submit" className={`${shell.action} ${shell.wide}`} disabled={open.busy || name.trim() === ''} aria-busy={open.busy || undefined} data-robot-target="cta">
              {open.busy ? <ArcLoader size="sm" label="Opening your account" tone="inherit" /> : null}
              Open account
              {open.busy ? null : <ArrowIcon className={shell.actionIcon} />}
            </button>
            {open.error ? (
              <p className={shell.error} role="alert">
                {sentence(open.error)}
              </p>
            ) : null}
          </form>
        </section>
      </main>

      <aside className={shell.aside} aria-label="What happens next">
        <section className={styles.next}>
          <h2 className={styles.nextTitle}>What happens next</h2>
          <ol className={styles.nextList}>
            <li>
              <span className={styles.nextIcon} aria-hidden="true">
                <UserIcon />
              </span>
              <span>
                <strong>Open your account</strong>
                <span>A name, and the Exchange is yours.</span>
              </span>
            </li>
            <li>
              <span className={styles.nextIcon} aria-hidden="true">
                <LockIcon />
              </span>
              <span>
                <strong>Turn on an authenticator</strong>
                <span>It confirms every change to where you are paid.</span>
              </span>
            </li>
            <li>
              <span className={styles.nextIcon} aria-hidden="true">
                <BankIcon />
              </span>
              <span>
                <strong>Add where you are paid</strong>
                <span>Then ask the desk for your first firm quote.</span>
              </span>
            </li>
          </ol>
        </section>
        <section className={styles.alt}>
          <p>
            <strong>Have INR or USDT to put to work?</strong> Provide capacity to the desk and earn on completed orders.
          </p>
          <Link className={shell.textAction} href="/traders">
            Become a trader instead
          </Link>
        </section>
      </aside>
      {open.dialog}
    </>
  );
}
