import { DomainError, type TronAddress } from '@inrp2p/kernel';
import { HdDepositAccount } from './hd-wallet.ts';

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
  /**
   * DERIVED mode: a new, never-before-issued address for this trade reference. `sequence` is a number the database
   * issued for this one allocation and will never issue again (`custody_derivation_index_seq`); a provider that
   * derives addresses itself (an HD account) uses it as the derivation index, so no index is ever reused even when
   * the transaction that drew it rolls back.
   */
  allocateDepositAddress(network: CustodyNetwork, tradeRef: string, sequence: bigint): Promise<ProvidedDepositAddress>;
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

/**
 * DERIVED custody from the exchange's own HD wallet (ADR 0017 §3): every trade gets a fresh address
 * `m/44'/195'/0'/0/{sequence}` derived from the account's extended **public** key — no key, no provider call, no address
 * created by hand. The web app runs with this; only the worker's signer can spend from what it issues.
 */
export class HdWalletCustodyAdapter implements CustodyAdapter {
  readonly provider: string;
  readonly account: HdDepositAccount;

  constructor(opts: { provider?: string; accountXpub: string }) {
    const slug = (opts.provider ?? 'hd-wallet').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,40}$/.test(slug)) throw new Error('custody provider must be a lowercase slug matching the recorded capability');
    this.provider = slug;
    this.account = new HdDepositAccount(opts.accountXpub);
  }

  async capabilities(_network: CustodyNetwork) {
    return { depositAddress: 'DERIVED' as const };
  }

  async allocateDepositAddress(network: CustodyNetwork, _tradeRef: string, sequence: bigint): Promise<ProvidedDepositAddress> {
    if (network !== 'TRON') throw new DomainError('CUSTODY_CAPABILITY_UNSUPPORTED', `no ${network} addresses here`);
    const { address, path } = this.account.addressAt(sequence);
    return { address, custodyReference: path };
  }

  async listDepositAddresses(): Promise<readonly ProvidedDepositAddress[]> {
    return [];
  }
}
