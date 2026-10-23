import type { TraderSide, TraderStatus } from '@inrp2p/db';

/**
 * Who may receive an order, as pure functions over facts the caller read under its own locks. Routing, switching
 * on and the trader's own screen all ask these same questions, so the answer a trader sees is the answer routing
 * acts on.
 */
export interface TraderStanding {
  readonly status: TraderStatus;
  readonly available: boolean;
  readonly assignmentsEnabled: boolean;
  /** Required reserve set, and the reserve (less withdrawals on their way) covers it. */
  readonly reserveSet: boolean;
  readonly reserveFunded: boolean;
  /** The registered bank account and wallet are both still active. */
  readonly destinationsActive: boolean;
}

export interface BlockFacts {
  readonly side: TraderSide;
  readonly status: 'ACTIVE' | 'PAUSED';
  readonly rateMicro: bigint | null;
  readonly capacityMinor: bigint;
  readonly reservedMinor: bigint;
  /** Capacity already promised to offers the trader has not answered yet. */
  readonly offeredMinor: bigint;
  readonly minOrderMinor: bigint | null;
  readonly maxOrderMinor: bigint | null;
  /** Operator ceilings in the block's currency; null means none. */
  readonly operatorMaxOrderMinor: bigint | null;
  readonly operatorMaxCapacityMinor: bigint | null;
}

export type StandingIssue = 'NOT_APPROVED' | 'PAUSED' | 'RESERVE_NOT_SET' | 'RESERVE_SHORT' | 'DESTINATIONS_INACTIVE' | 'OFFLINE' | 'ASSIGNMENTS_DISABLED';

/** Why a trader receives no orders at all, most fundamental first. Empty: it can receive them. */
export function standingIssues(s: TraderStanding): StandingIssue[] {
  const issues: StandingIssue[] = [];
  if (s.status === 'PAUSED') issues.push('PAUSED');
  else if (s.status !== 'APPROVED') issues.push('NOT_APPROVED');
  if (!s.reserveSet) issues.push('RESERVE_NOT_SET');
  else if (!s.reserveFunded) issues.push('RESERVE_SHORT');
  if (!s.destinationsActive) issues.push('DESTINATIONS_INACTIVE');
  if (!s.assignmentsEnabled) issues.push('ASSIGNMENTS_DISABLED');
  if (!s.available) issues.push('OFFLINE');
  return issues;
}

/** What switching on needs: everything except being on already, and the operator's assignment switch. */
export function switchOnIssues(s: TraderStanding): StandingIssue[] {
  return standingIssues(s).filter((i) => i !== 'OFFLINE' && i !== 'ASSIGNMENTS_DISABLED');
}

/** Capacity routing may still promise: the lower of the trader's capacity and the operator's ceiling, less holds. */
export function freeCapacity(b: BlockFacts): bigint {
  const ceiling = b.operatorMaxCapacityMinor !== null && b.operatorMaxCapacityMinor < b.capacityMinor ? b.operatorMaxCapacityMinor : b.capacityMinor;
  const free = ceiling - b.reservedMinor - b.offeredMinor;
  return free > 0n ? free : 0n;
}

/** The largest single order the block takes: its own maximum, or the operator's when that is lower. */
export function effectiveMaxOrder(b: BlockFacts): bigint | null {
  if (b.maxOrderMinor === null) return b.operatorMaxOrderMinor;
  if (b.operatorMaxOrderMinor === null) return b.maxOrderMinor;
  return b.operatorMaxOrderMinor < b.maxOrderMinor ? b.operatorMaxOrderMinor : b.maxOrderMinor;
}

export type BlockIssue = 'BLOCK_PAUSED' | 'NO_RATE' | 'NO_LIMITS' | 'NO_CAPACITY';

/** Why a block receives nothing even for a trader in good standing. */
export function blockIssues(b: BlockFacts): BlockIssue[] {
  const issues: BlockIssue[] = [];
  if (b.status !== 'ACTIVE') issues.push('BLOCK_PAUSED');
  if (b.rateMicro === null) issues.push('NO_RATE');
  if (b.minOrderMinor === null || b.maxOrderMinor === null) issues.push('NO_LIMITS');
  if (freeCapacity(b) === 0n) issues.push('NO_CAPACITY');
  return issues;
}

export type FitIssue = BlockIssue | 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM' | 'NOT_ENOUGH_CAPACITY';

/** Whether one order of `amountMinor` (in the block's currency) fits the block now. */
export function orderFit(b: BlockFacts, amountMinor: bigint): FitIssue | null {
  if (b.status !== 'ACTIVE') return 'BLOCK_PAUSED';
  if (b.rateMicro === null) return 'NO_RATE';
  if (b.minOrderMinor === null || b.maxOrderMinor === null) return 'NO_LIMITS';
  if (amountMinor < b.minOrderMinor) return 'BELOW_MINIMUM';
  const max = effectiveMaxOrder(b);
  if (max !== null && amountMinor > max) return 'ABOVE_MAXIMUM';
  if (amountMinor > freeCapacity(b)) return 'NOT_ENOUGH_CAPACITY';
  return null;
}
