import { randomUUID } from 'node:crypto';
import type { ChainVerifier, TronSendNetwork, UnsignedTronTx } from '@inrp2p/adapters';
import type { ActorRef, Db, TxContext } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import type { SettlementDeps } from '@inrp2p/settlement';

/** What signs: the worker's HD signer (`@inrp2p/adapters/signer`), seen only through what this module needs of it. */
export interface TxSigner {
  readonly accountXpub: string;
  readonly feeWalletAddress: string;
  addressOf(path: string): string;
  sign(path: string, tx: UnsignedTronTx): string;
}

export interface OnchainPolicy {
  /** How long a signed transaction may wait to be included before it expires (and can be proved dead). */
  readonly validitySeconds: number;
  /** Past expiration, how far every provider's solidified head must be before an attempt is called expired. */
  readonly expiryMarginSeconds: number;
  /** Broadcast the same bytes again when nothing is known of them for this long. */
  readonly rebroadcastSeconds: number;
  /** An attempt neither final nor provably dead for this long opens a case (it stays blocked either way). */
  readonly unresolvedAfterMinutes: number;
  /** Transactions of one send that failed on chain before it is blocked for a person to look at. */
  readonly maxFailedAttempts: number;
  /** A send blocked for want of TRX is tried again after this long. */
  readonly blockedRetrySeconds: number;
  /** Sends handled in one run. */
  readonly batch: number;
  /**
   * Block 10: TRX is reclaimed from a deal address only once nothing has been sent from it or to it for this long — a
   * late refund or a sweep of the same address would otherwise need it topped up again at once.
   */
  readonly reclaimIdleMinutes: number;
}

export const DEFAULT_ONCHAIN_POLICY: OnchainPolicy = Object.freeze({
  validitySeconds: 600,
  expiryMarginSeconds: 60,
  rebroadcastSeconds: 30,
  unresolvedAfterMinutes: 30,
  maxFailedAttempts: 3,
  blockedRetrySeconds: 120,
  batch: 25,
  reclaimIdleMinutes: 60,
});

export interface OnchainDeps {
  readonly network: TronSendNetwork;
  /** Null: nothing is signed, and every send waits, visibly. */
  readonly signer: TxSigner | null;
  /** The USDT verifier settlement confirms with (FI-24). */
  readonly chain: ChainVerifier;
  readonly policy?: Partial<OnchainPolicy>;
  readonly settlementPolicy?: SettlementDeps['policy'];
  /** Wall clock, ms — when to look for an expiry proof (the proof itself is the chain's). Tests use the fake chain's. */
  readonly clock?: () => number;
}

export const clockOf = (deps: Pick<OnchainDeps, 'clock'>): number => (deps.clock ?? Date.now)();

export const policyOf = (deps: Pick<OnchainDeps, 'policy'>): OnchainPolicy => ({ ...DEFAULT_ONCHAIN_POLICY, ...(deps.policy ?? {}) });
export const settlementDepsOf = (deps: OnchainDeps): SettlementDeps => ({ chain: deps.chain, ...(deps.settlementPolicy ? { policy: deps.settlementPolicy } : {}) });

const SYSTEM: ActorRef = { type: 'SYSTEM', id: null, surface: 'SYSTEM' };

/** One step of the signer through the command pipeline: its own transaction, audit and idempotency key (FI-50). */
export async function step<R>(db: Db, name: string, payload: Record<string, unknown>, fn: (ctx: TxContext) => Promise<R>, key?: string): Promise<R> {
  const out = await executeCommand(db, { authorize: async () => {}, handle: fn }, { name, actor: SYSTEM, payload, idempotencyKey: key ?? randomUUID(), financial: true });
  return out.result;
}
