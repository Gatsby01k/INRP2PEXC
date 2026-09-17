import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { enqueueOutbox } from '@inrp2p/outbox';
import { buildTaskList } from '../src/tasks.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase('worker');
});
afterAll(async () => t.close());

describe('graphile worker end to end', () => {
  it('a committed command causes the worker (as inrp2p_worker) to deliver the outbox event exactly once', async () => {
    const delivered: string[] = [];
    const id = randomUUID();
    await executeCommand(t.app, {
      authorize: async () => {},
      handle: async (ctx) => {
        await enqueueOutbox(ctx, { type: 'test.worker', aggregateType: 'test', aggregateId: id, payload: {} });
      },
    }, { name: 'test.worker', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { id }, financial: false });

    const taskList = buildTaskList(t.worker, [{ name: 'rec', handles: (x) => x === 'test.worker', run: async (e) => { delivered.push(e.aggregateId!); } }]);
    await runOnce({ pgPool: t.workerPool, taskList });
    await runOnce({ pgPool: t.workerPool, taskList });
    expect(delivered).toEqual([id]);
  });
});
