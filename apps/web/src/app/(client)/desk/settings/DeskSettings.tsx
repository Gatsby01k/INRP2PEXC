'use client';

import { useState } from 'react';
import type { DeskPriceView, DeskSummary } from '@inrp2p/traders';
import { CopyButton } from '@inrp2p/ui';
import { useCommand } from '../../../../components/useCommand.tsx';
import { setDeskStatusAction, updateDeskAction } from '../../../../server/actions/desks.ts';
import { Field } from '../../_workspace/Field.tsx';
import { InfoIcon } from '../../_workspace/icons.tsx';
import { DeskNotice } from '../_ui/DeskNotice.tsx';
import { DeskStatus } from '../_ui/DeskStatus.tsx';
import { rate, sentence, usdt } from '../_ui/format.ts';
import shell from '../../shell.module.css';
import styles from '../desk.module.css';

const HANDLE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * The desk as its clients meet it — a card drawn from what is saved — then what the administrator can change: its name,
 * its description, its address while it is still a draft, and whether it takes deals.
 */
export function DeskSettings({ desk, prices, host, canAdmin, approved }: { desk: DeskSummary; prices: Readonly<Record<'SELL_USDT' | 'BUY_USDT', DeskPriceView | null>>; host: string; canAdmin: boolean; approved: boolean }) {
  const [name, setName] = useState(desk.displayName);
  const [about, setAbout] = useState(desk.about ?? '');
  const [handle, setHandle] = useState(desk.handle);
  const edit = useCommand();
  const status = useCommand();
  const draft = desk.status === 'DRAFT';
  const dirty = name.trim() !== desk.displayName || (about.trim() || null) !== desk.about || (draft && handle !== desk.handle);
  const handleOk = HANDLE.test(handle) && !handle.includes('--');
  const address = `${host}/${desk.handle}`;

  return (
    <main className={shell.main}>
      <DeskNotice desk={desk} />
      <div className={styles.grid2}>
        <section className={styles.pageCard} aria-label="Your page, as clients see it">
          <div className={styles.pageCardHead}>
            <span className={styles.pageMark} aria-hidden="true">
              {desk.displayName.trim().charAt(0).toUpperCase()}
            </span>
            <span className={styles.checkText}>
              <p className={styles.pageName}>{desk.displayName}</p>
              <span className={shell.muted}>{address}</span>
            </span>
          </div>
          {desk.about ? <p className={styles.pageAbout}>{desk.about}</p> : null}
          <div className={styles.priceTiles}>
            {(['SELL_USDT', 'BUY_USDT'] as const).map((d) => {
              const p = prices[d];
              const on = desk.status === 'LIVE' && (p?.offered ?? false);
              return (
                <div key={d} className={styles.priceTile} {...(on ? {} : { 'data-off': '' })}>
                  <span className={styles.priceCaption}>{d === 'SELL_USDT' ? 'Sell USDT' : 'Buy USDT'}</span>
                  <span className={styles.priceValue}>{on && p ? rate(p.rate) : '—'}</span>
                  <span className={styles.priceMeta}>{on && p ? `${usdt(p.min, false)}–${usdt(p.max)}` : desk.status === 'LIVE' ? 'Not offered now' : 'Shown once live'}</span>
                </div>
              );
            })}
          </div>
          <span className={styles.address}>
            <span className={styles.addressText}>{address}</span>
            <CopyButton value={`https://${address}`} label="your page’s address" />
          </span>
        </section>

        <section className={shell.card} aria-labelledby="status-title">
          <div className={shell.cardHead}>
            <h2 id="status-title" className={shell.cardTitle}>
              Taking deals
            </h2>
            <DeskStatus status={desk.status} />
          </div>
          <p className={shell.lede}>
            {desk.status === 'LIVE'
              ? 'Your page prices clients instantly and your links work. Pausing keeps the page up but takes no new deals; deals already accepted carry on.'
              : desk.status === 'SUSPENDED'
                ? 'INRP2P has suspended your desk: no new deals until INRP2P lifts it. Deals already accepted carry on.'
                : desk.status === 'PAUSED'
                ? 'Your page is up but takes no deals, and your links cannot be taken. Resume whenever you are ready.'
                : 'Your desk is a draft: nothing is public yet. Going live publishes your page and lets you send deal links.'}
          </p>
          {draft && !approved ? (
            <p className={shell.info} data-tone="warning">
              <InfoIcon className={shell.infoIcon} />
              <span>Your desk goes live once INRP2P has approved you as a trader.</span>
            </p>
          ) : null}
          {status.error ? (
            <p className={shell.error} role="alert">
              {sentence(status.error)}
            </p>
          ) : null}
          {canAdmin && desk.status !== 'SUSPENDED' ? (
            <div className={styles.cardActions}>
              {desk.status === 'LIVE' ? (
                <button type="button" className={shell.secondaryAction} disabled={status.busy} onClick={() => void status.run('Pause your desk', (key) => setDeskStatusAction({ expectedVersion: desk.version, status: 'PAUSED' }, key))}>
                  Pause desk
                </button>
              ) : (
                <button type="button" className={shell.action} disabled={status.busy || (draft && !approved)} aria-busy={status.busy || undefined} onClick={() => void status.run(draft ? 'Go live' : 'Resume', (key) => setDeskStatusAction({ expectedVersion: desk.version, status: 'LIVE' }, key))}>
                  {draft ? 'Go live' : 'Resume deals'}
                </button>
              )}
            </div>
          ) : desk.status === 'SUSPENDED' ? null : (
            <p className={shell.muted}>An administrator takes the desk live or pauses it.</p>
          )}
        </section>
      </div>

      <section className={shell.card} aria-labelledby="details-title">
        <h2 id="details-title" className={shell.cardTitle}>
          Details
        </h2>
        <div className={styles.form}>
          <Field label="Name clients see" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} disabled={!canAdmin} error={name.trim().length < 2 ? 'At least two characters.' : null} />
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor="desk-about-edit">
              About your desk
            </label>
            <textarea id="desk-about-edit" className={styles.textarea} maxLength={280} value={about} onChange={(e) => setAbout(e.target.value)} disabled={!canAdmin} placeholder="Mumbai OTC desk since 2019. IMPS and NEFT, 9:00–23:00." />
          </div>
          <Field
            label="Address"
            value={handle}
            mono
            adornment={`${host}/`}
            maxLength={30}
            disabled={!canAdmin || !draft}
            onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            hint={draft ? 'Fixed once your desk has gone live.' : 'Fixed: your clients already know it.'}
            error={draft && !handleOk ? '3–30 letters, digits and hyphens.' : null}
          />
          {edit.error ? (
            <p className={shell.error} role="alert">
              {sentence(edit.error)}
            </p>
          ) : null}
          {canAdmin ? (
            <div className={styles.cardActions}>
              <button
                type="button"
                className={shell.action}
                disabled={!dirty || edit.busy || name.trim().length < 2 || (draft && !handleOk)}
                aria-busy={edit.busy || undefined}
                onClick={() =>
                  void edit.run('Save your page', (key) =>
                    updateDeskAction({ expectedVersion: desk.version, displayName: name.trim(), about: about.trim() || null, ...(draft && handle !== desk.handle ? { handle } : {}) }, key),
                  )
                }
              >
                {edit.busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : null}
        </div>
      </section>
      {edit.dialog}
      {status.dialog}
    </main>
  );
}
