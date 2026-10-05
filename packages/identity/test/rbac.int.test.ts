import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import {
  OPERATOR_ROLES, PERMISSIONS, PERMISSION_MATRIX, approveOwnerGrant, assertSecondApprover, assignOperatorRole, authorizeOperator, cancelOwnerGrant,
  rejectOwnerGrant, requestOwnerGrant, type OperatorActor, type OperatorRole,
} from '../src/index.ts';

let t: TestDatabase;
const actors = new Map<OperatorRole, { fresh: OperatorActor; stale: OperatorActor }>();

async function operatorWithRole(role: OperatorRole | null, stepUp: 'fresh' | 'stale' | 'none'): Promise<OperatorActor> {
  const user = await t.owner.insertInto('auth_user').values({ name: 'op', email: `${randomUUID()}@inrp2p.test`, email_verified: true, created_at: new Date(), updated_at: new Date(), two_factor_enabled: true, kind: 'OPERATOR' }).returning('id').executeTakeFirstOrThrow();
  if (role) await t.owner.insertInto('operator_user_role').values({ user_id: user.id, role_code: role, granted_by: null }).execute();
  const session = await t.owner.insertInto('auth_session').values({ expires_at: new Date(Date.now() + 3600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: user.id, surface: 'OPERATOR' }).returning('id').executeTakeFirstOrThrow();
  if (stepUp !== 'none') {
    await sql`insert into step_up_verification (user_id, session_id, method, verified_at)
              values (${user.id}, ${session.id}, 'TOTP', statement_timestamp() - ${stepUp === 'fresh' ? sql`interval '1 minute'` : sql`interval '11 minutes'`})`.execute(t.owner);
  }
  return { kind: 'OPERATOR', userId: user.id, sessionId: session.id, roles: role ? [role] : [], grants: [] };
}

beforeAll(async () => {
  t = await createTestDatabase('rbac');
  for (const role of OPERATOR_ROLES) actors.set(role, { fresh: await operatorWithRole(role, 'fresh'), stale: await operatorWithRole(role, 'stale') });
});
afterAll(async () => t.close());

describe('complete RBAC matrix enforced by authorizeOperator (every permission × role)', () => {
  const cells = PERMISSIONS.flatMap((p) => OPERATOR_ROLES.map((r) => [p, r, PERMISSION_MATRIX[p][r]] as const));
  expect(cells.length).toBe(PERMISSIONS.length * OPERATOR_ROLES.length);

  it.each(cells)('%s · %s → %s', async (permission, role, requirement) => {
    const { fresh, stale } = actors.get(role)!;
    switch (requirement) {
      case 'DENY':
        await expect(authorizeOperator(t.app, fresh, permission)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(authorizeOperator(t.app, stale, permission)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        break;
      case 'ALLOW':
        await expect(authorizeOperator(t.app, stale, permission)).resolves.toMatchObject({ requirement: 'ALLOW', requiresSecondApprover: false });
        break;
      case 'STEP_UP':
        await expect(authorizeOperator(t.app, stale, permission)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
        await expect(authorizeOperator(t.app, fresh, permission)).resolves.toMatchObject({ requirement: 'STEP_UP', requiresSecondApprover: false });
        break;
      case 'STEP_UP_SECOND_APPROVER': {
        await expect(authorizeOperator(t.app, stale, permission)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
        const d = await authorizeOperator(t.app, fresh, permission);
        expect(d.requiresSecondApprover).toBe(true);
        expect(() => assertSecondApprover(d, fresh.userId, fresh.userId)).toThrow(expect.objectContaining({ code: 'SECOND_APPROVER_REQUIRED' }));
        expect(() => assertSecondApprover(d, fresh.userId, randomUUID())).not.toThrow();
        break;
      }
    }
  });

  it('roles are re-read from the database, not trusted from the actor object', async () => {
    const readOnly = actors.get('READ_ONLY')!.fresh;
    const spoofed: OperatorActor = { ...readOnly, roles: ['OWNER'] };
    await expect(authorizeOperator(t.app, spoofed, 'users:manage')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an operator with no roles is denied everything', async () => {
    const none = await operatorWithRole(null, 'fresh');
    for (const p of PERMISSIONS) await expect(authorizeOperator(t.app, none, p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('grantable economics:view can be granted to READ_ONLY only', async () => {
    const ro = await operatorWithRole('READ_ONLY', 'none');
    const grantor = actors.get('OWNER')!.fresh.userId;
    await expect(authorizeOperator(t.app, ro, 'economics:view')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await t.owner.insertInto('operator_permission_grant').values({ user_id: ro.userId, permission_code: 'economics:view', granted_by: grantor }).execute();
    await expect(authorizeOperator(t.app, ro, 'economics:view')).resolves.toMatchObject({ requirement: 'ALLOW' });
    const so = await operatorWithRole('SETTLEMENT_OPERATOR', 'none');
    await t.owner.insertInto('operator_permission_grant').values({ user_id: so.userId, permission_code: 'economics:view', granted_by: grantor }).execute();
    await expect(authorizeOperator(t.app, so, 'economics:view')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('roles cannot be assigned to client users', async () => {
    const client = await t.owner.insertInto('auth_user').values({ name: 'c', email: `${randomUUID()}@client.test`, email_verified: true, created_at: new Date(), updated_at: new Date(), kind: 'CLIENT' }).returning('id').executeTakeFirstOrThrow();
    await expect(t.owner.insertInto('operator_user_role').values({ user_id: client.id, role_code: 'OWNER', granted_by: null }).execute()).rejects.toThrow(/operator users/);
  });
});

describe('role assignment command', () => {
  const run = <P, R>(command: { authorize: (ctx: never, p: P) => Promise<void>; handle: (ctx: never, p: P) => Promise<R> }, actor: OperatorActor, name: string, payload: P) =>
    executeCommand(t.app, command as never, { name, actor: { type: 'USER', id: actor.userId, surface: 'OPERATOR', sessionId: actor.sessionId }, payload, idempotencyKey: randomUUID(), financial: false })
      .then((o) => (o as { result: R }).result);
  const assign = (actor: OperatorActor, payload: Record<string, unknown>) => run(assignOperatorRole(actor), actor, 'identity.assign_role', payload as never);

  it('requires roles:assign with step-up, never grants to oneself, and refuses a named approver', async () => {
    const target = await operatorWithRole(null, 'none');
    await expect(assign(actors.get('DEALER')!.fresh, { targetUserId: target.userId, role: 'FINANCE' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assign(actors.get('OWNER')!.stale, { targetUserId: target.userId, role: 'FINANCE' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    const owner = actors.get('OWNER')!.fresh;
    await expect(assign(owner, { targetUserId: owner.userId, role: 'FINANCE' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(assign(owner, { targetUserId: target.userId, role: 'FINANCE' })).resolves.toEqual({ granted: true });
    // TD-20: a name in the payload is not an approval.
    await expect(assign(owner, { targetUserId: target.userId, role: 'OWNER', approverUserId: actors.get('OWNER')!.stale.userId })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('with two or more OWNERs, OWNER is requested by one and approved by another in their own session', async () => {
    // This database already has several active OWNERs (one per role fixture).
    const owner1 = await operatorWithRole('OWNER', 'fresh');
    const owner2 = await operatorWithRole('OWNER', 'fresh');
    const target = await operatorWithRole(null, 'none');
    await expect(assign(owner1, { targetUserId: target.userId, role: 'OWNER' })).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });

    const request = await run(requestOwnerGrant(owner1), owner1, 'identity.request_owner', { targetUserId: target.userId, reason: 'second signatory for the desk' });
    expect(request.ref).toMatch(/^RR-\d{4,}$/);
    // The requester cannot approve it, nor can the person it is for (were they an OWNER already).
    await expect(run(approveOwnerGrant(owner1), owner1, 'identity.approve_owner', { requestId: request.requestId })).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    // A non-OWNER cannot either, whatever they hold.
    await expect(run(approveOwnerGrant(actors.get('FINANCE')!.fresh), actors.get('FINANCE')!.fresh, 'identity.approve_owner', { requestId: request.requestId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A stale step-up is not an approval.
    const staleOwner = actors.get('OWNER')!.stale;
    await expect(run(approveOwnerGrant(staleOwner), staleOwner, 'identity.approve_owner', { requestId: request.requestId })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await t.app.selectFrom('operator_user_role').select('role_code').where('user_id', '=', target.userId).execute()).toEqual([]);

    await expect(run(approveOwnerGrant(owner2), owner2, 'identity.approve_owner', { requestId: request.requestId })).resolves.toMatchObject({ granted: true });
    const row = await t.app.selectFrom('operator_role_request').selectAll().where('id', '=', request.requestId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'APPROVED', requested_by: owner1.userId, decided_by: owner2.userId, decided_session_id: owner2.sessionId });
    const role = await t.app.selectFrom('operator_user_role').selectAll().where('user_id', '=', target.userId).executeTakeFirstOrThrow();
    expect(role).toMatchObject({ role_code: 'OWNER', granted_by: owner1.userId });
    const audits = await t.app.selectFrom('audit_event').select('action').where('entity_id', 'in', [target.userId, request.requestId]).execute();
    expect(audits.map((a) => a.action).sort()).toEqual(['user.owner_grant_requested', 'user.role_granted']);
    // It is used once.
    await expect(run(approveOwnerGrant(owner2), owner2, 'identity.approve_owner', { requestId: request.requestId })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('a request is declined by another OWNER or withdrawn by its maker; neither grants anything', async () => {
    const owner1 = await operatorWithRole('OWNER', 'fresh');
    const owner2 = await operatorWithRole('OWNER', 'fresh');
    const target = await operatorWithRole(null, 'none');
    const first = await run(requestOwnerGrant(owner1), owner1, 'identity.request_owner', { targetUserId: target.userId, reason: 'cover while the founder travels' });
    await expect(run(requestOwnerGrant(owner2), owner2, 'identity.request_owner', { targetUserId: target.userId, reason: 'a second request for the same' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(run(rejectOwnerGrant(owner1), owner1, 'identity.reject_owner', { requestId: first.requestId, note: 'changed my mind' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await run(rejectOwnerGrant(owner2), owner2, 'identity.reject_owner', { requestId: first.requestId, note: 'not agreed with the board' });
    const second = await run(requestOwnerGrant(owner1), owner1, 'identity.request_owner', { targetUserId: target.userId, reason: 'asking again after the board meeting' });
    await expect(run(cancelOwnerGrant(owner2), owner2, 'identity.cancel_owner_request', { requestId: second.requestId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await run(cancelOwnerGrant(owner1), owner1, 'identity.cancel_owner_request', { requestId: second.requestId });
    expect(await t.app.selectFrom('operator_user_role').select('role_code').where('user_id', '=', target.userId).execute()).toEqual([]);
  });

  it('the database refuses any other way to an OWNER row (IX091)', async () => {
    const owner1 = await operatorWithRole('OWNER', 'fresh');
    const target = await operatorWithRole(null, 'none');
    const code = (e: unknown) => (e as { code?: string }).code;
    // Two or more OWNERs: no grant without an approval made in the same transaction, whoever is named.
    await expect(t.app.insertInto('operator_user_role').values({ user_id: target.userId, role_code: 'OWNER', granted_by: owner1.userId }).execute())
      .rejects.toSatisfy((e) => code(e) === 'IX091');
    await expect(t.app.insertInto('operator_user_role').values({ user_id: target.userId, role_code: 'OWNER', granted_by: target.userId }).execute())
      .rejects.toSatisfy((e) => code(e) === 'IX091');
    // An OWNER is not removed by the application, so the count cannot be lowered to slip a grant through.
    await expect(t.app.deleteFrom('operator_user_role').where('user_id', '=', owner1.userId).where('role_code', '=', 'OWNER').execute())
      .rejects.toSatisfy((e) => code(e) === 'IX091');
  });
});

describe('the first OWNER and single-OWNER mode (IX091)', () => {
  it('the application never creates the first OWNER; the sole OWNER may grant it alone, to someone else, on the record', async () => {
    const fresh = await createTestDatabase('rbac_bootstrap');
    try {
      const op = async (role: OperatorRole | null) => {
        const user = await fresh.owner.insertInto('auth_user').values({ name: 'op', email: `${randomUUID()}@inrp2p.test`, email_verified: true, created_at: new Date(), updated_at: new Date(), two_factor_enabled: true, kind: 'OPERATOR' }).returning('id').executeTakeFirstOrThrow();
        if (role) await fresh.owner.insertInto('operator_user_role').values({ user_id: user.id, role_code: role, granted_by: null }).execute();
        const session = await fresh.owner.insertInto('auth_session').values({ expires_at: new Date(Date.now() + 3600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: user.id, surface: 'OPERATOR' }).returning('id').executeTakeFirstOrThrow();
        await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${user.id}, ${session.id}, 'TOTP', statement_timestamp())`.execute(fresh.owner);
        return { kind: 'OPERATOR' as const, userId: user.id, sessionId: session.id, roles: role ? [role] : [], grants: [] };
      };
      const someone = await op(null);
      const code = (e: unknown) => (e as { code?: string }).code;
      await expect(fresh.app.insertInto('operator_user_role').values({ user_id: someone.userId, role_code: 'OWNER', granted_by: someone.userId }).execute())
        .rejects.toSatisfy((e) => code(e) === 'IX091');
      const other = await op(null);
      await expect(fresh.app.insertInto('operator_user_role').values({ user_id: someone.userId, role_code: 'OWNER', granted_by: other.userId }).execute())
        .rejects.toSatisfy((e) => code(e) === 'IX091');

      // The bootstrap procedure (infrastructure credentials) made one OWNER; that OWNER alone may add the second.
      const sole = await op('OWNER');
      const grant = (actor: typeof sole, target: string) =>
        executeCommand(fresh.app, assignOperatorRole(actor), { name: 'identity.assign_role', actor: { type: 'USER', id: actor.userId, surface: 'OPERATOR', sessionId: actor.sessionId }, payload: { targetUserId: target, role: 'OWNER' as const }, idempotencyKey: randomUUID(), financial: false });
      await expect(grant(sole, sole.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(grant(sole, someone.userId)).resolves.toMatchObject({ result: { granted: true } });
      const audit = await fresh.app.selectFrom('audit_event').select('after').where('action', '=', 'user.role_granted').where('entity_id', '=', someone.userId).executeTakeFirstOrThrow();
      expect(audit.after).toMatchObject({ role: 'OWNER', mode: 'SINGLE_OWNER', granted_by: sole.userId });
      // Two OWNERs now: the third needs a request and another OWNER's approval.
      await expect(grant(sole, other.userId)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    } finally {
      await fresh.close();
    }
  });
});
