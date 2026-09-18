import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOnce } from 'graphile-worker';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { executeCommand } from '@inrp2p/commands';
import { enqueueOutbox } from '@inrp2p/outbox';
import { CRONTAB, buildTaskList } from '../src/tasks.ts';
import { chainMonitoringFromEnv, chainMonitoringReady, describeChainMonitoring } from '../src/config.ts';

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

  it('reference-data maintenance jobs run as inrp2p_worker and are idempotent', async () => {
    const taskList = buildTaskList(t.worker, []);
    const helpers = {} as Parameters<NonNullable<typeof taskList.capacity_day_rollover>>[1];
    for (let i = 0; i < 2; i++) {
      await taskList.capacity_day_rollover!({}, helpers);
      await taskList.deposit_address_cooldown_release!({}, helpers);
    }
    const runs = await t.app.selectFrom('idempotency_key').select('scope').where('scope', 'in', ['capacity.day_rollover', 'deposit_address.cooldown_release']).execute();
    expect(runs).toHaveLength(4);
  });

  it('the TRON jobs exist, are scheduled, and do nothing at all when monitoring is deliberately disabled', async () => {
    const monitoring = chainMonitoringFromEnv({});
    expect(monitoring.state).toBe('DISABLED');
    const taskList = buildTaskList(t.worker, [], { monitoring });
    const helpers = {} as Parameters<NonNullable<typeof taskList.tron_scan>>[1];
    for (const name of ['tron_scan', 'tron_confirm', 'tron_orphan_sweep'] as const) {
      expect(CRONTAB).toContain(name);
      await taskList[name]!({}, helpers);
    }
    // No cursor, no commands, nothing touched: a deployment with monitoring off simply does not scan.
    expect(await t.app.selectFrom('chain_cursor').select('id').execute()).toEqual([]);
    expect(await t.app.selectFrom('idempotency_key').select('scope').where('scope', 'like', 'chain.%').execute()).toEqual([]);
  });

  it('an enabled but unconfigured worker fails its chain jobs instead of quietly doing nothing', async () => {
    const monitoring = chainMonitoringFromEnv({ INRP2P_TRON_MONITORING: 'enabled' });
    expect(monitoring.state).toBe('UNCONFIGURED');
    expect(chainMonitoringReady(monitoring)).toBe(false);
    const taskList = buildTaskList(t.worker, [], { monitoring });
    const helpers = {} as Parameters<NonNullable<typeof taskList.tron_scan>>[1];
    for (const name of ['tron_scan', 'tron_confirm', 'tron_orphan_sweep'] as const) {
      await expect(taskList[name]!({}, helpers)).rejects.toMatchObject({ code: 'CHAIN_MONITORING_UNCONFIGURED' });
    }
    expect(await t.app.selectFrom('chain_cursor').select('id').execute()).toEqual([]);
  });

  it('reports the four chain-monitoring states from the environment', () => {
    const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const base = { INRP2P_TRON_PRIMARY_URL: 'https://api.trongrid.io', INRP2P_TRON_PRIMARY_GROUP: 'trongrid', INRP2P_USDT_CONTRACT: contract };

    // DISABLED: nothing set, or switched off on purpose even with settings present.
    expect(chainMonitoringFromEnv({}).state).toBe('DISABLED');
    expect(chainMonitoringFromEnv({ ...base, INRP2P_TRON_MONITORING: 'disabled' }).state).toBe('DISABLED');

    // Settings present but no flag means enabled — forgetting the flag never silences the scanner.
    const single = chainMonitoringFromEnv(base);
    expect(single.state).toBe('DEGRADED');
    expect(single.config!.chain.independenceGroups).toEqual(['trongrid']);
    expect(describeChainMonitoring(single)).toContain('DEGRADED');
    expect(chainMonitoringReady(single)).toBe(true);

    // READY: two independent groups.
    const ready = chainMonitoringFromEnv({
      ...base, INRP2P_TRON_SECONDARY_URL: 'https://node.example.test', INRP2P_TRON_SECONDARY_GROUP: 'self-hosted',
    });
    expect(ready.state).toBe('READY');
    expect(ready.config!.chain.providers).toEqual(['tron-primary', 'tron-secondary']);
    expect(ready.config!.chain.independenceGroups).toEqual(['trongrid', 'self-hosted']);

    // Two endpoints of the same operator are one source: DEGRADED, and the reason says so.
    const mirrored = chainMonitoringFromEnv({
      ...base, INRP2P_TRON_SECONDARY_URL: 'https://api.eu.trongrid.io', INRP2P_TRON_SECONDARY_GROUP: 'trongrid',
    });
    expect(mirrored.state).toBe('DEGRADED');
    expect(mirrored.reasons.join(' ')).toContain('count as one source');

    // UNCONFIGURED: enabled with something missing or invalid. Never an exception, always a stated reason.
    for (const env of [
      { INRP2P_TRON_MONITORING: 'enabled' },
      { INRP2P_TRON_PRIMARY_URL: 'https://api.trongrid.io', INRP2P_USDT_CONTRACT: contract },
      { ...base, INRP2P_USDT_CONTRACT: 'not-an-address' },
      { ...base, INRP2P_TRON_PRIMARY_URL: 'ftp://nope' },
      { ...base, INRP2P_TRON_SECONDARY_URL: 'https://node.example.test' },
    ]) {
      const m = chainMonitoringFromEnv(env);
      expect({ env: Object.keys(env).join(','), state: m.state }).toEqual({ env: Object.keys(env).join(','), state: 'UNCONFIGURED' });
      expect(m.reasons.length).toBeGreaterThan(0);
      expect(m.config).toBeUndefined();
    }
  });
});
