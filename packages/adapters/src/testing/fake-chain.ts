import { createHash } from 'node:crypto';
import { encodeTronAddress } from '@inrp2p/kernel';
import type { BalanceSource, ChainNetwork, ChainVerification, ChainVerifier, TransactionTransfers, TransferReceipt } from '../chain.ts';

export const FAKE_USDT_CONTRACT = encodeTronAddress(createHash('sha256').update('fake-usdt-contract').digest().subarray(0, 20));

/**
 * In-memory chain for tests: transfers are added explicitly, so a test decides exactly what the chain says
 * (solidified or not, SUCCESS or FAILED, which contract, which destination). Nothing is inferred.
 */
export class FakeChainVerifier implements ChainVerifier {
  readonly providers: readonly string[];
  readonly independenceGroups: readonly string[];
  readonly tokenContract: string;
  readonly #events = new Map<string, TransferReceipt>();
  #head = 1_000n;
  /** The highest block a balance reading has reported: a transfer added later never lands at or below it. */
  #readThrough = 0n;
  /** Tx hashes the second provider disagrees about (D-05): only the primary vouches for them. */
  readonly disagreements = new Set<string>();
  /** Tx hashes the providers contradict each other about (facts differ, or one says failed). */
  readonly conflicts = new Set<string>();
  /** When set, every provider is unreachable: verification answers UNAVAILABLE. */
  outage = false;

  constructor(opts: { providers?: readonly string[]; independenceGroups?: readonly string[]; tokenContract?: string } = {}) {
    this.providers = opts.providers ?? ['fake-node-a', 'fake-node-b'];
    // One group per provider unless a test says otherwise: the default fake is two independent sources.
    this.independenceGroups = opts.independenceGroups ?? this.providers.map((p) => `group-${p}`);
    this.tokenContract = opts.tokenContract ?? FAKE_USDT_CONTRACT;
  }

