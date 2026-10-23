'use client';

import { useState } from 'react';
import { useCommand } from '../../../components/useCommand.tsx';
import { openDeskAction } from '../../../server/actions/desks.ts';
import { Field } from '../_workspace/Field.tsx';
import { PageHead } from '../_workspace/PageHead.tsx';
import { LinkIcon, ShieldIcon, TagIcon, UsersIcon } from '../_workspace/icons.tsx';
import { sentence } from './_ui/format.ts';
import shell from '../shell.module.css';
import styles from './desk.module.css';

const HANDLE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const suggest = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);

/**
 * Opening the desk: what it is, in three lines, and the three things it needs — its address, its name and a sentence
 * about it. It opens as a draft; nothing is shown to anyone until it goes live.
 */
export function OpenDesk({ canAdmin, host, clientName }: { canAdmin: boolean; host: string; clientName: string }) {
  const [name, setName] = useState(clientName);
  const [handle, setHandle] = useState(suggest(clientName));
  const [touched, setTouched] = useState(false);
  const [about, setAbout] = useState('');
  const { run, busy, error } = useCommand();
  const handleOk = HANDLE.test(handle) && !handle.includes('--');

  return (
    <>
      <PageHead eyebrow="Desk" title="Your own exchange, on INRP2P" lede="A page and a link of your own, your prices, your clients. Deals settle through INRP2P’s escrow." />
      <main className={shell.main}>
        <div className={styles.hero}>
          <div className={styles.heroText}>
            <ul className={styles.points}>
              <li className={styles.point}>
                <span className={styles.pointIcon} aria-hidden="true">
                  <LinkIcon />
                </span>
                <span>
                  <p className={styles.pointTitle}>Your page, your link</p>
                  <p className={styles.pointBody}>Clients open {host}/your-name, see your prices and deal in a minute — or take a deal link you send them in chat.</p>
                </span>
              </li>
              <li className={styles.point}>
                <span className={styles.pointIcon} aria-hidden="true">
                  <TagIcon />
                </span>
                <span>
                  <p className={styles.pointTitle}>Your prices, your clients</p>
                  <p className={styles.pointBody}>You set what you pay and what you ask, and who you deal with. Your clients are yours; nobody else sees them.</p>
                </span>
              </li>
              <li className={styles.point}>
                <span className={styles.pointIcon} aria-hidden="true">
                  <ShieldIcon />
                </span>
                <span>
                  <p className={styles.pointTitle}>Escrow on every deal</p>
                  <p className={styles.pointBody}>Rupees go straight between you and your client; USDT waits in the deal’s own escrow until the rupees are confirmed. INRP2P keeps 0.25% of the USDT.</p>
                </span>
              </li>
              <li className={styles.point}>
                <span className={styles.pointIcon} aria-hidden="true">
                  <UsersIcon />
                </span>
                <span>
                  <p className={styles.pointTitle}>Your team</p>
                  <p className={styles.pointBody}>Invite the people who work your deals; each change of who can act is confirmed with your authenticator.</p>
                </span>
              </li>
            </ul>
          </div>

          <form
            className={`${shell.surface} ${styles.form}`}
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (!handleOk || name.trim().length < 2) return;
              void run('Open your desk', (key) => openDeskAction({ handle, displayName: name.trim(), about: about.trim() || null }, key));
            }}
          >
            <h2 className={shell.cardTitle}>Open your desk</h2>
            <Field label="Name clients see" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} error={touched && name.trim().length < 2 ? 'At least two characters.' : null} />
            <Field
              label="Your address"
              value={handle}
              maxLength={30}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              mono
              adornment={`${host}/`}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              error={touched && !handleOk ? '3–30 letters, digits and hyphens; not starting or ending with a hyphen.' : null}
              hint="Fixed once your desk has gone live."
              valid={handleOk}
            />
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="desk-about">
                About your desk <span className={shell.muted}>· optional</span>
              </label>
              <textarea
                id="desk-about"
                className={styles.textarea}
                maxLength={280}
                placeholder="Mumbai OTC desk since 2019. IMPS and NEFT, 9:00–23:00."
                value={about}
                onChange={(e) => setAbout(e.target.value)}
              />
            </div>
            {canAdmin ? null : <p className={shell.info} data-tone="warning">An administrator of your account opens the desk.</p>}
            {error ? (
              <p className={shell.error} role="alert">
                {sentence(error)}
              </p>
            ) : null}
            <button type="submit" className={`${shell.action} ${shell.wide}`} disabled={!canAdmin || busy} aria-busy={busy || undefined}>
              {busy ? 'Opening…' : 'Open desk'}
            </button>
            <p className={shell.muted}>It opens as a draft. Nothing is public until you take it live.</p>
          </form>
        </div>
      </main>
    </>
  );
}
