import { sql } from 'kysely';
import { DomainError } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { authorizeOperator, type OperatorActor } from './authorize.ts';
import { OPERATOR_ROLES, type OperatorRole } from './matrix.ts';

export interface AssignRolePayload {
  readonly targetUserId: string;
  readonly role: OperatorRole;
  /** Required when granting OWNER while two or more OWNERs already exist (SECURITY §3 rules). */
  readonly approverUserId?: string | null;
}

/**
 * Command definition for granting an operator role. Authorization: `roles:assign` (⧗).
 * OWNER grants need a distinct, active OWNER approver once more than one OWNER exists.
 */
export function assignOperatorRole(actor: OperatorActor) {
  return {
    authorize: async (ctx: TxContext) => {
      await authorizeOperator(ctx.tx, actor, 'roles:assign');
    },
    handle: async (ctx: TxContext, p: AssignRolePayload) => {
      if (!(OPERATOR_ROLES as readonly string[]).includes(p.role)) throw new DomainError('INVALID_ARGUMENT', `unknown role ${p.role}`);
      await sql`select pg_advisory_xact_lock(hashtext('inrp2p.operator_roles'))`.execute(ctx.tx);
      if (p.role === 'OWNER') {
        const owners = await ctx.tx
          .selectFrom('operator_user_role as r')
          .innerJoin('auth_user as u', 'u.id', 'r.user_id')
          .select('r.user_id')
          .where('r.role_code', '=', 'OWNER')
          .where('u.status', '=', 'ACTIVE')
          .execute();
        if (owners.length >= 2) {
          const approver = p.approverUserId ?? null;
          if (!approver || approver === actor.userId || !owners.some((o) => o.user_id === approver)) {
            throw new DomainError('SECOND_APPROVER_REQUIRED', 'granting OWNER requires approval by another active OWNER');
          }
        }
      }
      const inserted = await ctx.tx
        .insertInto('operator_user_role')
        .values({ user_id: p.targetUserId, role_code: p.role, granted_by: actor.userId })
        .onConflict((oc) => oc.columns(['user_id', 'role_code']).doNothing())
        .returning('role_code')
        .executeTakeFirst();
      if (inserted) {
        await appendAudit(ctx, { action: 'user.role_granted', entityType: 'auth_user', entityId: p.targetUserId, after: { role: p.role, approver: p.approverUserId ?? null } });
      }
      return { granted: Boolean(inserted) };
    },
  };
}
