import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { ActorRef, Db } from '@inrp2p/db';
import type { OperatorActor } from '../src/rbac/authorize.ts';
import type { OperatorRole } from '../src/rbac/matrix.ts';
import type { DomainCommand } from '../src/rbac/command.ts';
import { executeCommand } from '@inrp2p/commands';

export interface TestOperator {
  readonly actor: OperatorActor;
  readonly ref: ActorRef;
}

/**
 * Creates an operator user with roles and (optionally) a fresh or stale step-up verification, using the
 * owner connection (fixtures bypass commands; production provisioning goes through audited commands).
 */
export async function createTestOperator(owner: Db, roles: readonly OperatorRole[], stepUp: 'fresh' | 'stale' | 'none' = 'fresh'): Promise<TestOperator> {
  const user = await owner
    .insertInto('auth_user')
    .values({ name: 'Test Operator', email: `op-${randomUUID()}@inrp2p.test`, email_verified: true, created_at: new Date(), updated_at: new Date(), two_factor_enabled: true, kind: 'OPERATOR' })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (roles.length) await owner.insertInto('operator_user_role').values(roles.map((role_code) => ({ user_id: user.id, role_code, granted_by: null }))).execute();
  const session = await owner
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: user.id, surface: 'OPERATOR' })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (stepUp !== 'none') {
    const age = stepUp === 'fresh' ? sql`interval '1 minute'` : sql`interval '11 minutes'`;
    await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${user.id}, ${session.id}, 'TOTP', statement_timestamp() - ${age})`.execute(owner);
  }
  return {
    actor: { kind: 'OPERATOR', userId: user.id, sessionId: session.id, roles, grants: [] },
    ref: { type: 'USER', id: user.id, surface: 'OPERATOR', sessionId: session.id },
  };
}

export interface TestClientLogin {
  readonly userId: string;
  readonly sessionId: string;
  readonly ref: ActorRef;
}

/**
 * A CLIENT auth user with a client-surface session. `stepUp: 'fresh'` = TOTP enrolled and verified now; `'stale'` = enrolled,
 * last verified 11 minutes ago; `'enrolled'` = enrolled, never verified in this session; `'none'` (default) = no TOTP.
 */
export async function createTestClientLogin(owner: Db, opts: { emailVerified?: boolean; stepUp?: 'fresh' | 'stale' | 'enrolled' | 'none' } = {}): Promise<TestClientLogin> {
  const enrolled = opts.stepUp !== undefined && opts.stepUp !== 'none';
  const user = await owner
    .insertInto('auth_user')
    .values({ name: 'Client User', email: `client-${randomUUID()}@acmepay.test`, email_verified: opts.emailVerified ?? true, created_at: new Date(), updated_at: new Date(), two_factor_enabled: enrolled, kind: 'CLIENT' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const session = await owner
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: user.id, surface: 'CLIENT' })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (opts.stepUp === 'fresh' || opts.stepUp === 'stale') {
    const age = opts.stepUp === 'fresh' ? sql`interval '0 seconds'` : sql`interval '11 minutes'`;
    await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${user.id}, ${session.id}, 'TOTP', statement_timestamp() - ${age})`.execute(owner);
  }
  return { userId: user.id, sessionId: session.id, ref: { type: 'USER', id: user.id, surface: 'CLIENT', sessionId: session.id } };
}


/** Executes a domain command through the real pipeline as `ref`, with a fresh idempotency key unless given (`null` = none). */
export async function runAs<P, R>(db: Db, def: DomainCommand<P, R>, ref: ActorRef, name: string, payload: P, key: string | null = randomUUID()): Promise<R> {
  const out = await executeCommand(db, def, { name, actor: ref, payload, idempotencyKey: key, financial: key !== null });
  return out.result;
}
