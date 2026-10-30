import { DomainError } from './errors.ts';

/**
 * How far a trader's Security Reserve stretches (ADR 0024 §2). A trader deals within limits its own collateral and record
 * set, the way a margin account works: a single deal may be up to `dealX` times its free reserve, its open deals together
 * up to `openX` times, and the reserve that backs what is open cannot be withdrawn. The multiples grow with the trader's
 * level — reached by completed deals and days since approval — and fall back to the first level after a deal the trader
 * failed (a dispute INRP2P decided against it, or an escrow unwound because it did not pay) in the last `cleanDays`.
 *
 * A trader who wants larger deals now deposits more; one who wants them on the same reserve completes deals. No person
 * raises a limit by hand, and none is needed to lower one: the desk's own ceilings still apply on top, the lower wins.
 */
export const TIER_NAMES = ['NEW', 'PROVEN', 'TRUSTED'] as const;
export type TierName = (typeof TIER_NAMES)[number];

export interface RiskTier {
  /** Completed deals needed to reach this level. */
  readonly minDeals: number;
  /** Days since approval needed to reach this level. */
  readonly minDays: number;
  /** A single deal, in USDT, up to this many times the free reserve. */
  readonly dealX: number;
  /** Open deals together, in USDT, up to this many times the free reserve. */
  readonly openX: number;
}

export interface RiskPolicy {
  /** A failed deal this recent puts the trader back to the first level. */
  readonly cleanDays: number;
  readonly tiers: readonly [RiskTier, RiskTier, RiskTier];
}

/** The policy migration 0043 sets; the desk changes it on the programme (⧗). */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  cleanDays: 30,
  tiers: [
    { minDeals: 0, minDays: 0, dealX: 2, openX: 4 },
    { minDeals: 10, minDays: 7, dealX: 5, openX: 15 },
    { minDeals: 50, minDays: 30, dealX: 10, openX: 30 },
  ],
};

