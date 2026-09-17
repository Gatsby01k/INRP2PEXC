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
