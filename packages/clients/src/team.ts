import { sql } from 'kysely';
import { DomainError, requireOneOf, requireUuid } from '@inrp2p/kernel';
import type { ClientUserRole, Executor, TeamRole, TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type ClientActor, type DomainCommand, actorLabel } from '@inrp2p/identity';
import { type ClientAdminCheck, authorizeClientAdmin } from './authz.ts';

/**
 * A client's team (docs/adr/0020-desks.md §2.11). A desk's trader is a client, so its people are the client's users: an
 * administrator invites a person by email, the person signs in with that email and accepts, and becomes an
 * administrator (`CLIENT_ADMIN`) or an operator (`CLIENT_TRADER`) of the client. Both can bind it — accept quotes and
 * orders, set prices, make deal links (`can_accept_quotes`, D-01); only an administrator manages the team, the desk's
 * page and where the client is paid.
 *
 * Every change to who can bind the client is a sensitive client-admin action (SECURITY §2.2): inviting, changing a role
 * and removing someone need the administrator's fresh authenticator code. Withdrawing an invitation takes no one's
 * authority, so it needs none. An administrator never changes or removes themselves — another administrator does — so a
 * client always keeps one. Everyone on the team hears of every join, role change and removal.
 */

/** How long an invitation can be accepted: seven days of elapsed time (in hours, so a clock change cannot stretch it). */
export const TEAM_INVITE_VALID_DAYS = 7;
/** Invitations waiting at once per client: a team is people the administrator knows, not a mailing list. */
export const MAX_PENDING_INVITES = 20;

const AUTHORITY: Readonly<Record<TeamRole, { readonly role: ClientUserRole; readonly canAcceptQuotes: boolean }>> = {
  ADMIN: { role: 'CLIENT_ADMIN', canAcceptQuotes: true },
  OPERATOR: { role: 'CLIENT_TRADER', canAcceptQuotes: true },
};

/** What a member is to the team: a user linked by the desk without quote rights only views. */
export type TeamMemberRole = TeamRole | 'VIEWER';
export const teamRoleOf = (role: ClientUserRole, canAcceptQuotes: boolean): TeamMemberRole =>
  role === 'CLIENT_ADMIN' ? 'ADMIN' : canAcceptQuotes ? 'OPERATOR' : 'VIEWER';

export function normalizeInviteEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DomainError('INVALID_ARGUMENT', 'enter a valid email address', { field: 'email' });
  return email;
}

interface TeamAdmin extends ClientAdminCheck {
  readonly clientId: string;
}

/**
 * A team command of a client administrator. The client is the administrator's own (from the membership, never the
 * payload). The handler runs under the client's row lock, re-checking that the administrator is still one: two
 * administrators removing each other at once cannot both succeed and leave the client with none.
 */
function teamAdminCommand<P, R>(actor: ClientActor, stepUp: boolean, handle: (ctx: TxContext, payload: P, admin: TeamAdmin) => Promise<R>): DomainCommand<P, R> {
  let admin: TeamAdmin | undefined;
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const member = await ctx.tx.selectFrom('client_user').select('client_id').where('user_id', '=', requireUuid(actor.userId, 'userId')).executeTakeFirst();
      if (!member) throw new DomainError('FORBIDDEN', 'this account is not linked to a client');
      admin = { clientId: member.client_id, ...(await authorizeClientAdmin(ctx.tx, actor, member.client_id, { stepUp })) };
    },
    handle: async (ctx, payload) => {
      if (!admin) throw new Error('team command executed without authorization');
      await ctx.tx.selectFrom('client').select('id').where('id', '=', admin.clientId).forUpdate().executeTakeFirstOrThrow();
      const still = await ctx.tx.selectFrom('client_user').select(['role', 'status']).where('id', '=', admin.clientUserId).executeTakeFirstOrThrow();
      if (still.role !== 'CLIENT_ADMIN' || still.status !== 'ACTIVE') throw new DomainError('FORBIDDEN', 'you are no longer an administrator of this account');
      return handle(ctx, payload, admin);
    },
  };
}

