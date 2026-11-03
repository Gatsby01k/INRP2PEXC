import { describe, expect, it } from 'vitest';
import { completionPpm } from '../src/index.ts';

describe('how reliably a trader completes', () => {
  it('is even odds with no record anywhere', () => {
    expect(completionPpm(undefined, { completed: 0, failed: 0 })).toBe(500_000n);
  });

  it('judges a new trader by the network until its own record speaks', () => {
    const network = { completed: 98, failed: 2 };
    expect(completionPpm(undefined, network)).toBe(970_588n);
    expect(completionPpm({ completed: 0, failed: 0 }, network)).toBe(970_588n);
  });

  it('rewards a long clean record and does not end it for one failure', () => {
    const network = { completed: 90, failed: 10 };
    const clean = completionPpm({ completed: 50, failed: 0 }, network);
    const oneMiss = completionPpm({ completed: 50, failed: 1 }, network);
    const shaky = completionPpm({ completed: 5, failed: 5 }, network);
    expect(clean).toBeGreaterThan(990_000n);
    expect(oneMiss).toBeGreaterThan(960_000n);
    expect(shaky).toBeLessThan(600_000n);
    expect(clean).toBeGreaterThan(oneMiss);
  });
});
