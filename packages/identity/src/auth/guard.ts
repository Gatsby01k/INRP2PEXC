import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { loadOperatorGrants, type OperatorActor } from '../rbac/authorize.ts';
import { SESSION_POLICY, type ClientAuth, type OperatorAuth, type Surface } from './config.ts';

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
}

async function checkSession(appDb: Db, sessionId: string, surface: Surface): Promise<SessionCheckRow> {
  const idleSeconds = SESSION_POLICY[surface].idleSeconds;
  const r = await sql<SessionCheckRow>`
    select s.id as session_id, s.user_id, s.surface, u.kind, u.status, u.two_factor_enabled,
           s.expires_at <= statement_timestamp() as expired,
           coalesce(a.last_activity_at, s.created_at) <= statement_timestamp() - make_interval(secs => ${idleSeconds}) as idle,
           exists (select 1 from step_up_verification v where v.session_id = s.id) as mfa_verified
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

/**
 * Gate for every operator route and command (SECURITY §2.1): valid desk session, operator user,
 * ACTIVE, TOTP enrolled, session established or confirmed by TOTP, not idle. Returns the actor
 * with roles re-read from the database.
 */
export async function requireOperatorSession(auth: OperatorAuth, appDb: Db, headers: Headers): Promise<OperatorActor> {
  const result = await auth.api.getSession({ headers });
  if (!result) throw new DomainError('UNAUTHENTICATED');
  const row = await checkSession(appDb, result.session.id, 'OPERATOR');
  if (row.surface !== 'OPERATOR' || row.kind !== 'OPERATOR') throw new DomainError('SESSION_SURFACE_MISMATCH');
  if (row.status !== 'ACTIVE' || row.expired) {
    await expire(appDb, row.session_id);
    throw new DomainError('UNAUTHENTICATED');
  }
  if (row.idle) {
    await expire(appDb, row.session_id);
    throw new DomainError('SESSION_IDLE_TIMEOUT');
  }
  if (!row.two_factor_enabled) throw new DomainError('MFA_ENROLLMENT_REQUIRED');
  if (!row.mfa_verified) throw new DomainError('MFA_VERIFICATION_REQUIRED');
  await touch(appDb, row.session_id);
  const { roles, grants } = await loadOperatorGrants(appDb, row.user_id);
  return { kind: 'OPERATOR', userId: row.user_id, sessionId: row.session_id, roles, grants };
}

export interface ClientActor {
  readonly kind: 'CLIENT';
  readonly userId: string;
  readonly sessionId: string;
}

export async function requireClientSession(auth: ClientAuth, appDb: Db, headers: Headers): Promise<ClientActor> {
  const result = await auth.api.getSession({ headers });
  if (!result) throw new DomainError('UNAUTHENTICATED');
  const row = await checkSession(appDb, result.session.id, 'CLIENT');
  if (row.surface !== 'CLIENT' || row.kind !== 'CLIENT') throw new DomainError('SESSION_SURFACE_MISMATCH');
  if (row.status !== 'ACTIVE' || row.expired) {
    await expire(appDb, row.session_id);
    throw new DomainError('UNAUTHENTICATED');
  }
  if (row.idle) {
    await expire(appDb, row.session_id);
    throw new DomainError('SESSION_IDLE_TIMEOUT');
  }
  await touch(appDb, row.session_id);
  return { kind: 'CLIENT', userId: row.user_id, sessionId: row.session_id };
}
