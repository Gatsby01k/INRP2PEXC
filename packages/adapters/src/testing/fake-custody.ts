import { createHash } from 'node:crypto';
import { DomainError, encodeTronAddress } from '@inrp2p/kernel';
import type { CustodyAdapter, CustodyNetwork, DepositAddressCapability, ProvidedDepositAddress } from '../custody.ts';

/**
 * Deterministic fake custody provider for tests. Addresses derive from a seed and an index, so two fakes
 * with the same seed return the same addresses — useful to prove uniqueness is enforced by the system,
 * not trusted from the provider.
 */
export class FakeCustodyAdapter implements CustodyAdapter {
  readonly provider: string;
  capability: DepositAddressCapability;
  readonly #seed: string;
  readonly #poolSize: number;
  #nextIndex = 0;

  constructor(opts: { provider?: string; capability: DepositAddressCapability; seed?: string; poolSize?: number }) {
    this.provider = opts.provider ?? 'fake-custody';
    this.capability = opts.capability;
    this.#seed = opts.seed ?? 'seed';
    this.#poolSize = opts.poolSize ?? 10;
  }

  addressAt(index: number): ProvidedDepositAddress {
    const id = createHash('sha256').update(`${this.#seed}:${index}`).digest().subarray(0, 20);
    return { address: encodeTronAddress(id), custodyReference: `m/44'/195'/0'/0/${index}` };
  }

  async capabilities(_network: CustodyNetwork) {
    return { depositAddress: this.capability };
  }

  async allocateDepositAddress(_network: CustodyNetwork, _tradeRef: string): Promise<ProvidedDepositAddress> {
    if (this.capability !== 'DERIVED') throw new DomainError('CUSTODY_CAPABILITY_MISMATCH', `fake provider is ${this.capability}`);
    return this.addressAt(this.#nextIndex++);
  }

  /** Test hook: make the next derivation repeat an earlier index (a faulty provider). */
  rewind(index: number): void {
    this.#nextIndex = index;
  }

  async listDepositAddresses(_network: CustodyNetwork): Promise<readonly ProvidedDepositAddress[]> {
    if (this.capability !== 'POOL') throw new DomainError('CUSTODY_CAPABILITY_MISMATCH', `fake provider is ${this.capability}`);
    return Array.from({ length: this.#poolSize }, (_, i) => this.addressAt(i));
  }
}
