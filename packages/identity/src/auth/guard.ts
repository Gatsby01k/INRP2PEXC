import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { type OperatorActor } from '../rbac/authorize.ts';
import { OPERATOR_ROLES, type OperatorRole, STEP_UP_MAX_AGE_SECONDS } from '../rbac/matrix.ts';
import { type ClientAuth, type OperatorAuth } from './config.ts';
import { ACTIVITY_WRITE_INTERVAL_SECONDS, SESSION_POLICY, type Surface } from './policy.ts';

interface SessionCheckRow {
  session_id: string;
  user_id: string;
  surface: Surface;
  kind: Surface;
  status: 'ACTIVE' | 'DISABLED';
  two_factor_enabled: boolean | null;
  expired: boolean;
  idle: boolean;
  mfa_verified: boolean;
  step_up_fresh: boolean;
  /** The recorded activity is older than `ACTIVITY_WRITE_INTERVAL_SECONDS` (or there is none yet). */
  touch_due: boolean;
  roles: string[];
  grants: string[];
}

/**
 * Everything the guard decides on, in one statement: the session and its user, whether it is expired or idle, whether
 * its TOTP was ever verified and is fresh enough for a step-up, and — on the desk — the operator's roles and grants.
 * One round trip per request, whatever the page; the clocks are the database's, as before.
 */
async function checkSession(appDb: Db, sessionId: string, surface: Surface): Promise<SessionCheckRow> {
  const idleSeconds = SESSION_POLICY[surface].idleSeconds;
  const operator = surface === 'OPERATOR';
  const r = await sql<SessionCheckRow>`
    select s.id as session_id, s.user_id, s.surface, u.kind, u.status, u.two_factor_enabled,
           s.expires_at <= statement_timestamp() as expired,
           coalesce(a.last_activity_at, s.created_at) <= statement_timestamp() - make_interval(secs => ${idleSeconds}) as idle,
           a.last_activity_at is null
             or a.last_activity_at <= statement_timestamp() - make_interval(secs => ${ACTIVITY_WRITE_INTERVAL_SECONDS}) as touch_due,
           exists (select 1 from step_up_verification v where v.session_id = s.id) as mfa_verified,
           exists (select 1 from step_up_verification v
                    where v.session_id = s.id and v.verified_at > statement_timestamp() - make_interval(secs => ${STEP_UP_MAX_AGE_SECONDS})) as step_up_fresh,
           case when ${operator} then array(select r.role_code::text from operator_user_role r where r.user_id = s.user_id order by r.role_code)
                else '{}'::text[] end as roles,
           case when ${operator} then array(select g.permission_code::text from operator_permission_grant g where g.user_id = s.user_id order by g.permission_code)
                else '{}'::text[] end as grants
    from auth_session s
    join auth_user u on u.id = s.user_id
    left join session_activity a on a.session_id = s.id
    where s.id = ${sessionId}`.execute(appDb);
  const row = r.rows[0];
  if (!row) throw new DomainError('UNAUTHENTICATED');
  return row;
}

async function touch(appDb: Db, sessionId: string): Promise<void> {
  await sql`
    insert into session_activity (session_id, last_activity_at) values (${sessionId}, statement_timestamp())
    on conflict (session_id) do update set last_activity_at = excluded.last_activity_at`.execute(appDb);
}

async function expire(appDb: Db, sessionId: string): Promise<void> {
  await appDb.deleteFrom('auth_session').where('id', '=', sessionId).execute();
}

/** The checks both surfaces share, in the order they always ran: surface, account, expiry, idleness. */
async function refuseUnlessLive(appDb: Db, row: SessionCheckRow, surface: Surface): Promise<void> {
  if (row.surface !== surface || row.kind !== surface) throw new DomainError('SESSION_SURFACE_MISMATCH');
  if (row.status !== 'ACTIVE' || row.expired) {
    await expire(appDb, row.session_id);
    throw new DomainError('UNAUTHENTICATED');
  }
  if (row.idle) {
    await expire(appDb, row.session_id);
    throw new DomainError('SESSION_IDLE_TIMEOUT');
  }
}

export interface OperatorSession {
  readonly actor: OperatorActor;
  /** This session's TOTP verification is inside the step-up window (SECURITY §2.1), read in the same statement. */
  readonly stepUpFresh: boolean;
  readonly name: string;
  readonly email: string;
}

/**
 * Gate for every operator route and command (SECURITY §2.1): valid desk session, operator user,
 * ACTIVE, TOTP enrolled, session established or confirmed by TOTP, not idle. Returns the actor
 * with roles re-read from the database, and what a page needs about the session besides.
 *
 * Better Auth reads the session (its signed cookie, then the session and its user in one statement); INRP2P's own
 * rules are one more statement. A request that passes writes its activity at most once a minute.
 */
export async function operatorSession(auth: OperatorAuth, appDb: Db, headers: Headers): Promise<OperatorSession> {
  const result = await auth.api.getSession({ headers });
  if (!result) throw new DomainError('UNAUTHENTICATED');
  const row = await checkSession(appDb, result.session.id, 'OPERATOR');
  await refuseUnlessLive(appDb, row, 'OPERATOR');
  if (!row.two_factor_enabled) throw new DomainError('MFA_ENROLLMENT_REQUIRED');
  if (!row.mfa_verified) throw new DomainError('MFA_VERIFICATION_REQUIRED');
  if (row.touch_due) await touch(appDb, row.session_id);
  const roles = row.roles.filter((c): c is OperatorRole => (OPERATOR_ROLES as readonly string[]).includes(c));
  return {
    actor: { kind: 'OPERATOR', userId: row.user_id, sessionId: row.session_id, roles, grants: row.grants },
    stepUpFresh: row.step_up_fresh,
    name: result.user.name,
    email: result.user.email,
  };
}

export async function requireOperatorSession(auth: OperatorAuth, appDb: Db, headers: Headers): Promise<OperatorActor> {
  return (await operatorSession(auth, appDb, headers)).actor;
}

export interface ClientActor {
  readonly kind: 'CLIENT';
  readonly userId: string;
  readonly sessionId: string;
}

export interface ClientSession {
  readonly actor: ClientActor;
  /** This session verified TOTP inside the step-up window (SECURITY §2.2), read in the same statement. */
  readonly stepUpFresh: boolean;
}

export async function clientSession(auth: ClientAuth, appDb: Db, headers: Headers): Promise<ClientSession> {
  const result = await auth.api.getSession({ headers });
  if (!result) throw new DomainError('UNAUTHENTICATED');
  const row = await checkSession(appDb, result.session.id, 'CLIENT');
  await refuseUnlessLive(appDb, row, 'CLIENT');
  if (row.touch_due) await touch(appDb, row.session_id);
  return { actor: { kind: 'CLIENT', userId: row.user_id, sessionId: row.session_id }, stepUpFresh: row.step_up_fresh };
}

export async function requireClientSession(auth: ClientAuth, appDb: Db, headers: Headers): Promise<ClientActor> {
  return (await clientSession(auth, appDb, headers)).actor;
}
