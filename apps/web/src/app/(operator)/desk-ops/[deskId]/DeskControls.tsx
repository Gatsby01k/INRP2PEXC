'use client';

import { useState } from 'react';
import type { OpsDesk } from '@inrp2p/traders';
import { hideDeskPageAction, renameDeskAction, resumeDeskAction, showDeskPageAction, suspendDeskAction } from '../../../../server/actions/desk-ops.ts';
import { useCommand } from '../../../../components/useCommand.tsx';
import { GuardedAction } from '../../_desk/GuardedAction.tsx';
import { TextField } from '../../_desk/fields.tsx';
import { dateTime } from '../../_desk/format.ts';
import { Notice } from '../../_desk/ui.tsx';
import d from '../../_desk/desk.module.css';
import s from './controls.module.css';

/**
 * What INRP2P can decide about a desk (ADR 0020 §2.17), each with the reason its people will read: stop new deals
 * (suspend) or let it deal again, take its page down or put it back, give it another name or address. Open deals are never
 * touched by any of it.
 */
export function DeskControls({ desk, canModerate }: { desk: OpsDesk; canModerate: boolean }) {
  const cmd = useCommand();
  const [name, setName] = useState(desk.name);
  const [handle, setHandle] = useState(desk.handle);
  if (!canModerate) return <Notice>Deciding about a desk needs a role with desks:moderate.</Notice>;
  const suspended = desk.status === 'SUSPENDED';

  return (
    <div className={d.stack}>
      <div className={s.control} data-state={suspended ? 'on' : undefined}>
        <div className={s.what}>
          <strong>{suspended ? 'Suspended' : 'Taking deals'}</strong>
          <span className={d.muted}>
            {suspended
              ? `Since ${desk.suspendedAt ? dateTime(desk.suspendedAt) : '—'}: “${desk.suspensionReason ?? ''}”`
              : 'Suspending stops new deals at once — prices asked now are withdrawn, links cannot be taken. Deals already accepted settle.'}
          </span>
        </div>
        {suspended ? (
          <GuardedAction
            label="Lift the suspension"
            trigger="secondary"
            busy={cmd.busy}
            stepUp
            consequence="The desk becomes paused: its people take it live again when they are ready."
            reasonLabel="Note for the desk (optional)"
            minReason={0}
            onConfirm={async (note) => (await cmd.run(`Lift the suspension of ${desk.name}`, (k) => resumeDeskAction({ deskId: desk.deskId, note: note.trim() || null }, k))).ok}
          />
        ) : (
          <GuardedAction
            label="Suspend"
            trigger="danger"
            tone="danger"
            busy={cmd.busy}
            stepUp
            consequence={`${desk.name} takes no new deal until INRP2P lifts it. Its people are told why.`}
            reasonLabel="Why — the desk reads this"
            minReason={10}
            onConfirm={async (reason) => (await cmd.run(`Suspend ${desk.name}`, (k) => suspendDeskAction({ deskId: desk.deskId, reason }, k))).ok}
          />
        )}
      </div>

      <div className={s.control} data-state={desk.pageHidden ? 'on' : undefined}>
        <div className={s.what}>
          <strong>{desk.pageHidden ? (desk.editedSinceHidden ? 'Page hidden — changed since' : 'Page hidden') : 'Page shown'}</strong>
          <span className={d.muted}>
            {desk.pageHidden
              ? `Since ${desk.pageHiddenAt ? dateTime(desk.pageHiddenAt) : '—'}: “${desk.pageHiddenReason ?? ''}”${desk.editedSinceHidden ? ' — the desk has changed its name or words since: look again.' : ''}`
              : 'Hide a page whose name or words do not belong on INRP2P: nobody can open it until you show it again.'}
          </span>
        </div>
        {desk.pageHidden ? (
          <GuardedAction
            label="Show the page"
            trigger="secondary"
            busy={cmd.busy}
            stepUp
            consequence={`inrp2p.com/${desk.handle} opens again, as the desk has it now: “${desk.name}”.`}
            reasonLabel="Note for the desk (optional)"
            minReason={0}
            onConfirm={async (note) => (await cmd.run(`Show ${desk.name}’s page`, (k) => showDeskPageAction({ deskId: desk.deskId, note: note.trim() || null }, k))).ok}
          />
        ) : (
          <GuardedAction
            label="Hide the page"
            trigger="secondary"
            busy={cmd.busy}
            stepUp
            consequence={`inrp2p.com/${desk.handle} answers “not found” until INRP2P shows it again. Its clients and links are untouched.`}
            reasonLabel="Why — the desk reads this"
            minReason={10}
            onConfirm={async (reason) => (await cmd.run(`Hide ${desk.name}’s page`, (k) => hideDeskPageAction({ deskId: desk.deskId, reason }, k))).ok}
          />
        )}
      </div>

      <div className={s.control}>
        <div className={s.what}>
          <strong>Name and address</strong>
          <span className={d.muted}>A new address breaks every link to the old one: change it only when the address itself does not belong.</span>
        </div>
        <div className={s.rename}>
          <TextField label="Name" value={name} onChange={setName} maxLength={60} />
          <TextField label="Address" value={handle} onChange={(v) => setHandle(v.toLowerCase())} mono maxLength={30} aside="inrp2p.com/" />
        </div>
        <GuardedAction
          label="Rename"
          trigger="secondary"
          busy={cmd.busy}
          stepUp
          disabled={(name.trim() === desk.name && handle.trim() === desk.handle) || name.trim().length < 2}
          disabledReason={name.trim() === desk.name && handle.trim() === desk.handle ? 'Change the name or the address first.' : null}
          consequence={handle.trim() !== desk.handle ? `The desk becomes “${name.trim()}” at inrp2p.com/${handle.trim()}; inrp2p.com/${desk.handle} stops working.` : `The desk becomes “${name.trim()}”.`}
          reasonLabel="Why — the desk reads this"
          minReason={10}
          onConfirm={async (reason) =>
            (await cmd.run(`Rename ${desk.name}`, (k) => renameDeskAction({ deskId: desk.deskId, ...(name.trim() !== desk.name ? { displayName: name.trim() } : {}), ...(handle.trim() !== desk.handle ? { handle: handle.trim() } : {}), reason }, k))).ok}
        />
      </div>
      {cmd.error ? (
        <Notice tone="danger" role="alert">
          {cmd.error}
        </Notice>
      ) : null}
      {cmd.dialog}
    </div>
  );
}
