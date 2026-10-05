import { sql } from 'kysely';
import { DomainError, requireText, requireUuid } from '@inrp2p/kernel';
import type { TxContext } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { activeOwners, lockOperatorRoles, requireGrantee } from './assign-role.ts';
import { type OperatorActor } from './authorize.ts';
import { operatorCommand } from './command.ts';

/** How long a request to grant OWNER waits for a second OWNER before it lapses. */
export const OWNER_REQUEST_TTL_HOURS = 24;

async function requireOwner(ctx: TxContext, userId: string, who: string): Promise<void> {
  const row = await ctx.tx
    .selectFrom('operator_user_role as r')
    .innerJoin('auth_user as u', 'u.id', 'r.user_id')
    .select('r.user_id')
    .where('r.user_id', '=', userId)
    .where('r.role_code', '=', 'OWNER')
    .where('u.status', '=', 'ACTIVE')
    .executeTakeFirst();
  if (!row) throw new DomainError('FORBIDDEN', `${who} must be an active OWNER`);
}

async function lockRequest(ctx: TxContext, requestId: string) {
  const r = await ctx.tx.selectFrom('operator_role_request').selectAll().where('id', '=', requireUuid(requestId, 'requestId')).forUpdate().executeTakeFirst();
  if (!r) throw new DomainError('NOT_FOUND', 'request not found');
  if (r.status !== 'PENDING') throw new DomainError('INVALID_TRANSITION', `request ${r.ref} is ${r.status.toLowerCase()}`);
  return r;
}

/**
 * `identity.request_owner` — `roles:assign` (OWNER, ⧗). The first half of granting OWNER while two or more OWNERs are
 * active (SECURITY §3, TD-20): it grants nothing. It waits for another OWNER to approve it in their own session.
 */
export function requestOwnerGrant(actor: OperatorActor) {
  return operatorCommand(actor, 'roles:assign', async (ctx, p: { targetUserId: string; reason: string }) => {
    await requireOwner(ctx, actor.userId, 'the requester');
    const target = await requireGrantee(ctx, actor, p.targetUserId);
    const reason = requireText(p.reason, 'reason', 500);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why this person needs OWNER (at least 10 characters)');
    await lockOperatorRoles(ctx);
    const already = await ctx.tx.selectFrom('operator_user_role').select('user_id').where('user_id', '=', target).where('role_code', '=', 'OWNER').executeTakeFirst();
    if (already) throw new DomainError('INVALID_TRANSITION', 'this person is already an OWNER');
    // A request nobody acted on in time lapses here, so the next one can be made.
    await ctx.tx
      .updateTable('operator_role_request')
      .set({ status: 'EXPIRED', decided_at: sql<Date>`statement_timestamp()` })
      .where('target_user_id', '=', target)
      .where('status', '=', 'PENDING')
      .where('expires_at', '<=', sql<Date>`statement_timestamp()`)
      .execute();
    const pending = await ctx.tx.selectFrom('operator_role_request').select('ref').where('target_user_id', '=', target).where('status', '=', 'PENDING').executeTakeFirst();
    if (pending) throw new DomainError('INVALID_TRANSITION', `request ${pending.ref} for this person is already waiting for approval`);
    const row = await ctx.tx
      .insertInto('operator_role_request')
      .values({
        target_user_id: target, role_code: 'OWNER', reason, requested_by: actor.userId, requested_session_id: actor.sessionId,
        expires_at: sql<Date>`statement_timestamp() + make_interval(hours => ${OWNER_REQUEST_TTL_HOURS})`,
      })
      .returning(['id', 'ref', 'expires_at'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'user.owner_grant_requested', entityType: 'operator_role_request', entityId: row.id, after: { ref: row.ref, target_user_id: target, reason } });
    return { requestId: row.id, ref: row.ref, expiresAt: row.expires_at.toISOString() };
  });
}

/**
 * `identity.approve_owner` — `roles:assign` (OWNER, ⧗), by another active OWNER than the requester (and than the
 * person it is for), in their own session: the approver is the session's operator, never a name in a payload. The
 * grant is made in the same transaction, as the requester asked — the database accepts it only there (IX091).
 */
