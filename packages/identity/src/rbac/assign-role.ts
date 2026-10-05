import { sql } from 'kysely';
import { DomainError, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { authorizeOperator, type OperatorActor } from './authorize.ts';
import { OPERATOR_ROLES, type OperatorRole } from './matrix.ts';

export interface AssignRolePayload {
  readonly targetUserId: string;
  readonly role: OperatorRole;
}

/** Active OWNERs other than `exceptUserId`, under the role-change lock the caller already holds. */
export async function activeOwners(ctx: TxContext, exceptUserId: string | null): Promise<string[]> {
  const rows = await ctx.tx
    .selectFrom('operator_user_role as r')
    .innerJoin('auth_user as u', 'u.id', 'r.user_id')
    .select('r.user_id')
    .where('r.role_code', '=', 'OWNER')
    .where('u.status', '=', 'ACTIVE')
    .execute();
  return rows.map((r) => r.user_id).filter((id) => id !== exceptUserId);
}

export async function lockOperatorRoles(ctx: TxContext): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('inrp2p.operator_roles'))`.execute(ctx.tx);
}

/** The person a role is granted to: an ACTIVE operator account, never the one granting it. */
export async function requireGrantee(ctx: TxContext, actor: OperatorActor, targetUserId: string): Promise<string> {
  const target = requireUuid(targetUserId, 'targetUserId');
  if (target === actor.userId) throw new DomainError('FORBIDDEN', 'nobody grants themselves a role');
  const user = await ctx.tx.selectFrom('auth_user').select(['kind', 'status']).where('id', '=', target).executeTakeFirst();
  if (!user || user.kind !== 'OPERATOR' || user.status !== 'ACTIVE') throw new DomainError('INVALID_ARGUMENT', 'roles are granted to active operator accounts only');
  return target;
}

/**
 * `identity.assign_role` — `roles:assign` (OWNER, ⧗). Grants an operator role to someone else; nobody grants
 * themselves anything. OWNER follows SECURITY §3 (production task C2, TD-20):
 *
 * - with exactly one active OWNER, that OWNER may grant it alone — the single-OWNER mode, recorded as such;
 * - with two or more, it is requested (`identity.request_owner`) and approved by another OWNER in their own session
 *   (`identity.approve_owner`); naming an approver in a request approves nothing and is refused;
 * - the first OWNER is never created here, but by the protected bootstrap procedure (`scripts/operator-admin.ts`).
 *
 * The database holds the same rules whatever code writes the row (IX091).
 */
export function assignOperatorRole(actor: OperatorActor) {
  return {
    authorize: async (ctx: TxContext) => {
      await authorizeOperator(ctx.tx, actor, 'roles:assign');
    },
    handle: async (ctx: TxContext, p: AssignRolePayload) => {
      if ((p as { approverUserId?: unknown }).approverUserId !== undefined) {
        throw new DomainError('INVALID_ARGUMENT', 'an approval comes from the approver’s own session, never from a request');
      }
      if (!(OPERATOR_ROLES as readonly string[]).includes(p.role)) throw new DomainError('INVALID_ARGUMENT', `unknown role ${p.role}`);
      const target = await requireGrantee(ctx, actor, p.targetUserId);
      await lockOperatorRoles(ctx);
      let mode: 'SINGLE_OWNER' | null = null;
      if (p.role === 'OWNER') {
        const owners = await activeOwners(ctx, target);
        if (owners.length >= 2) {
          throw new DomainError('SECOND_APPROVER_REQUIRED', 'granting OWNER needs another OWNER’s approval: request it, and another OWNER approves it in their own session');
        }
        mode = 'SINGLE_OWNER';
      }
      const inserted = await ctx.tx
        .insertInto('operator_user_role')
        .values({ user_id: target, role_code: p.role, granted_by: actor.userId })
        .onConflict((oc) => oc.columns(['user_id', 'role_code']).doNothing())
        .returning('role_code')
        .executeTakeFirst();
      if (inserted) {
        await appendAudit(ctx, { action: 'user.role_granted', entityType: 'auth_user', entityId: target, after: { role: p.role, granted_by: actor.userId, ...(mode ? { mode } : {}) } });
      }
      return { granted: Boolean(inserted) };
    },
  };
}
