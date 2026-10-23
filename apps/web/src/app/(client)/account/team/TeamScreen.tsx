'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { TeamInviteRow, TeamMemberRow } from '@inrp2p/clients';
import { formatIstDate } from '@inrp2p/ui/format';
import { useCommand } from '../../../../components/useCommand.tsx';
import { inviteTeamMemberAction, removeTeamMemberAction, revokeTeamInviteAction, setTeamMemberRoleAction } from '../../../../server/actions/team.ts';
import { Field, Segmented } from '../../_workspace/Field.tsx';
import { MoreIcon, PlusIcon, ShieldIcon } from '../../_workspace/icons.tsx';
import { Sheet } from '../../_workspace/Sheet.tsx';
import shell from '../../shell.module.css';
import styles from '../../desk/desk.module.css';

const ROLE_WORDS: Record<TeamMemberRow['role'], string> = { ADMIN: 'Administrator', OPERATOR: 'Operator', VIEWER: 'Viewer' };
const initial = (s: string) => s.trim().charAt(0).toUpperCase() || '·';
const sentence = (m: string) => {
  const t = m.trim();
  const f = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(f) ? f : `${f}.`;
};

function refusal(error: string | null): React.ReactNode {
  if (!error) return null;
  if (/authenticator first|enroll/i.test(error)) {
    return (
      <p className={shell.error} role="alert">
        Set up your authenticator first — it confirms every change to who can act for your account. <Link className={shell.textAction} href="/account">Account & security</Link>
      </p>
    );
  }
  return (
    <p className={shell.error} role="alert">
      {sentence(error)}
    </p>
  );
}

