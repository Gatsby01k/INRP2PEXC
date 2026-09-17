import type { CustodyAdapter, FieldProtector } from '@inrp2p/adapters';

/**
 * Quote and acceptance policy. Values not fixed by DECISIONS are defaults (listed in the Phase 3 report) and are
 * injected per deployment; commands never read them from payloads.
 */
export interface QuotePolicy {
  /** Largest request, per fixed side (decimal strings). */
  readonly maxBaseUsdt: string;
  readonly maxQuoteInr: string;
  readonly enabledDirections: readonly ('SELL_USDT' | 'BUY_USDT')[];
  /** D-07: `kyc_status = VERIFIED` required for acceptance when enabled. Off until counsel defines the policy. */
  readonly requireKycVerified: boolean;
  /** STATE_MACHINES §2: in-app validity window. */
  readonly minValiditySeconds: number;
  readonly maxValiditySeconds: number;
  /** D-01 rev 3: shareable-link quotes default 180 s, minimum 120 s. */
  readonly linkDefaultValiditySeconds: number;
  readonly linkMinValiditySeconds: number;
  /** A quote cannot be sent on a route snapshot older than this. */
  readonly maxSnapshotAgeSeconds: number;
  /** OPEN requests without activity expire after this. */
  readonly requestTtlSeconds: number;
  /** D-01 OTP rules. */
  readonly otpTtlSeconds: number;
  readonly otpMaxSendsPerQuoteWindow: number;
  readonly otpSendWindowSeconds: number;
  /** SECURITY §7 rate limits. */
  readonly linkOpensPerIpPerMinute: number;
  readonly otpSendsPerIpPerHour: number;
  readonly decisionsPerTokenPerMinute: number;
}

export const DEFAULT_QUOTE_POLICY: QuotePolicy = Object.freeze({
  maxBaseUsdt: '5000000',
  maxQuoteInr: '500000000.00',
  enabledDirections: Object.freeze(['SELL_USDT', 'BUY_USDT'] as const),
  requireKycVerified: false,
  minValiditySeconds: 30,
  maxValiditySeconds: 1800,
  linkDefaultValiditySeconds: 180,
  linkMinValiditySeconds: 120,
  maxSnapshotAgeSeconds: 900,
  requestTtlSeconds: 24 * 3600,
  otpTtlSeconds: 300,
  otpMaxSendsPerQuoteWindow: 3,
  otpSendWindowSeconds: 600,
  linkOpensPerIpPerMinute: 30,
  otpSendsPerIpPerHour: 10,
  decisionsPerTokenPerMinute: 5,
});

export interface QuoteDeps {
  readonly protector: FieldProtector;
  readonly custody: CustodyAdapter;
  readonly policy?: Partial<QuotePolicy>;
}

export function policyOf(deps: Pick<QuoteDeps, 'policy'>): QuotePolicy {
  return { ...DEFAULT_QUOTE_POLICY, ...(deps.policy ?? {}) };
}