/** Withdraws the invitations a person made who can no longer invite (removed, or no longer an administrator). */
async function revokeInvitesBy(ctx: TxContext, clientUserId: string, reason: string): Promise<string[]> {
  const rows = await ctx.tx
    .updateTable('client_invite')
    .set({ status: 'REVOKED', revoked_by: actorLabel(ctx), revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: reason })
    .where('invited_by', '=', clientUserId)
    .where('status', '=', 'PENDING')
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

async function teamMemberForUpdate(ctx: TxContext, clientId: string, clientUserId: string) {
  const row = await ctx.tx
    .selectFrom('client_user')
    .select(['id', 'user_id', 'role', 'can_accept_quotes', 'status'])
    .where('id', '=', requireUuid(clientUserId, 'clientUserId'))
    .where('client_id', '=', clientId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new DomainError('NOT_FOUND', 'this person is not on your team');
  return row;
}

export interface InviteTeamMemberPayload {
  readonly email: string;
  readonly role: TeamRole;
}

/**
 * `client_invite.create` — an administrator, with a fresh authenticator code, invites a person by email. Inviting the
 * same email again replaces the waiting invitation. The invitation is emailed (`client_invite.send`); it carries no
 * secret, so only a person signed in with that email can accept it. Whether the email already has an INRP2P account is
 * not revealed here.
 */
export function inviteTeamMember(actor: ClientActor) {
  return teamAdminCommand(actor, true, async (ctx, p: InviteTeamMemberPayload, admin) => {
    const email = normalizeInviteEmail(p.email);
    const role = requireOneOf(p.role, 'role', ['ADMIN', 'OPERATOR'] as const);
    const member = await ctx.tx
      .selectFrom('client_user as cu')
      .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
      .select('cu.id')
      .where('cu.client_id', '=', admin.clientId)
      .where('cu.status', '=', 'ACTIVE')
      .where(sql<boolean>`lower(u.email) = ${email}`)
      .executeTakeFirst();
    if (member) throw new DomainError('ALREADY_MEMBER', 'this person is already on your team');

    const replaced = await ctx.tx
      .updateTable('client_invite')
      .set({ status: 'REVOKED', revoked_by: actorLabel(ctx), revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: 'replaced by a new invitation' })
      .where('client_id', '=', admin.clientId)
      .where('email', '=', email)
      .where('status', '=', 'PENDING')
      .returning('id')
      .execute();
    const waiting = await ctx.tx
      .selectFrom('client_invite')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('client_id', '=', admin.clientId)
      .where('status', '=', 'PENDING')
      .where(sql<boolean>`expires_at > inrp2p_now()`)
      .executeTakeFirstOrThrow();
    if (waiting.n >= MAX_PENDING_INVITES) throw new DomainError('RATE_LIMITED', `you have ${MAX_PENDING_INVITES} invitations waiting; withdraw some first`);

    const row = await ctx.tx
      .insertInto('client_invite')
      .values({ client_id: admin.clientId, email, role, invited_by: admin.clientUserId, expires_at: sql<Date>`inrp2p_now() + make_interval(hours => ${TEAM_INVITE_VALID_DAYS * 24})` })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();
    await enqueueOutbox(ctx, { type: 'client_invite.send', aggregateType: 'client', aggregateId: admin.clientId, payload: { inviteId: row.id } });
    await appendAudit(ctx, {
      action: 'client_invite.created', entityType: 'client_invite', entityId: row.id,
      after: { email, role, expires_at: row.expires_at.toISOString(), replaced: replaced.map((r) => r.id), confirmed_by: admin.confirmedBy },
    });
    return { inviteId: row.id, expiresAt: row.expires_at.toISOString() };
  });
}

/** `client_invite.revoke` — an administrator withdraws a waiting invitation. */
export function revokeTeamInvite(actor: ClientActor) {
  return teamAdminCommand(actor, false, async (ctx, p: { inviteId: string }, admin) => {
    const invite = await ctx.tx
      .selectFrom('client_invite')
      .select(['id', 'status', 'email'])
      .where('id', '=', requireUuid(p.inviteId, 'inviteId'))
      .where('client_id', '=', admin.clientId)
      .forUpdate()
      .executeTakeFirst();
    if (!invite) throw new DomainError('NOT_FOUND', 'invitation not found');
    if (invite.status !== 'PENDING') throw new DomainError('INVITE_UNAVAILABLE', invite.status === 'ACCEPTED' ? 'this invitation was already accepted' : 'this invitation was already withdrawn');
    await ctx.tx
      .updateTable('client_invite')
      .set({ status: 'REVOKED', revoked_by: actorLabel(ctx), revoked_at: sql<Date>`inrp2p_now()`, revoke_reason: 'withdrawn by an administrator' })
      .where('id', '=', invite.id)
      .execute();
    await appendAudit(ctx, { action: 'client_invite.revoked', entityType: 'client_invite', entityId: invite.id, before: { status: 'PENDING' }, after: { status: 'REVOKED', email: invite.email } });
    return { revoked: true as const };
  });
}

/**
 * `client_invite.accept` — the person an invitation names, signed in with its email, joins the team with its role.
 *
 * One person, one account (`client_user.user_id` is unique): an email that already has its own INRP2P account cannot
 * join another — the person is told to ask for an invitation to a different email. Someone removed from this same team
 * comes back on their old sign-in. Locks: the client, then the invitation (the team commands' order).
 */
export function acceptTeamInvite(actor: ClientActor): DomainCommand<{ inviteId: string }, { clientId: string; role: TeamRole }> {
  let email: string | undefined;
  return {
    authorize: async (ctx) => {
      if (ctx.actor.surface !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
      const user = await ctx.tx.selectFrom('auth_user').select(['kind', 'status', 'email', 'email_verified']).where('id', '=', requireUuid(actor.userId, 'userId')).executeTakeFirst();
      if (!user || user.kind !== 'CLIENT' || user.status !== 'ACTIVE' || !user.email_verified) throw new DomainError('FORBIDDEN', 'this account cannot join a team');
      email = user.email.toLowerCase();
    },
    handle: async (ctx, p) => {
      if (!email) throw new Error('team invitation accepted without authorization');
      const id = requireUuid(p.inviteId, 'inviteId');
      const seen = await ctx.tx.selectFrom('client_invite').select('client_id').where('id', '=', id).where('email', '=', email).executeTakeFirst();
      // Someone else's invitation is not found, exactly like one that does not exist.
      if (!seen) throw new DomainError('NOT_FOUND', 'there is no invitation for this email');
      const client = await ctx.tx.selectFrom('client').select(['id', 'status']).where('id', '=', seen.client_id).forUpdate().executeTakeFirstOrThrow();
      const invite = await ctx.tx
        .selectFrom('client_invite')
        .select(['id', 'role', 'status', sql<boolean>`expires_at <= inrp2p_now()`.as('expired')])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (invite.status === 'ACCEPTED') throw new DomainError('INVITE_UNAVAILABLE', 'this invitation was already accepted');
      if (invite.status === 'REVOKED') throw new DomainError('INVITE_UNAVAILABLE', 'this invitation was withdrawn');
      if (invite.expired) throw new DomainError('INVITE_UNAVAILABLE', 'this invitation has expired: ask for a new one');
      if (client.status !== 'ACTIVE') throw new DomainError('CLIENT_NOT_ACTIVE', 'this account is not active');

      // The same lock as opening an account: a person joins or opens one account, never two at once.
      await sql`select pg_advisory_xact_lock(hashtext(${`client.open_account:${actor.userId}`}))`.execute(ctx.tx);
      const existing = await ctx.tx.selectFrom('client_user').select(['id', 'client_id', 'status', 'role', 'can_accept_quotes']).where('user_id', '=', actor.userId).forUpdate().executeTakeFirst();
      const grant = AUTHORITY[invite.role];
      let clientUserId: string;
      if (!existing) {
        const row = await ctx.tx
          .insertInto('client_user')
          .values({ client_id: client.id, user_id: actor.userId, role: grant.role, can_accept_quotes: grant.canAcceptQuotes, created_by: actorLabel(ctx) })
          .returning('id')
          .executeTakeFirstOrThrow();
        clientUserId = row.id;
      } else if (existing.client_id !== client.id) {
        throw new DomainError('ACCOUNT_EXISTS', 'this email already has its own INRP2P account, so it cannot join another: ask for an invitation to a different email');
      } else if (existing.status === 'ACTIVE') {
        throw new DomainError('ALREADY_MEMBER', 'you are already on this team');
      } else {
        await ctx.tx.updateTable('client_user').set({ status: 'ACTIVE', role: grant.role, can_accept_quotes: grant.canAcceptQuotes, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', existing.id).execute();
        clientUserId = existing.id;
      }
      await ctx.tx.updateTable('client_invite').set({ status: 'ACCEPTED', accepted_client_user_id: clientUserId, accepted_at: sql<Date>`inrp2p_now()` }).where('id', '=', invite.id).execute();
      await appendAudit(ctx, {
        action: 'client_invite.accepted', entityType: 'client_invite', entityId: invite.id,
        before: existing ? { client_user_id: existing.id, status: existing.status, role: existing.role, can_accept_quotes: existing.can_accept_quotes } : null,
        after: { client_user_id: clientUserId, role: grant.role, can_accept_quotes: grant.canAcceptQuotes, rejoined: existing !== undefined },
      });
      await enqueueOutbox(ctx, { type: 'client.team_changed', aggregateType: 'client', aggregateId: client.id, payload: { clientId: client.id, change: 'JOINED', role: invite.role, clientUserId } });
      return { clientId: client.id, role: invite.role };
    },
  };
}

/**
 * `client_user.set_team_role` — an administrator, with a fresh authenticator code, makes another member an administrator
 * or an operator. One who stops being an administrator loses the invitations they made.
 */
export function setTeamMemberRole(actor: ClientActor) {
  return teamAdminCommand(actor, true, async (ctx, p: { clientUserId: string; role: TeamRole }, admin) => {
    const role = requireOneOf(p.role, 'role', ['ADMIN', 'OPERATOR'] as const);
    const target = await teamMemberForUpdate(ctx, admin.clientId, p.clientUserId);
    if (target.id === admin.clientUserId) throw new DomainError('TEAM_SELF_CHANGE', 'another administrator changes your own role');
    if (target.status !== 'ACTIVE') throw new DomainError('INVALID_TRANSITION', 'this person is no longer on your team');
    const grant = AUTHORITY[role];
    if (target.role === grant.role && target.can_accept_quotes === grant.canAcceptQuotes) return { changed: false };
    await ctx.tx.updateTable('client_user').set({ role: grant.role, can_accept_quotes: grant.canAcceptQuotes, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', target.id).execute();
    const revoked = target.role === 'CLIENT_ADMIN' && grant.role !== 'CLIENT_ADMIN' ? await revokeInvitesBy(ctx, target.id, 'the person who invited is no longer an administrator') : [];
    await appendAudit(ctx, {
      action: 'client_user.role_changed', entityType: 'client_user', entityId: target.id,
      before: { role: target.role, can_accept_quotes: target.can_accept_quotes },
      after: { role: grant.role, can_accept_quotes: grant.canAcceptQuotes, invites_revoked: revoked, confirmed_by: admin.confirmedBy },
    });
    await enqueueOutbox(ctx, { type: 'client.team_changed', aggregateType: 'client', aggregateId: admin.clientId, payload: { clientId: admin.clientId, change: 'ROLE_CHANGED', role, clientUserId: target.id } });
    return { changed: true };
  });
}

/**
 * `client_user.remove` — an administrator, with a fresh authenticator code, takes a person off the team: they can no
 * longer act for the client, their sessions end at once and their waiting invitations are withdrawn. The sign-in stays
 * (`DISABLED`, as history and for the audit trail); invited again, the person comes back on it.
 */
export function removeTeamMember(actor: ClientActor) {
  return teamAdminCommand(actor, true, async (ctx, p: { clientUserId: string }, admin) => {
    const target = await teamMemberForUpdate(ctx, admin.clientId, p.clientUserId);
    if (target.id === admin.clientUserId) throw new DomainError('TEAM_SELF_CHANGE', 'another administrator removes you from the team');
    if (target.status !== 'ACTIVE') return { removed: false };
    await ctx.tx.updateTable('client_user').set({ status: 'DISABLED', can_accept_quotes: false, updated_at: sql<Date>`statement_timestamp()` }).where('id', '=', target.id).execute();
    const revoked = await revokeInvitesBy(ctx, target.id, 'the person who invited left the team');
    const sessions = await ctx.tx.deleteFrom('auth_session').where('user_id', '=', target.user_id).executeTakeFirst();
    await appendAudit(ctx, {
      action: 'client_user.removed', entityType: 'client_user', entityId: target.id,
      before: { status: 'ACTIVE', role: target.role, can_accept_quotes: target.can_accept_quotes },
      after: { status: 'DISABLED', can_accept_quotes: false, sessions_ended: sessions.numDeletedRows.toString(), invites_revoked: revoked, confirmed_by: admin.confirmedBy },
    });
    await enqueueOutbox(ctx, { type: 'client.team_changed', aggregateType: 'client', aggregateId: admin.clientId, payload: { clientId: admin.clientId, change: 'REMOVED', clientUserId: target.id } });
    return { removed: true };
  });
}

export interface TeamMemberRow {
  readonly clientUserId: string;
  readonly email: string;
  readonly role: TeamMemberRole;
  readonly status: 'ACTIVE' | 'DISABLED';
  /** Whether the person has set up an authenticator (an administrator needs one to change the team). */
  readonly authenticator: boolean;
  readonly since: string;
  readonly isYou: boolean;
}

export interface TeamInviteRow {
  readonly inviteId: string;
  readonly email: string;
  readonly role: TeamRole;
  readonly invitedAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly emailSent: boolean;
}

/** The team of a client as its members see it: who is on it — active first — and the invitations still waiting. */
export async function clientTeam(ex: Executor, clientId: string, viewerUserId?: string): Promise<{ members: TeamMemberRow[]; invites: TeamInviteRow[] }> {
  const id = requireUuid(clientId, 'clientId');
  const members = await ex
    .selectFrom('client_user as cu')
    .innerJoin('auth_user as u', 'u.id', 'cu.user_id')
    .select(['cu.id', 'cu.user_id', 'cu.role', 'cu.can_accept_quotes', 'cu.status', 'cu.created_at', 'u.email', 'u.two_factor_enabled'])
    .where('cu.client_id', '=', id)
    .orderBy(sql`cu.status = 'ACTIVE'`, 'desc')
    .orderBy('cu.created_at')
    .execute();
  const invites = await ex
    .selectFrom('client_invite')
    .select(['id', 'email', 'role', 'created_at', 'expires_at', 'email_sent_at', sql<boolean>`expires_at <= inrp2p_now()`.as('expired')])
    .where('client_id', '=', id)
    .where('status', '=', 'PENDING')
    .orderBy('created_at', 'desc')
    .execute();
  return {
    members: members.map((m) => ({
      clientUserId: m.id, email: m.email, role: teamRoleOf(m.role, m.can_accept_quotes), status: m.status,
      authenticator: m.two_factor_enabled === true, since: m.created_at.toISOString(), isYou: m.user_id === viewerUserId,
    })),
    invites: invites.map((i) => ({
      inviteId: i.id, email: i.email, role: i.role, invitedAt: i.created_at.toISOString(), expiresAt: i.expires_at.toISOString(), expired: i.expired, emailSent: i.email_sent_at !== null,
    })),
  };
}

export interface MyInviteRow {
  readonly inviteId: string;
  readonly clientName: string;
  readonly role: TeamRole;
  readonly invitedAt: string;
  readonly expiresAt: string;
}

/** The invitations waiting for a signed-in person: to their own verified email, not expired, of active clients. */
export async function invitesForUser(ex: Executor, userId: string): Promise<MyInviteRow[]> {
  const user = await ex.selectFrom('auth_user').select(['email', 'email_verified', 'kind', 'status']).where('id', '=', requireUuid(userId, 'userId')).executeTakeFirst();
  if (!user || user.kind !== 'CLIENT' || user.status !== 'ACTIVE' || !user.email_verified) return [];
  const rows = await ex
    .selectFrom('client_invite as i')
    .innerJoin('client as c', 'c.id', 'i.client_id')
    .select(['i.id', 'c.display_name', 'i.role', 'i.created_at', 'i.expires_at'])
    .where('i.email', '=', user.email.toLowerCase())
    .where('i.status', '=', 'PENDING')
    .where(sql<boolean>`i.expires_at > inrp2p_now()`)
    .where('c.status', '=', 'ACTIVE')
    .orderBy('i.created_at', 'desc')
    .execute();
  return rows.map((r) => ({ inviteId: r.id, clientName: r.display_name, role: r.role, invitedAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() }));
}
