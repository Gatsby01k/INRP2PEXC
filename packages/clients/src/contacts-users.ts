import { sql } from 'kysely';
import { DomainError, last4, normalizePhone, optionalText, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { ClientUserRole } from '@inrp2p/db';
import { isUniqueViolation } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import type { FieldProtector } from '@inrp2p/adapters';
import { type OperatorActor, actorLabel, operatorCommand } from '@inrp2p/identity';
import { type ClientDataActor, clientDataCommand } from './authz.ts';
import { requireActiveClient } from './clients.ts';

export const contactPhoneSealContext = (clientId: string, field: 'phone' | 'whatsapp') => `client_contact.${field}:${clientId}`;

export interface AddContactPayload {
  readonly clientId: string;
  readonly name: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly whatsapp?: string | null;
  readonly telegramHandle?: string | null;
  readonly isPrimary?: boolean;
  readonly notes?: string | null;
}

/**
 * `client_contact.add` — `client:manage_contacts`. CRM record only: never an authentication or OTP channel
 * (DOMAIN_MODEL §2.2). Phone numbers are envelope-encrypted (SECURITY §5).
 */
export function addContact(actor: OperatorActor, protector: FieldProtector) {
  return operatorCommand(actor, 'client:manage_contacts', async (ctx, p: AddContactPayload) => {
    const client = await requireActiveClient(ctx.tx, p.clientId);
    const email = optionalText(p.email, 'email', 254)?.toLowerCase() ?? null;
    if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) throw new DomainError('INVALID_ARGUMENT', 'invalid email', { field: 'email' });
    const phone = p.phone ? normalizePhone(p.phone) : null;
    const whatsapp = p.whatsapp ? normalizePhone(p.whatsapp, 'whatsapp') : null;
    const telegram = optionalText(p.telegramHandle, 'telegramHandle', 33);
    if (telegram && !/^@?[A-Za-z0-9_]{5,32}$/.test(telegram)) throw new DomainError('INVALID_ARGUMENT', 'invalid Telegram handle', { field: 'telegramHandle' });
    if (p.isPrimary) {
      await ctx.tx.updateTable('client_contact').set({ is_primary: false }).where('client_id', '=', client.id).where('is_primary', '=', true).where('status', '=', 'ACTIVE').execute();
    }
    const row = await ctx.tx
      .insertInto('client_contact')
      .values({
        client_id: client.id,
        name: requireText(p.name, 'name', 120),
        email,
        phone_enc: phone ? await protector.seal(phone, contactPhoneSealContext(client.id, 'phone')) : null,
        phone_last4: phone ? last4(phone) : null,
        whatsapp_enc: whatsapp ? await protector.seal(whatsapp, contactPhoneSealContext(client.id, 'whatsapp')) : null,
        whatsapp_last4: whatsapp ? last4(whatsapp) : null,
        telegram_handle: telegram,
        is_primary: Boolean(p.isPrimary),
        notes: optionalText(p.notes, 'notes'),
        created_by: actorLabel(ctx),
      })
      .returning(['id', 'client_id', 'name', 'email', 'phone_last4', 'whatsapp_last4', 'telegram_handle', 'is_primary'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'client_contact.added', entityType: 'client_contact', entityId: row.id, after: row });
    return { contactId: row.id };
  });
}

export function archiveContact(actor: OperatorActor) {
  return operatorCommand(actor, 'client:manage_contacts', async (ctx, p: { contactId: string }) => {
    const before = await ctx.tx.selectFrom('client_contact').select(['id', 'status']).where('id', '=', requireUuid(p.contactId, 'contactId')).forUpdate().executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', 'contact not found');
    if (before.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'contact is already archived');
    await ctx.tx.updateTable('client_contact').set({ status: 'ARCHIVED', is_primary: false, archived_by: actorLabel(ctx), archived_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: 'client_contact.archived', entityType: 'client_contact', entityId: before.id, before: { status: 'ACTIVE' }, after: { status: 'ARCHIVED' } });
    return { archived: true };
  });
}

export interface LinkClientUserPayload {
  readonly clientId: string;
  /** An existing CLIENT auth user (provisioned through Better Auth). */
  readonly userId: string;
  readonly role: ClientUserRole;
}

/**
 * `client_user.link` — `client:manage`. Always starts without quote-acceptance rights: granting
 * `can_accept_quotes` is a separate, step-up command (SECURITY §2.2).
 */
