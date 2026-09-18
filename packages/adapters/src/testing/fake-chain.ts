import { createHash } from 'node:crypto';
import { encodeTronAddress } from '@inrp2p/kernel';
import type { ChainNetwork, ChainVerifier, TransferReceipt } from '../chain.ts';

export const FAKE_USDT_CONTRACT = encodeTronAddress(createHash('sha256').update('fake-usdt-contract').digest().subarray(0, 20));

/**
 * In-memory chain for tests: transfers are added explicitly, so a test decides exactly what the chain says
 * (solidified or not, SUCCESS or FAILED, which contract, which destination). Nothing is inferred.
 */
export class FakeChainVerifier implements ChainVerifier {
  readonly providers: readonly string[];
  readonly tokenContract: string;
  readonly #events = new Map<string, TransferReceipt>();
  #head = 1_000n;
  /** Tx hashes the second provider disagrees about (D-05): only the primary vouches for them. */
  readonly disagreements = new Set<string>();

  constructor(opts: { providers?: readonly string[]; tokenContract?: string } = {}) {
    this.providers = opts.providers ?? ['fake-node-a', 'fake-node-b'];
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

  async lookupTransfer(network: ChainNetwork, txHash: string, logIndex: number): Promise<TransferReceipt | null> {
    const receipt = this.#events.get(`${network}:${txHash}:${logIndex}`);
    if (!receipt) return null;
    return this.disagreements.has(receipt.txHash) ? { ...receipt, agreedBy: this.providers.slice(0, 1) } : receipt;
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
