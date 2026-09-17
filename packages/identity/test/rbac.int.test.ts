import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import {
  OPERATOR_ROLES, PERMISSIONS, PERMISSION_MATRIX, assertSecondApprover, assignOperatorRole, authorizeOperator,
  type OperatorActor, type OperatorRole,
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
  it('requires roles:assign with step-up, audits the grant, and requires a second OWNER to approve new OWNERs', async () => {
    const owner1 = await operatorWithRole('OWNER', 'fresh');
    const owner2 = await operatorWithRole('OWNER', 'fresh');
    const target = await operatorWithRole(null, 'none');
    const run = (actor: OperatorActor, payload: Parameters<ReturnType<typeof assignOperatorRole>['handle']>[1]) =>
      executeCommand(t.app, assignOperatorRole(actor), { name: 'identity.assign_role', actor: { type: 'USER', id: actor.userId, surface: 'OPERATOR', sessionId: actor.sessionId }, payload, idempotencyKey: randomUUID(), financial: false });

    await expect(run(actors.get('DEALER')!.fresh, { targetUserId: target.userId, role: 'FINANCE' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(run(actors.get('OWNER')!.stale, { targetUserId: target.userId, role: 'FINANCE' })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(run(owner1, { targetUserId: target.userId, role: 'FINANCE' })).resolves.toMatchObject({ result: { granted: true } });
    await expect(run(owner1, { targetUserId: target.userId, role: 'OWNER' })).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(run(owner1, { targetUserId: target.userId, role: 'OWNER', approverUserId: owner1.userId })).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(run(owner1, { targetUserId: target.userId, role: 'OWNER', approverUserId: owner2.userId })).resolves.toMatchObject({ result: { granted: true } });
    const audits = await t.app.selectFrom('audit_event').select(['action', 'entity_id']).where('entity_id', '=', target.userId).execute();
    expect(audits.map((a) => a.action)).toEqual(['user.role_granted', 'user.role_granted']);
  });
});
