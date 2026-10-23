import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { FakeNotificationAdapter } from '@inrp2p/adapters/testing';
import type { ClientActor } from '@inrp2p/identity';
import { createTestClientLogin, createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import {
  MAX_PENDING_INVITES, acceptTeamInvite, clientTeam, createClient, invitesForUser, inviteTeamMember, linkClientUser, openExchangeAccount,
  removeTeamMember, revokeTeamInvite, setCanAcceptQuotes, setTeamMemberRole,
} from '@inrp2p/clients';
import { acknowledgedSignalHandler, clientNotificationEmailHandler, clientNotificationHandler, teamInviteEmailHandler } from '@inrp2p/notifications';

/**
 * A client's team (ADR 0020 §2.11): an administrator invites by email, only that email signed in accepts, and every
 * change to who can bind the client needs the administrator's fresh authenticator code and is told to the whole team.
 */
let t: TestDatabase;
let owner: TestOperator;
let mailbox: FakeNotificationAdapter;

type Login = Awaited<ReturnType<typeof createTestClientLogin>>;
const actor = (l: Login): ClientActor => ({ kind: 'CLIENT', userId: l.userId, sessionId: l.sessionId });
const emailOf = async (l: Login) => (await t.app.selectFrom('auth_user').select('email').where('id', '=', l.userId).executeTakeFirstOrThrow()).email;
const dbCode = (p: Promise<unknown>) => p.then(() => null, (e) => pgErrorCode(e) ?? e);

const invite = (admin: Login, email: string, role: 'ADMIN' | 'OPERATOR' = 'OPERATOR') => runAs(t.app, inviteTeamMember(actor(admin)), admin.ref, 'client_invite.create', { email, role });
const accept = (person: Login, inviteId: string) => runAs(t.app, acceptTeamInvite(actor(person)), person.ref, 'client_invite.accept', { inviteId });
const setRole = (admin: Login, clientUserId: string, role: 'ADMIN' | 'OPERATOR') => runAs(t.app, setTeamMemberRole(actor(admin)), admin.ref, 'client_user.set_team_role', { clientUserId, role });
const remove = (admin: Login, clientUserId: string) => runAs(t.app, removeTeamMember(actor(admin)), admin.ref, 'client_user.remove', { clientUserId });
const memberOf = async (clientId: string, l: Login) => t.app.selectFrom('client_user').select(['id', 'role', 'can_accept_quotes', 'status']).where('client_id', '=', clientId).where('user_id', '=', l.userId).executeTakeFirst();

const deliver = () =>
  dispatchOutbox(t.worker, [
    teamInviteEmailHandler(t.app, mailbox, { linkBase: 'https://app.inrp2p.test' }),
    clientNotificationHandler(t.app),
    acknowledgedSignalHandler(),
    clientNotificationEmailHandler(t.app, mailbox, { linkBase: 'https://app.inrp2p.test' }),
  ]);

/** A client with an administrator holding a fresh authenticator code. */
async function team(name: string) {
  const c = await runAs(t.app, createClient(owner.actor), owner.ref, 'client.create', { legalName: `${name} Private Limited`, displayName: name, type: 'COMPANY' as const });
  const admin = await createTestClientLogin(t.owner, { stepUp: 'fresh' });
  const linked = await runAs(t.app, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: c.clientId, userId: admin.userId, role: 'CLIENT_ADMIN' as const });
  await runAs(t.app, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  return { clientId: c.clientId, admin, adminMemberId: linked.clientUserId };
}

beforeAll(async () => {
  t = await createTestDatabase('team');
  owner = await createTestOperator(t.owner, ['OWNER']);
  mailbox = new FakeNotificationAdapter();
});
afterAll(async () => t.close());

describe('client team', () => {
  it('an administrator invites by email; the invitation is emailed once, without a secret; that email signed in joins with the role', async () => {
    const x = await team('Rupee Desk');
    const person = await createTestClientLogin(t.owner);
    const email = await emailOf(person);
    const sent = await invite(x.admin, `  ${email.toUpperCase()} `);
    const row = await t.app.selectFrom('client_invite').selectAll().where('id', '=', sent.inviteId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ email, role: 'OPERATOR', status: 'PENDING', invited_by: x.adminMemberId });
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(7 * 24 * 3600 * 1000);

    await deliver();
    await deliver();
    const emails = mailbox.notifications.filter((m) => m.to === email);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ deliveryId: sent.inviteId, subject: 'Rupee Desk invited you to its team on INRP2P Exchange', link: 'https://app.inrp2p.test/open-account' });
    expect(emails[0]!.body).toContain('as an operator');
    expect(emails[0]!.body).not.toContain(sent.inviteId);
    expect((await t.app.selectFrom('client_invite').select(['email_sent_at', 'email_message_id']).where('id', '=', sent.inviteId).executeTakeFirstOrThrow()).email_message_id).toMatch(/^fake-notification-/);

    expect(await invitesForUser(t.app, person.userId)).toEqual([expect.objectContaining({ inviteId: sent.inviteId, clientName: 'Rupee Desk', role: 'OPERATOR' })]);
    expect(await accept(person, sent.inviteId)).toEqual({ clientId: x.clientId, role: 'OPERATOR' });
    expect(await memberOf(x.clientId, person)).toMatchObject({ role: 'CLIENT_TRADER', can_accept_quotes: true, status: 'ACTIVE' });
    expect(await invitesForUser(t.app, person.userId)).toEqual([]);
    const view = await clientTeam(t.app, x.clientId, x.admin.userId);
    expect(view.members.map((m) => [m.role, m.isYou])).toEqual([['ADMIN', true], ['OPERATOR', false]]);
    expect(view.invites).toEqual([]);

    // The whole team hears it, in the inbox and by email — never with the person's address.
    await deliver();
    const told = await t.app.selectFrom('client_notification').select(['kind', 'title', 'body', 'href']).where('client_id', '=', x.clientId).execute();
    expect(told).toEqual([expect.objectContaining({ kind: 'TEAM_CHANGED', title: 'Someone joined your team', href: '/account/team' })]);
    expect(told[0]!.body).toContain('as an operator');
    expect(told[0]!.body).not.toContain(email);
    expect(mailbox.notifications.filter((m) => m.subject === 'Someone joined your team').map((m) => m.to).sort()).toEqual([await emailOf(x.admin), email].sort());

    // The invitation is spent.
    await expect(accept(person, sent.inviteId)).rejects.toMatchObject({ code: 'INVITE_UNAVAILABLE' });
  });

  it('changing the team needs an administrator with a fresh authenticator code; withdrawing an invitation does not', async () => {
    const x = await team('Strict Desk');
    const stale = await createTestClientLogin(t.owner, { stepUp: 'stale' });
    const bare = await createTestClientLogin(t.owner);
    const operator = await createTestClientLogin(t.owner, { stepUp: 'fresh' });
    for (const [l, role] of [[stale, 'CLIENT_ADMIN'], [bare, 'CLIENT_ADMIN'], [operator, 'CLIENT_TRADER']] as const) {
      await runAs(t.app, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: x.clientId, userId: l.userId, role });
    }
    await expect(invite(stale, 'new@acmepay.test')).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(invite(bare, 'new@acmepay.test')).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
    await expect(invite(operator, 'new@acmepay.test')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(invite(x.admin, 'not-an-email')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(invite(x.admin, await emailOf(stale))).rejects.toMatchObject({ code: 'ALREADY_MEMBER' });

    const sent = await invite(x.admin, 'new@acmepay.test', 'ADMIN');
    await runAs(t.app, revokeTeamInvite(actor(stale)), stale.ref, 'client_invite.revoke', { inviteId: sent.inviteId });
    await expect(runAs(t.app, revokeTeamInvite(actor(stale)), stale.ref, 'client_invite.revoke', { inviteId: sent.inviteId })).rejects.toMatchObject({ code: 'INVITE_UNAVAILABLE' });
    // Another client's administrator does not see it.
    const y = await team('Other Desk');
    const mine = await invite(x.admin, 'mine@acmepay.test');
    await expect(runAs(t.app, revokeTeamInvite(actor(y.admin)), y.admin.ref, 'client_invite.revoke', { inviteId: mine.inviteId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('only the email it names accepts, before it expires and while it stands; inviting again replaces it; a person has one account', async () => {
    const x = await team('Careful Desk');
    const person = await createTestClientLogin(t.owner);
    const stranger = await createTestClientLogin(t.owner);
    const email = await emailOf(person);
    const first = await invite(x.admin, email);
    await expect(accept(stranger, first.inviteId)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const second = await invite(x.admin, email, 'ADMIN');
    expect((await t.app.selectFrom('client_invite').select(['status', 'revoke_reason']).where('id', '=', first.inviteId).executeTakeFirstOrThrow())).toEqual({ status: 'REVOKED', revoke_reason: 'replaced by a new invitation' });
    await expect(accept(person, first.inviteId)).rejects.toMatchObject({ code: 'INVITE_UNAVAILABLE' });

    // An unverified address cannot join.
    const unverified = await createTestClientLogin(t.owner, { emailVerified: false });
    const forUnverified = await invite(x.admin, await emailOf(unverified));
    await expect(accept(unverified, forUnverified.inviteId)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Expired.
    const late = await createTestClientLogin(t.owner);
    const expired = await t.owner
      .insertInto('client_invite')
      .values({ client_id: x.clientId, email: await emailOf(late), role: 'OPERATOR', invited_by: x.adminMemberId, created_at: sql<Date>`inrp2p_now() - interval '8 days'`, expires_at: sql<Date>`inrp2p_now() - interval '1 day'` })
      .returning('id')
      .executeTakeFirstOrThrow();
    expect(await invitesForUser(t.app, late.userId)).toEqual([]);
    await expect(accept(late, expired.id)).rejects.toMatchObject({ code: 'INVITE_UNAVAILABLE' });
    expect((await clientTeam(t.app, x.clientId)).invites.find((i) => i.inviteId === expired.id)).toMatchObject({ expired: true });

    // Someone with an account of their own keeps it and joins nothing; the invitation stays for another try.
    const ownAccount = await createTestClientLogin(t.owner);
    await runAs(t.app, openExchangeAccount(actor(ownAccount)), ownAccount.ref, 'client.open_account', { name: 'Own Self', entityType: 'INDIVIDUAL' as const });
    const forOwn = await invite(x.admin, await emailOf(ownAccount));
    await expect(accept(ownAccount, forOwn.inviteId)).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });

    await accept(person, second.inviteId);
    expect(await memberOf(x.clientId, person)).toMatchObject({ role: 'CLIENT_ADMIN', can_accept_quotes: true });
    // And having joined, they cannot open an account of their own.
    await expect(runAs(t.app, openExchangeAccount(actor(person)), person.ref, 'client.open_account', { name: 'Mine', entityType: 'INDIVIDUAL' as const })).rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
  });

  it(`holds at most ${MAX_PENDING_INVITES} invitations waiting`, async () => {
    const x = await team('Busy Desk');
    for (let i = 0; i < MAX_PENDING_INVITES; i += 1) await invite(x.admin, `p${i}@busy.test`);
    await expect(invite(x.admin, 'one-more@busy.test')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Inviting a waiting address again replaces it, so it still fits.
    await invite(x.admin, 'p0@busy.test', 'ADMIN');
  });

  it('roles change and people leave by another administrator; leaving ends their sessions and withdraws their invitations; they can come back', async () => {
    const x = await team('Moving Desk');
    const second = await createTestClientLogin(t.owner, { stepUp: 'fresh' });
    await accept(second, (await invite(x.admin, await emailOf(second), 'ADMIN')).inviteId);
    const secondId = (await memberOf(x.clientId, second))!.id;

    await expect(setRole(x.admin, x.adminMemberId, 'OPERATOR')).rejects.toMatchObject({ code: 'TEAM_SELF_CHANGE' });
    await expect(remove(x.admin, x.adminMemberId)).rejects.toMatchObject({ code: 'TEAM_SELF_CHANGE' });

    // An administrator made an operator loses the invitations they made.
    const theirs = await invite(second, 'their-pick@acmepay.test');
    expect(await setRole(x.admin, secondId, 'OPERATOR')).toEqual({ changed: true });
    expect(await setRole(x.admin, secondId, 'OPERATOR')).toEqual({ changed: false });
    expect((await t.app.selectFrom('client_invite').select('status').where('id', '=', theirs.inviteId).executeTakeFirstOrThrow()).status).toBe('REVOKED');
    expect(await memberOf(x.clientId, second)).toMatchObject({ role: 'CLIENT_TRADER', can_accept_quotes: true });
    await expect(invite(second, 'again@acmepay.test')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await remove(x.admin, secondId)).toEqual({ removed: true });
    expect(await memberOf(x.clientId, second)).toMatchObject({ status: 'DISABLED', can_accept_quotes: false });
    expect(await t.app.selectFrom('auth_session').select('id').where('user_id', '=', second.userId).execute()).toEqual([]);
    expect(await remove(x.admin, secondId)).toEqual({ removed: false });
    const audit = await t.app.selectFrom('audit_event').select(['action', 'after']).where('entity_id', '=', secondId).orderBy('seq').execute();
    expect(audit.map((a) => a.action)).toEqual(['client_user.role_changed', 'client_user.removed']);
    expect(audit[1]!.after).toMatchObject({ sessions_ended: '1', confirmed_by: 'TOTP' });

    // Invited again, they come back on the same sign-in, with the new invitation's role.
    const back = await createTestClientLogin(t.owner);
    await t.owner.updateTable('auth_session').set({ user_id: second.userId }).where('id', '=', back.sessionId).execute();
    const returning = { ...back, userId: second.userId, ref: { ...back.ref, id: second.userId } } as Login;
    await accept(returning, (await invite(x.admin, await emailOf(second), 'OPERATOR')).inviteId);
    expect(await memberOf(x.clientId, second)).toMatchObject({ id: secondId, status: 'ACTIVE', role: 'CLIENT_TRADER', can_accept_quotes: true });

    await deliver();
    const told = await t.app.selectFrom('client_notification').select('title').where('client_id', '=', x.clientId).where('kind', '=', 'TEAM_CHANGED').orderBy('created_at').execute();
    expect(told.map((n) => n.title)).toEqual(['Someone joined your team', 'A role on your team changed', 'Someone left your team', 'Someone joined your team']);
  });

  it('two administrators removing each other at once: one of them stays', async () => {
    const x = await team('Feud Desk');
    const second = await createTestClientLogin(t.owner, { stepUp: 'fresh' });
    await accept(second, (await invite(x.admin, await emailOf(second), 'ADMIN')).inviteId);
    const secondId = (await memberOf(x.clientId, second))!.id;
    const outcomes = await Promise.allSettled([remove(x.admin, secondId), remove(second, x.adminMemberId)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({ reason: { code: 'FORBIDDEN' } });
    const admins = await t.app.selectFrom('client_user').select('id').where('client_id', '=', x.clientId).where('role', '=', 'CLIENT_ADMIN').where('status', '=', 'ACTIVE').execute();
    expect(admins).toHaveLength(1);
  });

  it('the database: an invitation comes from an active administrator and is accepted only by the person it names (IX127); none is deleted', async () => {
    const x = await team('Guarded Desk');
    const operator = await createTestClientLogin(t.owner);
    const linked = await runAs(t.app, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: x.clientId, userId: operator.userId, role: 'CLIENT_TRADER' as const });
    const values = { client_id: x.clientId, email: 'someone@acmepay.test', role: 'OPERATOR' as const, expires_at: sql<Date>`inrp2p_now() + interval '1 day'` };
    expect(await dbCode(t.app.insertInto('client_invite').values({ ...values, invited_by: linked.clientUserId }).execute())).toBe('IX127');
    const y = await team('Elsewhere');
    expect(await dbCode(t.app.insertInto('client_invite').values({ ...values, invited_by: y.adminMemberId }).execute())).toBe('IX127');

    const sent = await invite(x.admin, 'someone@acmepay.test');
    // The operator is a user of this client, but not the person the invitation names.
    expect(await dbCode(t.app.updateTable('client_invite').set({ status: 'ACCEPTED', accepted_client_user_id: linked.clientUserId, accepted_at: sql<Date>`inrp2p_now()` }).where('id', '=', sent.inviteId).execute())).toBe('IX127');
    expect(await dbCode(t.app.updateTable('client_invite').set({ role: 'ADMIN' } as never).where('id', '=', sent.inviteId).execute())).toMatch(/permission denied|42501/);
    expect(await dbCode(sql`delete from client_invite where id = ${sent.inviteId}`.execute(t.app))).toMatch(/permission denied|42501/);
  });
});
