import type { ChainVerifier } from '@inrp2p/adapters';

/**
 * Settlement policy. Values DECISIONS does not fix are defaults, injected per deployment and never read
 * from a command payload (the Phase 4 report lists them).
 */
export interface SettlementPolicy {
  /** D-05: at or above this USDT amount, a transfer needs two independent providers to agree. */
  readonly dualProviderThresholdUsdt: string;
  /** Payout legs below this are refused outright (protects against fat-finger zero-ish payouts). */
  readonly minPayoutInr: string;
  /** Rails an operator may record a client payout on. */
  readonly payoutRails: readonly ('IMPS' | 'NEFT' | 'RTGS' | 'UPI')[];
}

export const DEFAULT_SETTLEMENT_POLICY: SettlementPolicy = Object.freeze({
  dualProviderThresholdUsdt: '10000',
  minPayoutInr: '1.00',
  payoutRails: Object.freeze(['IMPS', 'NEFT', 'RTGS', 'UPI'] as const),
});

export interface SettlementDeps {
  readonly chain: ChainVerifier;
  readonly policy?: Partial<SettlementPolicy>;
}

export function policyOf(deps: Pick<SettlementDeps, 'policy'>): SettlementPolicy {
  return { ...DEFAULT_SETTLEMENT_POLICY, ...(deps.policy ?? {}) };
}