export function linkClientUser(actor: OperatorActor) {
  return operatorCommand(actor, 'client:manage', async (ctx, p: LinkClientUserPayload) => {
    const client = await requireActiveClient(ctx.tx, p.clientId);
    const user = await ctx.tx.selectFrom('auth_user').select(['id', 'kind', 'status']).where('id', '=', requireUuid(p.userId, 'userId')).executeTakeFirst();
    if (!user) throw new DomainError('NOT_FOUND', 'user not found');
    if (user.kind !== 'CLIENT') throw new DomainError('INVALID_ARGUMENT', 'only CLIENT users can be linked to a client');
    let row;
    try {
      row = await ctx.tx
        .insertInto('client_user')
        .values({ client_id: client.id, user_id: user.id, role: requireOneOf(p.role, 'role', ['CLIENT_ADMIN', 'CLIENT_TRADER'] as const), created_by: actorLabel(ctx) })
        .returning(['id', 'client_id', 'user_id', 'role', 'can_accept_quotes', 'status'])
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('INVALID_ARGUMENT', 'user is already linked to a client');
      throw e;
    }
    await appendAudit(ctx, { action: 'client_user.linked', entityType: 'client_user', entityId: row.id, after: row });
    return { clientUserId: row.id };
  });
}

/**
 * `client_user.set_accept_quotes` — operator `client_user:grant_accept_quotes` (⧗) or a CLIENT_ADMIN of the same
 * client. Grant and revoke are sensitive: fresh TOTP step-up on both paths (SECURITY §2.2); a client admin without TOTP
 * must enroll first. Disabled users cannot be granted.
 */
export function setCanAcceptQuotes(actor: ClientDataActor) {
  return clientDataCommand(
    actor,
    'client_user:grant_accept_quotes',
    { stepUp: true },
    async (ctx, p: { clientUserId: string; canAcceptQuotes: boolean }) => {
      const row = await ctx.tx.selectFrom('client_user').select('client_id').where('id', '=', requireUuid(p.clientUserId, 'clientUserId')).executeTakeFirst();
      if (!row) throw new DomainError('NOT_FOUND', 'client user not found');
      return row.client_id;
    },
    async (ctx, p) => {
      if (typeof p.canAcceptQuotes !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'canAcceptQuotes must be boolean');
      const before = await ctx.tx.selectFrom('client_user').select(['id', 'can_accept_quotes', 'status']).where('id', '=', p.clientUserId).forUpdate().executeTakeFirstOrThrow();
      if (before.can_accept_quotes === p.canAcceptQuotes) return { changed: false };
      if (p.canAcceptQuotes && before.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'cannot grant acceptance to a disabled client user');
      await ctx.tx.updateTable('client_user').set({ can_accept_quotes: p.canAcceptQuotes, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
      await appendAudit(ctx, { action: 'client_user.accept_permission_changed', entityType: 'client_user', entityId: before.id, before: { can_accept_quotes: before.can_accept_quotes }, after: { can_accept_quotes: p.canAcceptQuotes, changed_via: actor.kind } });
      return { changed: true };
    },
  );
}

/** `client_user.set_status` — `client:manage`. Disabling also withdraws quote-acceptance rights. */
export function setClientUserStatus(actor: OperatorActor) {
  return operatorCommand(actor, 'client:manage', async (ctx, p: { clientUserId: string; status: 'ACTIVE' | 'DISABLED'; reason: string }) => {
    const status = requireOneOf(p.status, 'status', ['ACTIVE', 'DISABLED'] as const);
    const reason = requireText(p.reason, 'reason', 500);
    const before = await ctx.tx.selectFrom('client_user').select(['id', 'status', 'can_accept_quotes']).where('id', '=', requireUuid(p.clientUserId, 'clientUserId')).forUpdate().executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', 'client user not found');
    if (before.status === status) return { changed: false };
    const canAccept = status === 'DISABLED' ? false : before.can_accept_quotes;
    await ctx.tx.updateTable('client_user').set({ status, can_accept_quotes: canAccept, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', before.id).execute();
    await appendAudit(ctx, { action: status === 'DISABLED' ? 'client_user.disabled' : 'client_user.enabled', entityType: 'client_user', entityId: before.id, before, after: { status, can_accept_quotes: canAccept, reason } });
    return { changed: true };
  });
}
