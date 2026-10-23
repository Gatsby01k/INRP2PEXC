import { sql } from 'kysely';
import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import type { NotificationAdapter } from '@inrp2p/adapters';
import type { OutboxHandler } from '@inrp2p/outbox';

export type InviteDeliveryOutcome = 'SENT' | 'ALREADY_SENT' | 'CLOSED';

/**
 * Emails an invitation to a client's team (docs/adr/0020-desks.md §2.11). The person invited has no account with the
 * client yet, so this is not a copy of an inbox row: it is the one message that tells them, sent to the invitation's own
 * address. It carries no secret — only who invited them, as what, until when, and where to sign in — so a forwarded
 * email lets no one else in.
 *
 * Sent once: under the invitation's row lock, with the invitation's id as the provider's idempotency key, and recorded
 * with the provider's message id. An invitation withdrawn, accepted or expired before the send is not sent. A failed
 * send throws, so the outbox tries again; it is never recorded as sent because it was attempted.
 */
export async function deliverTeamInvite(db: Db, adapter: NotificationAdapter, input: { inviteId: string; linkBase?: string | undefined }): Promise<InviteDeliveryOutcome> {
  const id = requireUuid(input.inviteId, 'inviteId');
  return db.transaction().execute(async (tx) => {
    const invite = await tx
      .selectFrom('client_invite as i')
      .innerJoin('client as c', 'c.id', 'i.client_id')
      .select(['i.id', 'i.email', 'i.role', 'i.status', 'i.expires_at', 'i.email_sent_at', 'c.display_name', sql<boolean>`i.expires_at <= inrp2p_now()`.as('expired')])
      .where('i.id', '=', id)
      .forUpdate('i')
      .executeTakeFirst();
    if (!invite) throw new DomainError('NOT_FOUND', 'invitation not found');
    if (invite.email_sent_at) return 'ALREADY_SENT' as const;
    if (invite.status !== 'PENDING' || invite.expired) return 'CLOSED' as const;

    const name = invite.display_name.replace(/\s+/g, ' ').trim();
    const until = invite.expires_at.toISOString().slice(0, 10);
    const link = input.linkBase ? new URL('/open-account', input.linkBase).toString() : null;
    const { providerMessageId } = await adapter.sendClientNotification({
      deliveryId: invite.id,
      to: invite.email,
      subject: `${name} invited you to its team on INRP2P Exchange`,
      body: `${name} invited you to act for its account on INRP2P Exchange as ${invite.role === 'ADMIN' ? 'an administrator' : 'an operator'}. Sign in with this email address to accept. The invitation is valid until ${until}. If you do not know ${name}, ignore this email.`,
      link,
    });
    await tx
      .updateTable('client_invite')
      .set({ email_sent_at: sql<Date>`inrp2p_now()`, email_message_id: providerMessageId.slice(0, 200) })
      .where('id', '=', invite.id)
      .where('email_sent_at', 'is', null)
      .execute();
    return 'SENT' as const;
  });
}

/**
 * Outbox handler for `client_invite.send`. Registered whatever the email configuration, like acceptance codes: a person
 * is waiting for it, so an invitation that cannot be sent fails loudly and stays visible as a failed delivery.
 */
export function teamInviteEmailHandler(db: Db, adapter: NotificationAdapter, opts: { linkBase?: string | undefined } = {}): OutboxHandler {
  return {
    name: 'team_invite_email',
    handles: (type) => type === 'client_invite.send',
    run: async (event) => {
      const payload = event.payload as { inviteId?: unknown };
      await deliverTeamInvite(db, adapter, { inviteId: String(payload.inviteId ?? ''), linkBase: opts.linkBase });
    },
  };
}
