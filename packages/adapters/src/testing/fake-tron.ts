import { createHash } from 'node:crypto';
import { encodeTronAddress } from '@inrp2p/kernel';
import type { Trc20Transfer, TronProvider } from '../tron.ts';
import { FAKE_USDT_CONTRACT } from './fake-chain.ts';

const key = (txHash: string, logIndex: number) => `${txHash.toLowerCase()}:${logIndex}`;

/** A deterministic TRON address for tests (valid base58, stable per label). */
export function fakeTronAddress(label: string): string {
  return encodeTronAddress(createHash('sha256').update(`fake-tron:${label}`).digest().subarray(0, 20));
}

export interface FakeTransferInput {
  readonly txHash?: string;
  readonly logIndex?: number;
  readonly from?: string;
  readonly to: string;
  readonly amountMinor: bigint;
  readonly tokenContract?: string;
  readonly receiptStatus?: 'SUCCESS' | 'FAILED';
  /** Block to mine it in; defaults to the current head + 1 (which then becomes the head). */
  readonly blockNumber?: bigint;
}

/**
 * The shared chain behind the fake providers: blocks are mined by adding transfers or advancing the head, and
 * finality trails the head by `solidificationLag` blocks (TRON's ~19-block irreversibility, FI-24). A reorg is a
 * transfer being forgotten while it is still above the solidified line.
 */
export class FakeTronChain {
  #transfers = new Map<string, Trc20Transfer>();
  #head: bigint;
  solidificationLag: bigint;
  readonly tokenContract: string;

  constructor(opts: { head?: bigint; solidificationLag?: bigint; tokenContract?: string } = {}) {
    this.#head = opts.head ?? 1_000n;
    this.solidificationLag = opts.solidificationLag ?? 20n;
    this.tokenContract = opts.tokenContract ?? FAKE_USDT_CONTRACT;
  }

  get head(): bigint {
    return this.#head;
  }

  get solidified(): bigint {
    const s = this.#head - this.solidificationLag;
    return s > 0n ? s : 0n;
  }

