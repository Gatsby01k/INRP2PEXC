import { sql } from 'kysely';
import type { TxContext } from '@inrp2p/db';

export interface OutboxEventInput {
  readonly type: string;
  readonly aggregateType?: string;
  readonly aggregateId?: string;
  /** Must not contain secrets (OTP codes, tokens, full account numbers). */
  readonly payload: Record<string, unknown>;
}

/**
 * Inserts an outbox event in the command transaction and schedules a dispatch job in the same
 * transaction (graphile-worker enqueue is transactional), so a rollback leaves neither.
 */
export async function enqueueOutbox(ctx: TxContext, event: OutboxEventInput): Promise<string> {
  const row = await ctx.tx
    .insertInto('outbox_event')
    .values({
      type: event.type,
      aggregate_type: event.aggregateType ?? null,
      aggregate_id: event.aggregateId ?? null,
      payload: JSON.stringify(event.payload),
      correlation_id: ctx.correlationId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`select inrp2p_enqueue_outbox_dispatch()`.execute(ctx.tx);
  return row.id;
}
