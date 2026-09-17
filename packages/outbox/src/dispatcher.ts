import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';

export interface OutboxEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateType: string | null;
  readonly aggregateId: string | null;
  readonly payload: unknown;
  readonly correlationId: string;
}

export interface OutboxHandler {
  /** Stable handler name; delivery is recorded per (event, handler). */
  readonly name: string;
  readonly handles: (type: string) => boolean;
  readonly run: (event: OutboxEvent) => Promise<void>;
}

export interface DispatchReport {
  claimed: number;
  delivered: number;
  failed: number;
}

/**
 * Claims pending events with FOR UPDATE SKIP LOCKED and runs every matching handler once per
 * event. A handler whose (event, handler) delivery row exists is skipped, so re-dispatch after a
 * crash never repeats already-recorded deliveries. External effects remain at-least-once at the
 * handler boundary and must be idempotent by event id.
 */
export async function dispatchOutbox(db: Db, handlers: readonly OutboxHandler[], opts: { batchSize?: number; maxAttempts?: number } = {}): Promise<DispatchReport> {
  const batchSize = opts.batchSize ?? 50;
  const maxAttempts = opts.maxAttempts ?? 10;
  const report: DispatchReport = { claimed: 0, delivered: 0, failed: 0 };

  await db.transaction().execute(async (tx) => {
    const events = await tx
      .selectFrom('outbox_event')
      .select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id', 'attempts'])
      .where('dispatched_at', 'is', null)
      .where('failed_at', 'is', null)
      .orderBy('created_at')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()
      .execute();
    report.claimed = events.length;

    for (const e of events) {
      const event: OutboxEvent = { id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id };
      await sql`savepoint outbox_event`.execute(tx);
      try {
        const matching = handlers.filter((x) => x.handles(e.type));
        // An event nobody handles is a wiring bug: never mark it dispatched silently.
        if (matching.length === 0) throw new Error(`NO_HANDLER for event type ${e.type}`);
        for (const h of matching) {
          const done = await tx.selectFrom('outbox_delivery').select('handler').where('event_id', '=', e.id).where('handler', '=', h.name).executeTakeFirst();
          if (done) continue;
          await sql`savepoint outbox_handler`.execute(tx);
          await h.run(event);
          await tx.insertInto('outbox_delivery').values({ event_id: e.id, handler: h.name }).execute();
          await sql`release savepoint outbox_handler`.execute(tx);
        }
        await tx.updateTable('outbox_event').set({ dispatched_at: sql<Date>`statement_timestamp()`, attempts: e.attempts + 1 }).where('id', '=', e.id).execute();
        await sql`release savepoint outbox_event`.execute(tx);
        report.delivered++;
      } catch (err) {
        // Keep deliveries recorded by earlier handlers of this event; undo only the failing handler.
        await sql`rollback to savepoint outbox_handler`.execute(tx).catch(async () => {
          await sql`rollback to savepoint outbox_event`.execute(tx);
        });
        const attempts = e.attempts + 1;
        await tx
          .updateTable('outbox_event')
          .set({ attempts, last_error: String((err as Error).message ?? err).slice(0, 2000), ...(attempts >= maxAttempts ? { failed_at: sql<Date>`statement_timestamp()` } : {}) })
          .where('id', '=', e.id)
          .execute();
        report.failed++;
      }
    }
  });
  return report;
}
