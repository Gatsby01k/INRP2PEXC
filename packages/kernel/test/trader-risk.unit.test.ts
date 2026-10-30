import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_POLICY, type RiskPolicy, backingFor, limitsOf, requireRiskPolicy, riskFit, tierOf } from '../src/trader-risk.ts';

const U = 1_000_000n;
const track = (completedDeals: number, daysApproved: number | null, strikes = 0) => ({ completedDeals, daysApproved, strikes });

describe('a trader’s level (ADR 0024)', () => {
  it('starts new, rises with completed deals and days together, and tops out', () => {
    expect(tierOf(DEFAULT_RISK_POLICY, track(0, null))).toEqual({ index: 0, name: 'NEW', heldBack: false, next: { name: 'PROVEN', deals: 10, days: 7 } });
    // Deals without the days, or days without the deals, are not enough.
    expect(tierOf(DEFAULT_RISK_POLICY, track(40, 3)).name).toBe('NEW');
    expect(tierOf(DEFAULT_RISK_POLICY, track(4, 90)).next).toEqual({ name: 'PROVEN', deals: 6, days: 0 });
    expect(tierOf(DEFAULT_RISK_POLICY, track(10, 7))).toMatchObject({ name: 'PROVEN', next: { name: 'TRUSTED', deals: 40, days: 23 } });
    expect(tierOf(DEFAULT_RISK_POLICY, track(500, 400))).toEqual({ index: 2, name: 'TRUSTED', heldBack: false, next: null });
  });

  it('falls back to the first level while a failed deal is recent, whatever its record', () => {
    expect(tierOf(DEFAULT_RISK_POLICY, track(500, 400, 1))).toEqual({ index: 0, name: 'NEW', heldBack: true, next: null });
  });
});

describe('the limits a free reserve allows', () => {
  const none = { totalMinor: 0n, largestMinor: 0n };

  it('are multiples of the free reserve at the level — never of a negative one', () => {
    const l = limitsOf(DEFAULT_RISK_POLICY, track(0, 0), 500n * U, none);
    expect([l.maxDealMinor, l.maxOpenMinor]).toEqual([1000n * U, 2000n * U]);
    const trusted = limitsOf(DEFAULT_RISK_POLICY, track(60, 40), 500n * U, none);
    expect([trusted.maxDealMinor, trusted.maxOpenMinor]).toEqual([5000n * U, 15000n * U]);
    expect(limitsOf(DEFAULT_RISK_POLICY, track(0, 0), -5n * U, none)).toMatchObject({ coverMinor: 0n, maxDealMinor: 0n, maxOpenMinor: 0n });
  });

  it('refuse a deal above one deal’s limit, and one that takes everything open past the open limit', () => {
    const l = limitsOf(DEFAULT_RISK_POLICY, track(0, 0), 500n * U, { totalMinor: 1850n * U, largestMinor: 950n * U });
    expect(riskFit(l, 1001n * U)).toBe('DEAL_ABOVE_LIMIT');
    expect(riskFit(l, 1000n * U)).toBe('OPEN_ABOVE_LIMIT');
    expect(riskFit(l, 150n * U)).toBeNull();
    expect(riskFit(l, 151n * U)).toBe('OPEN_ABOVE_LIMIT');
    // An offer being accepted is already counted.
    expect(riskFit(l, 950n * U, 950n * U)).toBeNull();
  });

  it('lock what backs the open deals: enough for the largest of them, and for all of them together, rounded up to the cent', () => {
    const tier = DEFAULT_RISK_POLICY.tiers[0];
    expect(backingFor(tier, { totalMinor: 3550n * U, largestMinor: 1500n * U })).toBe(887_500_000n);
    expect(backingFor(tier, { totalMinor: 1600n * U, largestMinor: 1500n * U })).toBe(750n * U);
    expect(backingFor(tier, { totalMinor: 3n, largestMinor: 3n })).toBe(10_000n);
    expect(backingFor(tier, { totalMinor: 16_050_789_256n, largestMinor: 9_732_824_427n })).toBe(4_866_420_000n);
    expect(backingFor(tier, { totalMinor: 0n, largestMinor: 0n })).toBe(0n);
  });
});

describe('a risk policy', () => {
  const ok: RiskPolicy = DEFAULT_RISK_POLICY;

  it('is three levels, the first open to all, each asking and allowing at least as much as the one before', () => {
    expect(requireRiskPolicy(ok)).toEqual(ok);
    expect(requireRiskPolicy(JSON.stringify(ok))).toEqual(ok);
    const bad: unknown[] = [
      null,
      { cleanDays: 30, tiers: ok.tiers.slice(0, 2) },
      { ...ok, cleanDays: 400 },
      { ...ok, tiers: [{ ...ok.tiers[0], minDeals: 1 }, ok.tiers[1], ok.tiers[2]] },
      { ...ok, tiers: [ok.tiers[0], { ...ok.tiers[1], dealX: 1 }, ok.tiers[2]] },
      { ...ok, tiers: [ok.tiers[0], ok.tiers[1], { ...ok.tiers[2], minDays: 1 }] },
      { ...ok, tiers: [{ ...ok.tiers[0], openX: 1 }, ok.tiers[1], ok.tiers[2]] },
      { ...ok, tiers: [ok.tiers[0], ok.tiers[1], { ...ok.tiers[2], dealX: 1.5 }] },
      { ...ok, tiers: [ok.tiers[0], ok.tiers[1], { ...ok.tiers[2], dealX: '10' }] },
    ];
    for (const b of bad) expect(() => requireRiskPolicy(b)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
