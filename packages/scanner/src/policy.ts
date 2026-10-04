import type { TronProvider } from '@inrp2p/adapters';
import type { SettlementDeps } from '@inrp2p/settlement';

/**
 * Scanner policy (ARCHITECTURE §6). None of these values change what counts as money: they only decide how
 * often and how far the scanner looks. Finality is the chain's word (FI-24) and attribution is the deposit
 * assignment's (FI-26), whatever these are set to.
 */
export interface ScannerPolicy {
  /** Cursor name; one cursor per logical scanner and network. */
  readonly scanner: string;
  /** Each run re-reads this many blocks below the cursor, so a short reorg cannot hide a transfer. */
  readonly rescanOverlapBlocks: bigint;
  /** On the very first run the cursor starts this far below the current head. */
  readonly startLookbackBlocks: bigint;
  /**
   * The widest block window one run will read. A worker that was offline for a week catches up over several
   * runs of this size; the cursor advances only across what was actually proved read, so no block is skipped.
   */
  readonly maxBlocksPerRun: bigint;
  /** Detection steps one run performs at most; past it the cursor stops below the first block left unprocessed. */
  readonly maxTransfersPerRun: number;
  /** How many DETECTED transfers one confirmation run verifies. */
  readonly confirmBatch: number;
  /** A transfer still not final this long after detection becomes a `TX_NOT_FINAL` case for the desk. */
  readonly notFinalAfterMinutes: number;
  /** A detected transfer the providers no longer know after this long is treated as orphaned (T3). */
  readonly orphanAfterMinutes: number;
  /** Blocks one backfill run reads per address (TD-06). */
  readonly backfillBlocksPerRun: bigint;
}

export const DEFAULT_SCANNER_POLICY: ScannerPolicy = Object.freeze({
  scanner: 'tron_deposits',
  rescanOverlapBlocks: 200n,
  startLookbackBlocks: 1_000n,
  maxBlocksPerRun: 20_000n,
  maxTransfersPerRun: 500,
  confirmBatch: 100,
  notFinalAfterMinutes: 30,
  orphanAfterMinutes: 60,
  backfillBlocksPerRun: 20_000n,
});

/**
 * The scanner *reads* the chain through its providers, in priority order, failing over to the next when one cannot
 * answer — detection never confirms money, so reading through any configured provider is safe. It *verifies*
 * through the settlement `ChainVerifier`, which asks every provider and measures the D-05 quorum.
 */
export interface ScannerDeps extends SettlementDeps {
  readonly providers: readonly TronProvider[];
  readonly scanner?: Partial<ScannerPolicy>;
}

export function scannerPolicyOf(deps: Pick<ScannerDeps, 'scanner'>): ScannerPolicy {
  return { ...DEFAULT_SCANNER_POLICY, ...(deps.scanner ?? {}) };
}