function MemberMenu({ member, busy, onRole, onRemove }: { member: TeamMemberRow; busy: boolean; onRole: (role: 'ADMIN' | 'OPERATOR') => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className={styles.menu} ref={ref}>
      <button type="button" className={styles.iconButton} aria-haspopup="menu" aria-expanded={open} aria-label={`Change ${member.email}`} disabled={busy} onClick={() => setOpen(!open)}>
        <MoreIcon />
      </button>
      {open ? (
        <div className={styles.menuList} role="menu">
          {member.role !== 'ADMIN' ? (
            <button type="button" role="menuitem" className={styles.menuItem} onClick={() => (setOpen(false), onRole('ADMIN'))}>
              Make administrator
            </button>
          ) : null}
          {member.role !== 'OPERATOR' ? (
            <button type="button" role="menuitem" className={styles.menuItem} onClick={() => (setOpen(false), onRole('OPERATOR'))}>
              Make operator
            </button>
          ) : null}
          <button type="button" role="menuitem" className={styles.menuItem} data-danger="" onClick={() => (setOpen(false), onRemove())}>
            Remove from team
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The people who can act for the account, and the invitations still waiting. An administrator invites by email, changes
 * a role and removes someone — each confirmed with their authenticator; nobody changes or removes themselves.
 */
export function TeamScreen({ members, invites, isAdmin, clientName }: { members: readonly TeamMemberRow[]; invites: readonly TeamInviteRow[]; isAdmin: boolean; clientName: string }) {
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'OPERATOR' | 'ADMIN'>('OPERATOR');
  const [sent, setSent] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TeamMemberRow | null>(null);
  const invite = useCommand();
  const change = useCommand();
  const active = members.filter((m) => m.status === 'ACTIVE');
  const past = members.filter((m) => m.status !== 'ACTIVE');
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());

  return (
    <main className={shell.main}>
      <section className={shell.card} aria-labelledby="people-title">
        <div className={shell.cardHead}>
          <div className={styles.checkText}>
            <h2 id="people-title" className={shell.cardTitle}>
              People
            </h2>
            <span className={shell.muted}>{active.length === 1 ? 'One person acts for ' : `${active.length} people act for `}{clientName}.</span>
          </div>
          {isAdmin ? (
            <button type="button" className={shell.action} data-size="sm" data-tone="ink" onClick={() => setInviting(true)}>
              <PlusIcon className={shell.actionIcon} />
              Invite
            </button>
          ) : null}
        </div>
        <ul className={styles.people}>
          {[...active, ...past].map((m) => (
            <li key={m.clientUserId} className={styles.person} {...(m.status !== 'ACTIVE' ? { 'data-disabled': '' } : {})}>
              <span className={styles.avatar} aria-hidden="true">
                {initial(m.email)}
              </span>
              <span className={styles.whoText}>
                <span className={styles.whoName}>
                  {m.email}
                  {m.isYou ? <span className={shell.muted}> · you</span> : null}
                </span>
                <span className={styles.whoMeta}>
                  {m.status !== 'ACTIVE' ? 'Removed' : `Since ${formatIstDate(new Date(m.since))}`}
                  {m.authenticator ? ' · authenticator on' : ''}
                </span>
              </span>
              <span className={styles.personActions}>
                <span className={styles.roleTag} data-role={m.role}>
                  {ROLE_WORDS[m.role]}
                </span>
                {isAdmin && !m.isYou && m.status === 'ACTIVE' ? (
                  <MemberMenu
                    member={m}
                    busy={change.busy}
                    onRole={(next) => void change.run(`Make ${m.email} ${ROLE_WORDS[next].toLowerCase()}`, (key) => setTeamMemberRoleAction({ clientUserId: m.clientUserId, role: next }, key))}
                    onRemove={() => setRemoving(m)}
                  />
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {refusal(change.error)}
      </section>

      {invites.length > 0 ? (
        <section className={shell.card} aria-labelledby="invites-title">
          <h2 id="invites-title" className={shell.cardTitle}>
            Invitations waiting
          </h2>
          <ul className={styles.people}>
            {invites.map((i) => (
              <li key={i.inviteId} className={styles.person} {...(i.expired ? { 'data-disabled': '' } : {})}>
                <span className={styles.avatar} aria-hidden="true">
                  {initial(i.email)}
                </span>
                <span className={styles.whoText}>
                  <span className={styles.whoName}>{i.email}</span>
                  <span className={styles.whoMeta}>
                    {ROLE_WORDS[i.role]} · {i.expired ? 'expired' : `until ${formatIstDate(new Date(i.expiresAt))}`}
                    {i.emailSent ? ' · email sent' : ''}
                  </span>
                </span>
                {isAdmin ? (
                  <button type="button" className={shell.textAction} disabled={change.busy} onClick={() => void change.run(`Withdraw the invitation to ${i.email}`, (key) => revokeTeamInviteAction({ inviteId: i.inviteId }, key))}>
                    Withdraw
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={shell.card} aria-labelledby="roles-title">
        <h2 id="roles-title" className={shell.cardTitle}>
          Who can do what
        </h2>
        <dl className={shell.facts}>
          <div>
            <dt>Administrator</dt>
            <dd>Everything: the team, the desk’s page and status, where the account is paid — and deals.</dd>
          </div>
          <div>
            <dt>Operator</dt>
            <dd>Deals: prices, deal links, clients, confirming payments.</dd>
          </div>
        </dl>
        <p className={shell.info}>
          <ShieldIcon className={shell.infoIcon} />
          <span>Every change to who can act for {clientName} is confirmed with an administrator’s authenticator, and the whole team is told by email.</span>
        </p>
      </section>

      <Sheet
        open={inviting}
        onClose={() => {
          setInviting(false);
          setSent(null);
          setEmail('');
          invite.clearError();
        }}
        locked={invite.busy}
        eyebrow="Team"
        title={sent ? 'Invitation sent' : 'Invite someone'}
        description={sent ? undefined : 'They sign in with this email and accept. The invitation is valid for seven days.'}
        footer={
          sent ? null : (
            <button
              type="button"
              className={`${shell.action} ${shell.wide}`}
              disabled={!emailOk || invite.busy}
              aria-busy={invite.busy || undefined}
              onClick={() =>
                void invite.run(`Invite ${email.trim()}`, (key) => inviteTeamMemberAction({ email: email.trim(), role }, key)).then((out) => {
                  if (out.ok) setSent(email.trim());
                })
              }
            >
              {invite.busy ? 'Sending…' : 'Send invitation'}
            </button>
          )
        }
      >
        {sent ? (
          <p className={shell.lede}>
            We emailed {sent}. Once they sign in with it and accept, they appear under People — and everyone on the team is told.
          </p>
        ) : (
          <div className={styles.form}>
            <Field label="Email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ravi@yourdesk.in" data-autofocus="" />
            <Segmented<'OPERATOR' | 'ADMIN'>
              legend="Role"
              value={role}
              onChange={setRole}
              options={[
                { value: 'OPERATOR', label: 'Operator', detail: 'Works deals' },
                { value: 'ADMIN', label: 'Administrator', detail: 'Runs the account' },
              ]}
            />
            {refusal(invite.error)}
          </div>
        )}
      </Sheet>

      <Sheet
        open={removing !== null}
        onClose={() => setRemoving(null)}
        variant="dialog"
        locked={change.busy}
        title={removing ? `Remove ${removing.email}?` : ''}
        description="They stop acting for the account at once and are signed out everywhere. Invitations they sent are withdrawn."
        footer={
          <button
            type="button"
            className={`${shell.action} ${shell.wide}`}
            disabled={change.busy}
            onClick={() => {
              const m = removing;
              if (!m) return;
              void change.run(`Remove ${m.email}`, (key) => removeTeamMemberAction({ clientUserId: m.clientUserId }, key)).then(() => setRemoving(null));
            }}
          >
            Remove from team
          </button>
        }
      >
        <span />
      </Sheet>
      {invite.dialog}
      {change.dialog}
    </main>
  );
}
