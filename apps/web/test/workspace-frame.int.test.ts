import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { countingDb } from '@inrp2p/db/testing';
import { portalAccess } from '@inrp2p/portal';
import { type World, createWorld } from '../../../packages/settlement/test/world.ts';

vi.mock('server-only', () => ({}));
const { workspaceFrame } = await import('../src/server/workspace-frame.ts');

/**
 * The client workspace's frame — the masthead and the footer around every page — reads what it shows besides the person
 * on every navigation (performance budget, ADR 0021 §4): four statements, all in flight at once, so one round trip.
 * They used to be five, one after another.
 */
let w: World;
let counted: ReturnType<typeof countingDb>;
beforeAll(async () => {
  w = await createWorld('web_workspace_frame', { capacityInr: '500000000.00' });
  counted = countingDb(w.t.appPool);
});
afterAll(async () => w.close());

async function peakInFlight<T>(fn: () => Promise<T>): Promise<{ result: T; peak: number }> {
  const pool = w.t.appPool;
  let now = 0;
  let peak = 0;
  const up = () => {
    now += 1;
    peak = Math.max(peak, now);
  };
  const down = () => {
    now -= 1;
  };
  pool.on('acquire', up);
  pool.on('release', down);
  try {
    return { result: await fn(), peak };
  } finally {
    pool.off('acquire', up);
    pool.off('release', down);
  }
}

describe('the workspace frame', () => {
  it('reads a member’s frame in four statements, sent together', async () => {
    const member = await portalAccess(w.app, w.acceptor.userId);
    await workspaceFrame(counted.db, member); // warm the pool, so the measure is the frame's and not the connections'
    counted.reset();
    const { result, peak } = await peakInFlight(() => workspaceFrame(counted.db, member));
    expect(result).toEqual({ unread: expect.any(Number), held: false, trader: null, dealsWithDesks: false });
    expect(counted.statements).toHaveLength(4);
    expect(peak).toBe(4);
  });

  it('reads only the payment hold for someone with no client yet', async () => {
    counted.reset();
    const result = await workspaceFrame(counted.db, null);
    expect(result).toEqual({ unread: 0, held: false, trader: null, dealsWithDesks: false });
    expect(counted.statements).toHaveLength(1);
  });
});
