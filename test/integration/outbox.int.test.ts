import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { dispatchOutbox, enqueueOutbox, type OutboxHandler } from '@inrp2p/outbox';
import { pgErrorCode } from '@inrp2p/db';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('outbox');
});
afterAll(async () => t.close());

const actor = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

async function emit(aggregateId: string, fail = false) {
  return executeCommand(t.app, {
    authorize: async () => {},
    handle: async (ctx) => {
      await enqueueOutbox(ctx, { type: 'test.happened', aggregateType: 'test', aggregateId, payload: { aggregateId } });
      if (fail) throw new Error('rollback');
    },
  }, { name: 'test.emit', actor, payload: { aggregateId }, financial: false });
}

describe('transactional outbox + worker queue', () => {
  it('enqueues the event and a dispatch job atomically; rollback leaves neither', async () => {
    const jobsBefore = (await sql<{ n: bigint }>`select count(*) as n from graphile_worker.jobs where task_identifier = 'outbox_dispatch'`.execute(t.owner)).rows[0]!.n;
    await expect(emit(randomUUID(), true)).rejects.toThrow('rollback');
    const id = randomUUID();
    await emit(id);
    expect(await t.app.selectFrom('outbox_event').select('id').where('aggregate_id', '=', id).execute()).toHaveLength(1);
    const jobs = (await sql<{ n: bigint }>`select count(*) as n from graphile_worker.jobs where task_identifier = 'outbox_dispatch'`.execute(t.owner)).rows[0]!.n;
    expect(jobs).toBe(jobsBefore === 0n ? 1n : jobsBefore); // coalesced by job_key
  });

  it('the app role can only enqueue through the dedicated function, not write the queue schema', async () => {
    await expect(sql`select * from graphile_worker.jobs`.execute(t.app)).rejects.toSatisfy((e) => ['42501', '42P01'].includes(pgErrorCode(e) ?? ''));
    await expect(sql`select graphile_worker.add_job('evil', '{}'::json)`.execute(t.app)).rejects.toSatisfy((e) => ['42501', '42883', '3F000'].includes(pgErrorCode(e) ?? ''));
  });

  it('dispatches each event to each handler exactly once, even when dispatched repeatedly', async () => {
    const id = randomUUID();
    await emit(id);
    const seen: string[] = [];
    const handler: OutboxHandler = { name: 'recorder', handles: (type) => type === 'test.happened', run: async (e) => { seen.push(e.aggregateId!); } };
    await dispatchOutbox(t.worker, [handler]);
    await dispatchOutbox(t.worker, [handler]);
    expect(seen.filter((x) => x === id)).toHaveLength(1);
    const ev = await t.app.selectFrom('outbox_event').selectAll().where('aggregate_id', '=', id).executeTakeFirstOrThrow();
    expect(ev.dispatched_at).not.toBeNull();
  });

  it('a failing handler is retried later and does not repeat handlers that already delivered', async () => {
    const id = randomUUID();
    await emit(id);
    const calls = { a: 0, b: 0 };
    let bFails = true;
    const handlers: OutboxHandler[] = [
      { name: 'a', handles: () => true, run: async () => { calls.a++; } },
      { name: 'b', handles: () => true, run: async () => { calls.b++; if (bFails) throw new Error('smtp down'); } },
    ];
    await dispatchOutbox(t.worker, handlers);
    let ev = await t.app.selectFrom('outbox_event').selectAll().where('aggregate_id', '=', id).executeTakeFirstOrThrow();
    expect(ev.dispatched_at).toBeNull();
    expect(ev.attempts).toBe(1);
    bFails = false;
    await dispatchOutbox(t.worker, handlers);
    ev = await t.app.selectFrom('outbox_event').selectAll().where('aggregate_id', '=', id).executeTakeFirstOrThrow();
    expect(ev.dispatched_at).not.toBeNull();
    expect(calls).toEqual({ a: 1, b: 2 });
  });

  it('an event without a registered handler is never marked dispatched', async () => {
    const id = randomUUID();
    await emit(id);
    await dispatchOutbox(t.worker, [{ name: 'other', handles: (type) => type === 'unrelated.type', run: async () => {} }]);
    const ev = await t.app.selectFrom('outbox_event').selectAll().where('aggregate_id', '=', id).executeTakeFirstOrThrow();
    expect(ev.dispatched_at).toBeNull();
    expect(ev.last_error).toMatch(/NO_HANDLER/);
    await dispatchOutbox(t.worker, [{ name: 'recorder2', handles: () => true, run: async () => {} }]);
  });

  it('event content is immutable', async () => {
    await expect(sql`update outbox_event set payload = '{}'::jsonb`.execute(t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX001');
  });
});