const whole = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a whole number between ${min} and ${max}`, { field });
  }
  return value;
};

/**
 * A risk policy as the database accepts it (`inrp2p_valid_trader_risk_policy`): three levels, the first open to every
 * approved trader, each asking at least as much as the one before and allowing at least as much, open deals never below
 * a single deal.
 */
export function requireRiskPolicy(value: unknown): RiskPolicy {
  const v = (typeof value === 'string' ? JSON.parse(value) : value) as { cleanDays?: unknown; tiers?: unknown } | null;
  if (!v || typeof v !== 'object' || !Array.isArray(v.tiers) || v.tiers.length !== 3) {
    throw new DomainError('INVALID_ARGUMENT', 'a risk policy has three levels', { field: 'riskPolicy' });
  }
  const tiers = v.tiers.map((t: unknown, i: number): RiskTier => {
    const r = (t ?? {}) as Record<string, unknown>;
    const tier = {
      minDeals: whole(r.minDeals, `tiers[${i}].minDeals`, 0, 100_000),
      minDays: whole(r.minDays, `tiers[${i}].minDays`, 0, 3650),
      dealX: whole(r.dealX, `tiers[${i}].dealX`, 1, 100),
      openX: whole(r.openX, `tiers[${i}].openX`, 1, 500),
    };
    if (tier.openX < tier.dealX) throw new DomainError('INVALID_ARGUMENT', 'open deals together are allowed at least one deal', { field: `tiers[${i}].openX` });
    return tier;
  }) as unknown as RiskPolicy['tiers'];
  if (tiers[0].minDeals !== 0 || tiers[0].minDays !== 0) throw new DomainError('INVALID_ARGUMENT', 'the first level is open to every approved trader', { field: 'tiers[0]' });
  for (const [a, b] of [[tiers[0], tiers[1]], [tiers[1], tiers[2]]] as const) {
    if (b.minDeals < a.minDeals || b.minDays < a.minDays || b.dealX < a.dealX || b.openX < a.openX) {
      throw new DomainError('INVALID_ARGUMENT', 'each level asks and allows at least as much as the one before', { field: 'tiers' });
    }
  }
  return { cleanDays: whole(v.cleanDays, 'cleanDays', 0, 365), tiers };
}

/** What the levels are decided on, all read from the books. */
export interface TrackRecord {
  readonly completedDeals: number;
  /** Whole days since the trader was first approved; null before approval. */
  readonly daysApproved: number | null;
  /** Deals the trader failed within the policy's `cleanDays`. */
  readonly strikes: number;
}

export interface TierStanding {
  readonly index: 0 | 1 | 2;
  readonly name: TierName;
  /** A recent failed deal holds the trader at the first level whatever its record. */
  readonly heldBack: boolean;
  /** What the next level asks for, or null at the top (or while held back). */
  readonly next: { readonly name: TierName; readonly deals: number; readonly days: number } | null;
}

export function tierOf(policy: RiskPolicy, track: TrackRecord): TierStanding {
  const days = track.daysApproved ?? 0;
  if (track.strikes > 0) return { index: 0, name: 'NEW', heldBack: true, next: null };
  let index: 0 | 1 | 2 = 0;
  for (const i of [1, 2] as const) {
    const t = policy.tiers[i];
    if (track.completedDeals >= t.minDeals && days >= t.minDays) index = i;
  }
  const nextTier = index < 2 ? policy.tiers[(index + 1) as 1 | 2] : null;
  return {
    index,
    name: TIER_NAMES[index],
    heldBack: false,
    next: nextTier
      ? { name: TIER_NAMES[index + 1]!, deals: Math.max(0, nextTier.minDeals - track.completedDeals), days: Math.max(0, nextTier.minDays - days) }
      : null,
  };
}

/** What is open on a trader right now, in USDT: offers not yet lapsed, holds and deals not yet finished. */
export interface Exposure {
  readonly totalMinor: bigint;
  readonly largestMinor: bigint;
}

export interface RiskLimits {
  readonly tier: TierStanding;
  /** The reserve the limits are drawn on: what the trader holds, less withdrawals and applications on their way. */
  readonly coverMinor: bigint;
  readonly maxDealMinor: bigint;
  readonly maxOpenMinor: bigint;
  readonly exposure: Exposure;
  /** What of the reserve backs the deals open now, at this level — locked while they are. */
  readonly backingMinor: bigint;
  readonly track: TrackRecord;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a <= 0n ? 0n : (a + b - 1n) / b);

/** A USDT cent in minor units: the reserve is locked in whole cents, rounded up — never less than the deals need. */
const CENT = 10_000n;

/** The reserve that must stay to back open deals: enough for the largest of them and for all of them together. */
export function backingFor(tier: RiskTier, exposure: Exposure): bigint {
  const forLargest = ceilDiv(exposure.largestMinor, BigInt(tier.dealX));
  const forAll = ceilDiv(exposure.totalMinor, BigInt(tier.openX));
  return ceilDiv(forLargest > forAll ? forLargest : forAll, CENT) * CENT;
}

export function limitsOf(policy: RiskPolicy, track: TrackRecord, coverMinor: bigint, exposure: Exposure): RiskLimits {
  const tier = tierOf(policy, track);
  const t = policy.tiers[tier.index];
  const cover = coverMinor > 0n ? coverMinor : 0n;
  return { tier, coverMinor: cover, maxDealMinor: cover * BigInt(t.dealX), maxOpenMinor: cover * BigInt(t.openX), exposure, backingMinor: backingFor(t, exposure), track };
}

export type RiskIssue = 'DEAL_ABOVE_LIMIT' | 'OPEN_ABOVE_LIMIT';

/**
 * Whether one more deal of `dealMinor` USDT fits. `alreadyCounted` is what of it the exposure already holds (an offer the
 * trader is now accepting is open from the moment it was offered).
 */
export function riskFit(limits: RiskLimits, dealMinor: bigint, alreadyCounted = 0n): RiskIssue | null {
  if (dealMinor > limits.maxDealMinor) return 'DEAL_ABOVE_LIMIT';
  if (limits.exposure.totalMinor - alreadyCounted + dealMinor > limits.maxOpenMinor) return 'OPEN_ABOVE_LIMIT';
  return null;
}
