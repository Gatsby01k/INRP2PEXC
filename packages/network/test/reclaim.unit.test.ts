import { describe, expect, it } from 'vitest';
import { splitReclaim } from '../src/reclaim.ts';

/** What a reclaim brought back, split over those who left it there (TD-31): never more than each left, nothing lost. */
describe('splitReclaim', () => {
  const trader = '01900000-0000-7000-8000-000000000001';
  it('gives each funder what it left when the reclaim covers it, and the rest to the platform', () => {
    expect(splitReclaim(1_500_000n, [{ funder: trader, amountSun: 1_000_000n }, { funder: null, amountSun: 300_000n }]))
      .toEqual([{ funder: trader, amountSun: 1_000_000n }, { funder: null, amountSun: 500_000n }]);
  });
  it('shares a short reclaim in proportion, rounding down, the remainder to the platform', () => {
    const out = splitReclaim(1_000_001n, [{ funder: trader, amountSun: 1_500_000n }, { funder: null, amountSun: 500_000n }]);
    expect(out).toEqual([{ funder: trader, amountSun: 750_000n }, { funder: null, amountSun: 250_001n }]);
    expect(out.reduce((t, s) => t + s.amountSun, 0n)).toBe(1_000_001n);
  });
  it('gives the platform what cannot be traced to anyone, and nothing out of nothing', () => {
    expect(splitReclaim(700_000n, [])).toEqual([{ funder: null, amountSun: 700_000n }]);
    expect(splitReclaim(0n, [{ funder: trader, amountSun: 10n }])).toEqual([]);
  });
});
