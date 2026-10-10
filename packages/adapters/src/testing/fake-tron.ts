import { createHash } from 'node:crypto';
import { DomainError, encodeTronAddress } from '@inrp2p/kernel';
import type { BalanceReading } from '../chain.ts';
import type { Trc20Transfer, TransferLookup, TransferWindow, TronProvider, TronTransferWindowQuery, TxEvidence } from '../tron.ts';
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
  /**
   * When each block was mined, in real time: a transfer happens when it is added, as on the real chain. Whose reserve a
   * deposit to the shared address is depends on a wallet being on file before the transfer (D-17), so a fixed epoch in
   * the past would make every wallet look registered after every transfer.
   */
  #minedAt = new Map<bigint, Date>();
  #head: bigint;
  /** TRX (sun) per address, for observations of the energy an outflow needs. */
  readonly trx = new Map<string, bigint>();
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
      blockTime: this.#timeOf(blockNumber),
      receiptStatus: input.receiptStatus ?? 'SUCCESS',
    };
    this.#transfers.set(key(transfer.txHash, transfer.logIndex), transfer);
    return transfer;
  }

  #timeOf(block: bigint): Date {
    let at = this.#minedAt.get(block);
    if (!at) {
      at = new Date();
      this.#minedAt.set(block, at);
    }
    return at;
  }

  /** Advances the head (and with it the solidified line) by `blocks`. */
  advance(blocks: bigint): void {
    this.#head += blocks;
  }

  /** Mines enough blocks for everything currently known to be solidified. */
  solidifyAll(): void {
    this.#head += this.solidificationLag + 1n;
  }

  /**
   * The transaction was re-executed in the canonical chain and failed (a reorg onto a state where the call reverts):
   * its receipt now says so and it keeps no Transfer log. An index never lists a failed transfer, so this is how a
   * test reaches a transfer that was detected as successful and is failed at confirmation.
   */
  fail(txHash: string, logIndex = 0): void {
    const t = this.#transfers.get(key(txHash, logIndex));
    if (t) this.#transfers.set(key(txHash, logIndex), { ...t, receiptStatus: 'FAILED' });
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

  /** USDT of `address` as of `atBlock`: incoming minus outgoing successful transfers of the chain's contract. */
  balanceOf(address: string, atBlock: bigint = this.#head): bigint {
    let sum = 0n;
    for (const t of this.#transfers.values()) {
      if (t.receiptStatus !== 'SUCCESS' || t.tokenContract !== this.tokenContract || t.blockNumber > atBlock) continue;
      if (t.toAddress === address) sum += t.amountMinor;
      if (t.fromAddress === address) sum -= t.amountMinor;
    }
    return sum;
  }

  /** Every log of one transaction, by position. */
  logsOf(txHash: string): readonly Trc20Transfer[] {
    return [...this.#transfers.values()].filter((t) => t.txHash === txHash.toLowerCase()).sort((a, b) => a.logIndex - b.logIndex);
  }
}

export interface FakeTronProviderOptions {
  /** Independence group (D-05). Defaults to a group of this provider's own, i.e. an independent source. */
  readonly independenceGroup?: string;
  /** This provider is this many blocks behind the chain — a lagging node still catching up. */
  readonly lagBlocks?: bigint;
  /** Transfers this provider claims not to know (`txHash` or `txHash:logIndex`). */
  readonly blind?: Iterable<string>;
  /** Rewrites what this provider reports, so two providers can disagree about the same transfer (D-05). */
  readonly distort?: (transfer: Trc20Transfer) => Trc20Transfer;
  /** Every call fails with this error, simulating an unreachable node. */
  readonly failWith?: Error;
  /**
   * Window reads stop short of this block: everything below it is reported, and the read says it is incomplete —
   * an interrupted page, a receipt that could not be fetched (A2).
   */
  readonly incompleteFrom?: bigint;
}

/**
 * A `TronProvider` reading one `FakeTronChain` through its own imperfect view: it can lag, be blind to a
 * transaction, distort what it reports, or fail outright — which is how the tests produce provider
 * disagreement, unfinalized transfers and reorgs without touching the network.
 */
export class FakeTronProvider implements TronProvider {
  readonly name: string;
  readonly independenceGroup: string;
  readonly chain: FakeTronChain;
  lagBlocks: bigint;
  readonly blind: Set<string>;
  distort: ((transfer: Trc20Transfer) => Trc20Transfer) | undefined;
  failWith: Error | undefined;
  /** See `FakeTronProviderOptions.incompleteFrom`. */
  incompleteFrom: bigint | undefined;
  /** Calls made, so a test can assert that a scan did not re-read what it already had. */
  calls = { latest: 0, solidified: 0, list: 0, get: 0 };

  constructor(name: string, chain: FakeTronChain, opts: FakeTronProviderOptions = {}) {
    this.name = name;
    this.independenceGroup = opts.independenceGroup ?? `group-${name}`;
    this.chain = chain;
    this.lagBlocks = opts.lagBlocks ?? 0n;
    this.blind = new Set([...(opts.blind ?? [])].map((s) => s.toLowerCase()));
    this.distort = opts.distort;
    this.failWith = opts.failWith;
    this.incompleteFrom = opts.incompleteFrom;
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

  async readIncomingTransfers(input: TronTransferWindowQuery): Promise<TransferWindow> {
    this.#check();
    this.calls.list += 1;
    const cut = this.incompleteFrom !== undefined && this.incompleteFrom <= input.untilBlock ? this.incompleteFrom : null;
    const last = cut === null ? input.untilBlock : cut - 1n;
    const rows = this.chain
      .list(input.address, input.contract, input.sinceBlock)
      .filter((t) => this.#sees(t) && t.receiptStatus === 'SUCCESS' && t.amountMinor > 0n && t.blockNumber <= last);
    return {
      transfers: rows.map((t) => this.#report(t)),
      complete: cut === null,
      completeThrough: cut === null ? input.untilBlock : (last < input.sinceBlock - 1n ? input.sinceBlock - 1n : last),
      ...(cut === null ? {} : { incompleteReason: `${this.name} could not read past block ${cut}` }),
      pages: 1,
      requests: 1,
    };
  }

  async getTransaction(txHash: string): Promise<TxEvidence> {
    this.#check();
    this.calls.get += 1;
    const logs = this.chain.logsOf(txHash).filter((t) => this.#sees(t));
    if (logs.length === 0) return { status: 'NOT_FOUND', txHash: txHash.toLowerCase() };
    const first = logs[0]!;
    const success = logs.every((t) => t.receiptStatus === 'SUCCESS');
    return {
      status: 'FOUND',
      txHash: first.txHash,
      blockNumber: first.blockNumber,
      blockTime: first.blockTime,
      result: success ? 'SUCCESS' : 'REVERT',
      success,
      logs: success ? logs.map((t) => ({ index: t.logIndex, kind: 'TRANSFER' as const, transfer: this.#report(t) })) : [],
    };
  }

  /** Balance at this provider's solidified head; `balanceSkew` lets a test make two providers disagree. */
  balanceSkew = 0n;
  async getSolidifiedBalance(address: string, contract: string): Promise<BalanceReading> {
    this.#check();
    if (contract !== this.chain.tokenContract) return { balanceMinor: 0n, solidifiedBlock: await this.getSolidifiedBlockNumber(), trxSun: null };
    const solidified = await this.getSolidifiedBlockNumber();
    const balance = this.chain.balanceOf(address, solidified) + this.balanceSkew;
    return { balanceMinor: balance < 0n ? 0n : balance, solidifiedBlock: solidified, trxSun: this.chain.trx.get(address) ?? 0n };
  }

  async getTransfer(txHash: string, logIndex: number): Promise<TransferLookup> {
    this.#check();
    this.calls.get += 1;
    const t = this.chain.get(txHash, logIndex);
    if (!t || !this.#sees(t)) {
      const others = this.chain.logsOf(txHash).filter((x) => this.#sees(x));
      if (others.length > 0) throw new DomainError('CHAIN_EVIDENCE_INVALID', `transaction has no Transfer at log ${logIndex}`);
      return { status: 'NOT_FOUND' };
    }
    if (t.receiptStatus === 'FAILED') return { status: 'TX_FAILED', txHash: t.txHash, blockNumber: t.blockNumber, blockTime: t.blockTime, result: 'REVERT' };
    return { status: 'FOUND', transfer: this.#report(t) };
  }
}
