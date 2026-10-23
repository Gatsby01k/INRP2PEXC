'use client';

import { useRouter } from 'next/navigation';
import type { MyInviteRow } from '@inrp2p/clients';
import { formatIstDate } from '@inrp2p/ui/format';
import { useCommand } from '../../../components/useCommand.tsx';
import { acceptTeamInviteAction } from '../../../server/actions/team.ts';
import { UsersIcon } from '../_workspace/icons.tsx';
import { sentence } from '../traders/_ui/format.ts';
import shell from '../shell.module.css';
import styles from '../desk/desk.module.css';

/**
 * Invitations to join a team, waiting for the email this person signed in with (ADR 0020 §2.11). Joining makes them a
 * user of that account with the invitation's role; opening an account of their own instead stays possible below.
 */
export function Invitations({ invites }: { invites: readonly MyInviteRow[] }) {
  const router = useRouter();
  const { run, busy, error, dialog } = useCommand();
  if (invites.length === 0) return null;
  return (
    <section className={`${shell.card} ${styles.urgent}`} aria-labelledby="invites-title">
      <div className={shell.cardHead}>
        <h2 id="invites-title" className={shell.cardTitle}>
          {invites.length === 1 ? 'You are invited to a team' : 'You are invited to teams'}
        </h2>
        <UsersIcon className={shell.infoIcon} />
      </div>
      <ul className={styles.people}>
        {invites.map((i) => (
          <li key={i.inviteId} className={styles.person}>
            <span className={styles.pageMark} aria-hidden="true">
              {i.clientName.trim().charAt(0).toUpperCase()}
            </span>
            <span className={styles.whoText}>
              <span className={styles.whoName}>{i.clientName}</span>
              <span className={styles.whoMeta}>
                As {i.role === 'ADMIN' ? 'an administrator' : 'an operator'} · until {formatIstDate(new Date(i.expiresAt))}
              </span>
            </span>
            <button
              type="button"
              className={shell.action}
              data-size="sm"
              disabled={busy}
              onClick={() =>
                void run(`Join ${i.clientName}`, (key) => acceptTeamInviteAction({ inviteId: i.inviteId }, key)).then((out) => {
                  if (out.ok) router.push('/desk');
                })
              }
            >
              Join
            </button>
          </li>
        ))}
      </ul>
      <p className={shell.muted}>Joining uses this email for that account. To trade on your own instead, open an account below.</p>
      {error ? (
        <p className={shell.error} role="alert">
          {sentence(error)}
        </p>
      ) : null}
      {dialog}
    </section>
  );
}
