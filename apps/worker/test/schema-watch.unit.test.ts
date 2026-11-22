import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchSchema } from '../src/schema-watch.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('the worker’s schema watch', () => {
  it('stops the worker once, when the database is no longer at the schema it was built for', async () => {
    vi.useFakeTimers();
    const answers: (readonly string[])[] = [[], [], ['the database is at schema 54, this release was built for 53']];
    const stop = vi.fn(async () => {});
    const watch = watchSchema({ check: async () => answers.shift() ?? [], stop, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(await watch.stopped).toEqual(['the database is at schema 54, this release was built for 53']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a check that cannot reach the database changes nothing', async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    const failed = vi.fn();
    const watch = watchSchema({ check: async () => { throw new Error('Connection terminated unexpectedly'); }, stop, intervalMs: 1_000, onCheckFailed: failed });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stop).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(5);
    watch.close();
  });

  it('never runs two checks at once, and stops checking when closed', async () => {
    vi.useFakeTimers();
    let running = 0;
    let most = 0;
    const check = vi.fn(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 2_500));
      running -= 1;
      return [];
    });
    const watch = watchSchema({ check, stop: async () => {}, intervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(most).toBe(1);
    watch.close();
    const calls = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(check.mock.calls.length).toBe(calls);
  });
});
