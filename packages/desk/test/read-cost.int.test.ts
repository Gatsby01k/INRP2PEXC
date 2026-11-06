import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countingDb } from '@inrp2p/db/testing';
import { obligationRemaining } from '@inrp2p/settlement';
import { FULL_ACCESS, deskQueue, deskStrip } from '../src/index.ts';
import { type World, createWorld, openTrade } from '../../settlement/test/world.ts';

/**
 * What the desk's busiest reads cost (performance budget), counted in statements — the round trips a page waits for.
 * The budget is a constant: it must not grow with the number of trades, obligations or rows on the page.
 */
let w: World;
let counted: ReturnType<typeof countingDb>;
beforeAll(async () => {
  w = await createWorld('desk_read_cost');
  counted = countingDb(w.t.appPool);
});
afterAll(async () => w.close());

const PROFITABLE = { baseUsdt: '1000', clientRate: '102.000000' } as const;

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

  it('the strip is three statements for a dealer, in two rounds — the IST day and the trades in flight, then what the day earned', async () => {
    await deskStrip(counted.db, FULL_ACCESS);
    counted.reset();
    const { result, peak } = await peakInFlight(() => deskStrip(counted.db, FULL_ACCESS));
    expect(result.realizedMarginTodayUsdt).toBeDefined();
    expect(counted.statements).toHaveLength(3);
    expect(peak).toBe(2);
  });
});