export function approveOwnerGrant(actor: OperatorActor) {
  return operatorCommand(actor, 'roles:assign', async (ctx, p: { requestId: string; note?: string | null }) => {
    await requireOwner(ctx, actor.userId, 'the approver');
    await lockOperatorRoles(ctx);
    const request = await lockRequest(ctx, p.requestId);
    if (request.requested_by === actor.userId) throw new DomainError('SECOND_APPROVER_REQUIRED', 'another OWNER approves this request, not the one who made it');
    if (request.target_user_id === actor.userId) throw new DomainError('FORBIDDEN', 'nobody approves their own grant');
    const expired = await sql<{ expired: boolean }>`select ${request.expires_at}::timestamptz <= statement_timestamp() as expired`.execute(ctx.tx);
    if (expired.rows[0]!.expired) throw new DomainError('INVALID_TRANSITION', `request ${request.ref} lapsed; make a new one`);
    await requireOwner(ctx, request.requested_by, 'the requester');
    await requireGrantee(ctx, { ...actor, userId: request.requested_by }, request.target_user_id);
    if ((await activeOwners(ctx, request.target_user_id)).length < 2) {
      // With one OWNER left the second approval cannot exist; the single-OWNER rule applies instead (assign_role).
      throw new DomainError('INVALID_TRANSITION', 'fewer than two OWNERs are active; this request no longer applies');
    }
    const note = p.note ? requireText(p.note, 'note', 500) : null;
    await ctx.tx
      .updateTable('operator_role_request')
      .set({
        status: 'APPROVED', decided_by: actor.userId, decided_session_id: actor.sessionId, decided_at: sql<Date>`statement_timestamp()`,
        decision_note: note, approved_xact: sql<string>`pg_current_xact_id()`,
      })
      .where('id', '=', request.id)
      .execute();
    await ctx.tx.insertInto('operator_user_role').values({ user_id: request.target_user_id, role_code: 'OWNER', granted_by: request.requested_by }).execute();
    await appendAudit(ctx, {
      action: 'user.role_granted', entityType: 'auth_user', entityId: request.target_user_id,
      after: { role: 'OWNER', request_ref: request.ref, requested_by: request.requested_by, approved_by: actor.userId },
    });
    return { ref: request.ref, granted: true as const };
  });
}

/** `identity.reject_owner` — another active OWNER declines the request (`roles:assign`, ⧗). Nothing is granted. */
export function rejectOwnerGrant(actor: OperatorActor) {
  return operatorCommand(actor, 'roles:assign', async (ctx, p: { requestId: string; note: string }) => {
    await requireOwner(ctx, actor.userId, 'the person declining');
    const request = await lockRequest(ctx, p.requestId);
    if (request.requested_by === actor.userId) throw new DomainError('INVALID_ARGUMENT', 'the requester withdraws a request; another OWNER declines it');
    if (request.target_user_id === actor.userId) throw new DomainError('FORBIDDEN', 'nobody decides their own grant');
    const note = requireText(p.note, 'note', 500);
    await ctx.tx
      .updateTable('operator_role_request')
      .set({ status: 'REJECTED', decided_by: actor.userId, decided_session_id: actor.sessionId, decided_at: sql<Date>`statement_timestamp()`, decision_note: note })
      .where('id', '=', request.id)
      .execute();
    await appendAudit(ctx, { action: 'user.owner_grant_rejected', entityType: 'operator_role_request', entityId: request.id, after: { ref: request.ref, note } });
    return { ref: request.ref, status: 'REJECTED' as const };
  });
}

/** `identity.cancel_owner_request` — the requester withdraws it (`roles:assign`, ⧗). */
export function cancelOwnerGrant(actor: OperatorActor) {
  return operatorCommand(actor, 'roles:assign', async (ctx, p: { requestId: string }) => {
    const request = await lockRequest(ctx, p.requestId);
    if (request.requested_by !== actor.userId) throw new DomainError('FORBIDDEN', 'only the requester withdraws a request');
    await ctx.tx
      .updateTable('operator_role_request')
      .set({ status: 'CANCELLED', decided_by: actor.userId, decided_session_id: actor.sessionId, decided_at: sql<Date>`statement_timestamp()` })
      .where('id', '=', request.id)
      .execute();
    await appendAudit(ctx, { action: 'user.owner_grant_cancelled', entityType: 'operator_role_request', entityId: request.id, after: { ref: request.ref } });
    return { ref: request.ref, status: 'CANCELLED' as const };
  });
}
