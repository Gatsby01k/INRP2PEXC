import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countingDb } from '@inrp2p/db/testing';
import { obligationRemaining } from '@inrp2p/settlement';
import { FULL_ACCESS, deskQueue, deskStrip, routePositions } from '../src/index.ts';
import { type World, createWorld, openTrade } from '../../settlement/test/world.ts';

/**
 * What the desk's busiest reads cost (performance budget), counted in statements — the round trips a page waits for.
 * The budget is a constant: it must not grow with the number of trades, obligations or rows on the page.
 */
let w: World;
let counted: ReturnType<typeof countingDb>;
beforeAll(async () => {
  w = await createWorld('desk_read_cost', { capacityInr: '500000000.00' });
  counted = countingDb(w.t.appPool);
});
afterAll(async () => w.close());

const PROFITABLE = { baseUsdt: '1000', clientRate: '102.000000', routeRate: '104.200000', executionMode: 'TO_EXCHANGE' } as const;

describe('route positions (Rates)', () => {
  it('read in three statements however many obligations are open — never three per obligation', async () => {
    await openTrade(w, PROFITABLE);
    counted.reset();
    const one = await routePositions(counted.db, { status: 'OPEN' });
    const forOne = counted.statements.length;

    for (let i = 0; i < 6; i++) await openTrade(w, { ...PROFITABLE, baseUsdt: String(1000 + 10 * i) });
    counted.reset();
    const many = await routePositions(counted.db, { status: 'OPEN' });

    expect(many.length).toBeGreaterThanOrEqual(one.length + 6);
    expect(forOne).toBe(3);
    expect(counted.statements).toHaveLength(3);
  });

  it('shows what each side still owes exactly as the commands measure it (one formula, FI-64)', async () => {
    const positions = await routePositions(w.app, { status: 'ALL' });
    expect(positions.length).toBeGreaterThan(0);
    for (const p of positions) {
      const remaining = await obligationRemaining(w.app, p.obligationId);
      expect(p.routeDeliversRemaining).toEqual(remaining.routeDelivers.toJSON());
      expect(p.exchangeDeliversRemaining).toEqual(remaining.exchangeDelivers.toJSON());
    }
  });
});

/**
 * The most statements one read had in flight at once, measured on the pool: a read that waits for one answer before it
 * asks the next question shows a peak of 1, whatever its code looks like.
 */
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

describe('the desk queue and its strip', () => {
  it('the queue is three statements, sent together', async () => {
    await deskQueue(counted.db, FULL_ACCESS); // warm the pool, so the measure is the read's and not the connections'
    counted.reset();
    const { peak } = await peakInFlight(() => deskQueue(counted.db, FULL_ACCESS));
    expect(counted.statements).toHaveLength(3);
    expect(peak).toBe(3);
  });

  it('the strip is six statements for a dealer, in two rounds — the IST day and what does not depend on it, then the rest', async () => {
    await deskStrip(counted.db, FULL_ACCESS);
    counted.reset();
    const { result, peak } = await peakInFlight(() => deskStrip(counted.db, FULL_ACCESS));
    expect(result.routes).toBeDefined();
    expect(counted.statements).toHaveLength(6);
    expect(peak).toBe(4);
  });
});