  /** Records a transfer as the chain would report it. `solidified: false` keeps it above the solidified head. */
  add(input: {
    txHash?: string;
    logIndex?: number;
    from: string;
    to: string;
    amountMinor: bigint;
    solidified?: boolean;
    receiptStatus?: 'SUCCESS' | 'FAILED';
    tokenContract?: string;
  }): TransferReceipt {
    const txHash = input.txHash ?? createHash('sha256').update(`${this.#events.size}:${input.to}:${input.amountMinor}`).digest('hex');
    const logIndex = input.logIndex ?? 0;
    const solidified = input.solidified ?? true;
    // A transfer happens after every balance already read: placing it in a block a reading covered would make that
    // reading claim to include money it never saw.
    if (this.#head - 20n <= this.#readThrough) this.#head = this.#readThrough + 21n;
    const blockNumber = solidified ? this.#head - 20n : this.#head + 5n;
    const receipt: TransferReceipt = {
      network: 'TRON',
      txHash,
      logIndex,
      tokenContract: input.tokenContract ?? this.tokenContract,
      fromAddress: input.from,
      toAddress: input.to,
      amountMinor: input.amountMinor,
      blockNumber,
      blockTime: new Date(),
      receiptStatus: input.receiptStatus ?? 'SUCCESS',
      solidifiedBlock: this.#head,
      agreedBy: this.providers,
      agreedGroups: this.independenceGroups,
      unavailable: [],
      degraded: false,
    };
    this.#events.set(`TRON:${txHash}:${logIndex}`, receipt);
    this.#head += 1n;
    return receipt;
  }

  /** Advances the solidified head so previously unsolidified transfers become final. */
  solidifyAll(): void {
    this.#head += 100n;
    for (const [key, r] of this.#events) this.#events.set(key, { ...r, solidifiedBlock: this.#head });
  }

  async verifyTransfer(network: ChainNetwork, txHash: string, logIndex: number): Promise<ChainVerification> {
    if (this.outage) return { status: 'UNAVAILABLE', reason: 'every provider is unreachable (test outage)', unavailable: this.providers };
    const receipt = this.#events.get(`${network}:${txHash}:${logIndex}`);
    if (!receipt) return { status: 'NOT_FOUND', absentBy: this.providers, absentGroups: this.independenceGroups, unavailable: [] };
    if (this.conflicts.has(receipt.txHash)) return { status: 'CONFLICT', reason: 'the providers report different facts (test)', unavailable: [] };
    if (receipt.receiptStatus === 'FAILED') {
      const final = receipt.blockNumber <= receipt.solidifiedBlock;
      const groups = this.disagreements.has(receipt.txHash) ? this.independenceGroups.slice(0, 1) : this.independenceGroups;
      return {
        status: 'TX_FAILED', txHash: receipt.txHash, blockNumber: receipt.blockNumber, blockTime: receipt.blockTime, result: 'REVERT',
        agreedBy: final ? this.providers.slice(0, groups.length) : [], agreedGroups: final ? groups : [], unavailable: [],
      };
    }
    return {
      status: 'FOUND',
      receipt: this.disagreements.has(receipt.txHash)
        ? { ...receipt, agreedBy: this.providers.slice(0, 1), agreedGroups: this.independenceGroups.slice(0, 1), unavailable: this.providers.slice(1), degraded: this.providers.length > 1 }
        : receipt,
    };
  }

  async transactionTransfers(network: ChainNetwork, txHash: string): Promise<TransactionTransfers> {
    const hash = txHash.toLowerCase();
    const logs = [...this.#events.values()].filter((r) => r.network === network && r.txHash === hash).sort((a, b) => a.logIndex - b.logIndex);
    if (logs.length === 0) return { status: 'NOT_FOUND', txHash: hash, transfers: [], provider: this.providers[0] ?? 'fake' };
    if (logs.some((r) => r.receiptStatus === 'FAILED')) return { status: 'TX_FAILED', txHash: hash, transfers: [], provider: this.providers[0] ?? 'fake' };
    return {
      status: 'FOUND', txHash: hash, provider: this.providers[0] ?? 'fake',
      transfers: logs.map(({ solidifiedBlock: _s, agreedBy: _a, agreedGroups: _g, unavailable: _u, degraded: _d, ...t }) => t),
    };
  }

  /** USDT of `address` the chain has made final: successful, solidified transfers in, less those out. */
  balanceOf(address: string): bigint {
    let sum = 0n;
    for (const r of this.#events.values()) {
      if (r.receiptStatus !== 'SUCCESS' || r.tokenContract !== this.tokenContract || r.blockNumber > this.#head) continue;
      if (r.toAddress === address) sum += r.amountMinor;
      if (r.fromAddress === address) sum -= r.amountMinor;
    }
    return sum;
  }

  /** A balance reader over this fake chain, one per configured provider (B2 observations in tests). */
  balanceSources(): readonly BalanceSource[] {
    return this.providers.map((name, i) => ({
      name,
      independenceGroup: this.independenceGroups[i] ?? this.independenceGroups[0] ?? `group-${name}`,
      getSolidifiedBalance: async (address: string, contract: string) => {
        if (this.outage) throw new Error('every provider is unreachable (test outage)');
        const balance = contract === this.tokenContract ? this.balanceOf(address) : 0n;
        if (this.#head > this.#readThrough) this.#readThrough = this.#head;
        return { balanceMinor: balance < 0n ? 0n : balance, solidifiedBlock: this.#head, trxSun: 0n };
      },
    }));
  }

  /** Test hook: the second provider stops vouching for this transfer. */
  disagreeAbout(txHash: string): void {
    this.disagreements.add(txHash);
  }

  /** Test hook: the transfer disappears from the chain (reorg). */
  forget(txHash: string, logIndex = 0): void {
    this.#events.delete(`TRON:${txHash}:${logIndex}`);
  }
}
