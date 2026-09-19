import type { TronAddress } from '@inrp2p/kernel';

export type CustodyNetwork = 'TRON';
export type DepositAddressCapability = 'DERIVED' | 'POOL' | 'UNSUPPORTED';

export interface ProvidedDepositAddress {
  readonly address: TronAddress;
  /** Provider address id or derivation index/path. Never key material. */
  readonly custodyReference: string;
}

/**
 * Wallet/custody provider port (ARCHITECTURE §6, DECISIONS D-02). Watch-only: the application holds no keys.
 * A real provider implementation is built only after its capability is confirmed (Phase 2 gate); until then
 * only the deterministic fake in `@inrp2p/adapters/testing` exists.
 */
export interface CustodyAdapter {
  readonly provider: string;
  capabilities(network: CustodyNetwork): Promise<{ readonly depositAddress: DepositAddressCapability }>;
  /** DERIVED mode: a new, never-before-issued address for this trade reference. */
  allocateDepositAddress(network: CustodyNetwork, tradeRef: string): Promise<ProvidedDepositAddress>;
  /** POOL mode: addresses provisioned at the provider that the exchange may import into its pool. */
  listDepositAddresses(network: CustodyNetwork): Promise<readonly ProvidedDepositAddress[]>;
}

/**
 * The adapter a POOL deployment runs with (D-02).
 *
 * In POOL mode the provider does not issue an address per trade: addresses are provisioned at the provider once
 * and imported into `deposit_address` by an operator, and acceptance takes the next AVAILABLE one from that pool
 * under `FOR UPDATE SKIP LOCKED`. So the only thing an adapter contributes at acceptance time is its identity and
 * the capability it claims — which is precisely what `requireAdapterMatchesRecord` checks against the recorded
 * `custody_provider_config` before a single address is handed out.
 *
 * It therefore implements exactly that, and nothing else. `listDepositAddresses` returns nothing rather than
 * inventing addresses: importing a pool is a provider operation done with the provider's own tooling, and a
 * fabricated address would be a client's funds sent nowhere. `allocateDepositAddress` refuses, because a POOL
 * provider deriving an address on demand is a contradiction, not a fallback.
 */
export class PoolCustodyAdapter implements CustodyAdapter {
  readonly provider: string;

  constructor(provider: string) {
    const slug = provider.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(slug)) throw new Error('custody provider must be a lowercase slug matching the recorded capability');
    this.provider = slug;
  }

  async capabilities(_network: CustodyNetwork) {
    return { depositAddress: 'POOL' as const };
  }

  async allocateDepositAddress(): Promise<ProvidedDepositAddress> {
    throw new Error('CUSTODY_CAPABILITY_MISMATCH: a POOL provider does not derive addresses per trade (D-02)');
  }

  async listDepositAddresses(): Promise<readonly ProvidedDepositAddress[]> {
    return [];
  }
}

/**
 * Used when no custody provider is configured. It reports UNSUPPORTED, which is the same answer the database
 * gives with no `custody_provider_config` row, so SELL acceptance refuses loudly (D-02) instead of a deployment
 * discovering at acceptance time that it has no way to attribute an incoming transfer.
 */
export class UnconfiguredCustodyAdapter implements CustodyAdapter {
  readonly provider = 'unconfigured';

  async capabilities(_network: CustodyNetwork) {
    return { depositAddress: 'UNSUPPORTED' as const };
  }

  async allocateDepositAddress(): Promise<ProvidedDepositAddress> {
    throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED: no custody provider is configured');
  }

  async listDepositAddresses(): Promise<readonly ProvidedDepositAddress[]> {
    throw new Error('CUSTODY_PROVIDER_NOT_CONFIGURED: no custody provider is configured');
  }
}
