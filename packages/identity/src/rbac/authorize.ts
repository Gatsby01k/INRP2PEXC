import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { type OperatorRole, type Permission, OPERATOR_ROLES, STEP_UP_MAX_AGE_SECONDS, effectiveRequirement } from './matrix.ts';

export interface OperatorActor {
  readonly kind: 'OPERATOR';
  readonly userId: string;
  readonly sessionId: string;
  readonly roles: readonly OperatorRole[];
  readonly grants: readonly string[];
}

export interface AuthorizationDecision {
  readonly permission: Permission;
  readonly requirement: 'ALLOW' | 'STEP_UP' | 'STEP_UP_SECOND_APPROVER';
  /** Callers of ⧗✱ permissions must enforce a distinct second approver. */
  readonly requiresSecondApprover: boolean;
}

export async function loadOperatorGrants(ex: Executor, userId: string): Promise<{ roles: OperatorRole[]; grants: string[] }> {
  const [roles, grants] = await Promise.all([
    ex.selectFrom('operator_user_role').select('role_code').where('user_id', '=', userId).execute(),
    ex.selectFrom('operator_permission_grant').select('permission_code').where('user_id', '=', userId).execute(),
  ]);
  return {
    roles: roles.map((r) => r.role_code).filter((c): c is OperatorRole => (OPERATOR_ROLES as readonly string[]).includes(c)),
    grants: grants.map((g) => g.permission_code),
  };
}

/** True when this session has a TOTP verification younger than the step-up window (DB time). */
export async function hasFreshStepUp(ex: Executor, sessionId: string, maxAgeSeconds = STEP_UP_MAX_AGE_SECONDS): Promise<boolean> {
  const r = await sql<{ fresh: boolean }>`
    select exists (
      select 1 from step_up_verification
      where session_id = ${sessionId}
        and verified_at > statement_timestamp() - make_interval(secs => ${maxAgeSeconds})
    ) as fresh`.execute(ex);
  return r.rows[0]!.fresh;
}

/**
 * Command-level authorization (SECURITY §3). Roles and grants are re-read from the database in
 * the command transaction, never trusted from the session or UI.
 */
export async function authorizeOperator(ex: Executor, actor: OperatorActor, permission: Permission): Promise<AuthorizationDecision> {
  const { roles, grants } = await loadOperatorGrants(ex, actor.userId);
  const req = effectiveRequirement(permission, roles, grants);
  if (req === 'DENY') throw new DomainError('FORBIDDEN', `missing permission ${permission}`, { permission });
  if (req !== 'ALLOW' && !(await hasFreshStepUp(ex, actor.sessionId))) {
    throw new DomainError('STEP_UP_REQUIRED', `${permission} requires TOTP verification within ${STEP_UP_MAX_AGE_SECONDS}s`, { permission });
  }
  return { permission, requirement: req, requiresSecondApprover: req === 'STEP_UP_SECOND_APPROVER' };
}

/** Enforces the ✱ rule for a decision: approver must differ from the requester. */
export function assertSecondApprover(decision: AuthorizationDecision, requesterUserId: string, approverUserId: string): void {
  if (decision.requiresSecondApprover && requesterUserId === approverUserId) {
    throw new DomainError('SECOND_APPROVER_REQUIRED', `${decision.permission} must be approved by a different user`);
  }
}
