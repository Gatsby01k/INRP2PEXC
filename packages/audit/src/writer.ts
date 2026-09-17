import type { Executor, TxContext } from '@inrp2p/db';
import { redact } from './redact.ts';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Appends one audit event inside the caller's transaction (commits or rolls back with the state change). */
export async function appendAudit(ctx: TxContext, input: AuditInput): Promise<void> {
  await ctx.tx
    .insertInto('audit_event')
    .values({
      actor_type: ctx.actor.type,
      actor_id: ctx.actor.id,
      surface: ctx.actor.surface,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      before: input.before === undefined ? null : JSON.stringify(redact(input.before)),
      after: input.after === undefined ? null : JSON.stringify(redact(input.after)),
      correlation_id: ctx.correlationId,
      idempotency_key: ctx.idempotencyKey,
      session_id: ctx.actor.sessionId ?? null,
      ip_hash: null,
    })
    .execute();
}

/** Audit write outside a command (e.g. auth hooks), still append-only. */
export async function appendAuditDirect(ex: Executor, row: {
  actorType: 'USER' | 'SYSTEM' | 'CLIENT_LINK';
  actorId: string | null;
  surface: 'OPERATOR' | 'CLIENT' | 'PUBLIC' | 'SYSTEM';
  action: string;
  entityType: string;
  entityId?: string | null;
  after?: unknown;
  correlationId: string;
  sessionId?: string | null;
}): Promise<void> {
  await ex
    .insertInto('audit_event')
    .values({
      actor_type: row.actorType,
      actor_id: row.actorId,
      surface: row.surface,
      action: row.action,
      entity_type: row.entityType,
      entity_id: row.entityId ?? null,
      before: null,
      after: row.after === undefined ? null : JSON.stringify(redact(row.after)),
      correlation_id: row.correlationId,
      idempotency_key: null,
      session_id: row.sessionId ?? null,
      ip_hash: null,
    })
    .execute();
}