  /** Mines one TRC20 transfer. Returns it exactly as a provider would report it. */
  add(input: FakeTransferInput): Trc20Transfer {
    const blockNumber = input.blockNumber ?? this.#head + 1n;
    if (blockNumber > this.#head) this.#head = blockNumber;
    const txHash =
      input.txHash?.toLowerCase() ??
      createHash('sha256').update(`${this.#transfers.size}:${input.to}:${input.amountMinor}:${blockNumber}`).digest('hex');
    const transfer: Trc20Transfer = {
      txHash,
      logIndex: input.logIndex ?? 0,
      tokenContract: input.tokenContract ?? this.tokenContract,
      fromAddress: input.from ?? fakeTronAddress('sender'),
      toAddress: input.to,
      amountMinor: input.amountMinor,
      blockNumber,
      blockTime: new Date(Number(1_700_000_000_000n + blockNumber * 3_000n)),
      receiptStatus: input.receiptStatus ?? 'SUCCESS',
    };
    this.#transfers.set(key(transfer.txHash, transfer.logIndex), transfer);
    return transfer;
  }

  /** Advances the head (and with it the solidified line) by `blocks`. */
  advance(blocks: bigint): void {
    this.#head += blocks;
  }

  /** Mines enough blocks for everything currently known to be solidified. */
  solidifyAll(): void {
    this.#head += this.solidificationLag + 1n;
  }

  /** A reorg: the transfer was never in the canonical chain after all (STATE_MACHINES §11 T3). */
  orphan(txHash: string, logIndex = 0): void {
    this.#transfers.delete(key(txHash, logIndex));
  }

  get(txHash: string, logIndex: number): Trc20Transfer | null {
    return this.#transfers.get(key(txHash, logIndex)) ?? null;
  }

  list(address: string, contract: string, sinceBlock: bigint): readonly Trc20Transfer[] {
    return [...this.#transfers.values()]
      .filter((t) => t.toAddress === address && t.tokenContract === contract && t.blockNumber >= sinceBlock)
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }
}

export interface FakeTronProviderOptions {
  /** This provider is this many blocks behind the chain — a lagging node still catching up. */
  readonly lagBlocks?: bigint;
  /** Transfers this provider claims not to know (`txHash` or `txHash:logIndex`). */
  readonly blind?: Iterable<string>;
  /** Rewrites what this provider reports, so two providers can disagree about the same transfer (D-05). */
  readonly distort?: (transfer: Trc20Transfer) => Trc20Transfer;
  /** Every call fails with this error, simulating an unreachable node. */
  readonly failWith?: Error;
}

/**
 * A `TronProvider` reading one `FakeTronChain` through its own imperfect view: it can lag, be blind to a
 * transaction, distort what it reports, or fail outright — which is how the tests produce provider
 * disagreement, unfinalized transfers and reorgs without touching the network.
 */
export class FakeTronProvider implements TronProvider {
  readonly name: string;
  readonly chain: FakeTronChain;
  lagBlocks: bigint;
  readonly blind: Set<string>;
  distort: ((transfer: Trc20Transfer) => Trc20Transfer) | undefined;
  failWith: Error | undefined;
  /** Calls made, so a test can assert that a scan did not re-read what it already had. */
  calls = { latest: 0, solidified: 0, list: 0, get: 0 };

  constructor(name: string, chain: FakeTronChain, opts: FakeTronProviderOptions = {}) {
    this.name = name;
    this.chain = chain;
    this.lagBlocks = opts.lagBlocks ?? 0n;
    this.blind = new Set([...(opts.blind ?? [])].map((s) => s.toLowerCase()));
    this.distort = opts.distort;
    this.failWith = opts.failWith;
  }

  /** This provider stops seeing the transfer (blind) — the other one still does. */
  hide(txHash: string, logIndex?: number): void {
    this.blind.add(logIndex === undefined ? txHash.toLowerCase() : key(txHash, logIndex));
  }

  /** Undoes `hide`: the provider catches up and reports the transfer again. */
  unhide(txHash: string, logIndex?: number): void {
    this.blind.delete(txHash.toLowerCase());
    if (logIndex !== undefined) this.blind.delete(key(txHash, logIndex));
  }

  #check(): void {
    if (this.failWith) throw this.failWith;
  }

  #sees(t: Trc20Transfer): boolean {
    if (this.blind.has(t.txHash.toLowerCase()) || this.blind.has(key(t.txHash, t.logIndex))) return false;
    return t.blockNumber <= this.#head();
  }

  #head(): bigint {
    const h = this.chain.head - this.lagBlocks;
    return h > 0n ? h : 0n;
  }

  #report(t: Trc20Transfer): Trc20Transfer {
    return this.distort ? this.distort(t) : t;
  }

  async getLatestBlockNumber(): Promise<bigint> {
    this.#check();
    this.calls.latest += 1;
    return this.#head();
  }

  async getSolidifiedBlockNumber(): Promise<bigint> {
    this.#check();
    this.calls.solidified += 1;
    const s = this.#head() - this.chain.solidificationLag;
    return s > 0n ? s : 0n;
  }

  async listIncomingTransfers(input: { address: string; contract: string; sinceBlock: bigint; limit?: number }): Promise<readonly Trc20Transfer[]> {
    this.#check();
    this.calls.list += 1;
    const rows = this.chain.list(input.address, input.contract, input.sinceBlock).filter((t) => this.#sees(t));
    return rows.slice(0, input.limit ?? 200).map((t) => this.#report(t));
  }

  async getTransfer(txHash: string, logIndex: number): Promise<Trc20Transfer | null> {
    this.#check();
    this.calls.get += 1;
    const t = this.chain.get(txHash, logIndex);
    if (!t || !this.#sees(t)) return null;
    return this.#report(t);
  }
}
