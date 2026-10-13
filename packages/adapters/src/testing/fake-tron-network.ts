import { createHash, randomBytes } from 'node:crypto';
import { DomainError, type TronAddress, normalizeTronAddress } from '@inrp2p/kernel';
import type {
  BroadcastAnswer, ChainFeeParameters, EnergyEstimate, SolidifiedHead, TronAccountState, TronSendGateway, TrxTransferAnswer, TxOutcomeAnswer,
} from '../tron-send.ts';
import { decodeTronTransaction, recoverTxSigner } from '../tron-tx.ts';
import type { FakeChainVerifier } from './fake-chain.ts';

/**
 * A TRON network for tests that behaves like the real one where the signer depends on it (ADR 0017 §4):
 *
 * - a broadcast is decoded from its bytes, its signature must recover the sender, its reference block must be one of
 *   this chain's blocks, it must not be expired, and a second broadcast of the same bytes is a duplicate;
 * - a block includes what is pending and not expired; a TRX transfer to a new address activates it and burns the
 *   account-creation fees; a USDT transfer burns energy at the sender (more to a recipient that never held USDT) and
 *   fails OUT_OF_ENERGY, burning what it may, when the sender's TRX or its fee limit does not cover it;
 * - USDT that moves is added to the shared `FakeChainVerifier`, so settlement verifies it exactly like any transfer.
 *
 * Faults are explicit: a transaction can be swallowed (accepted and never included), a gateway can be down, can time
 * out after delivering a broadcast, or can lag. Time is the chain's: each block is three seconds after the last.
 */
export interface FakeNetworkParameters {
  energyPriceSun: bigint;
  bandwidthPriceSun: bigint;
  createAccountFeeSun: bigint;
  createNewAccountFeeSun: bigint;
  freeNetLimit: number;
  /** Energy of a USDT transfer to an address that holds USDT, and to one that never has. */
  energyToHolder: bigint;
  energyToNewHolder: bigint;
}

interface Account {
  trx: bigint;
  exists: boolean;
  freeNetUsed: number;
}

interface Mined {
  readonly txid: string;
  readonly block: bigint;
  readonly time: number;
  readonly success: boolean;
  readonly result: string;
  readonly feeSun: bigint;
  readonly energyUsed: bigint;
  readonly energyFeeSun: bigint;
  readonly netFeeSun: bigint;
  readonly trx?: { from: TronAddress; to: TronAddress; amountSun: bigint };
}

export class FakeTronNetwork {
  readonly params: FakeNetworkParameters;
  readonly chain: FakeChainVerifier;
  readonly #accounts = new Map<string, Account>();
  readonly #blocks = new Map<bigint, { id: string; time: number }>();
  readonly #pending = new Map<string, string>(); // txid → signed hex
  readonly #mined = new Map<string, Mined>();
  /** Transactions accepted and never included (a node that dropped them). */
  readonly swallowed = new Set<string>();
  /** Every broadcast that reached the network, in order — what tests count to prove nothing was sent twice. */
  readonly received: string[] = [];
  #head: bigint;
  #time: number;
  /** Blocks that are not solidified yet (0: everything mined is final at once). */
  solidificationLag = 0n;

  constructor(chain: FakeChainVerifier, params: Partial<FakeNetworkParameters> = {}) {
    this.chain = chain;
    this.params = {
      energyPriceSun: 100n, bandwidthPriceSun: 1000n, createAccountFeeSun: 100_000n, createNewAccountFeeSun: 1_000_000n, freeNetLimit: 600,
      energyToHolder: 64_285n, energyToNewHolder: 130_285n, ...params,
    };
    this.#head = 70_000_000n;
    this.#time = Date.now();
    this.#blocks.set(this.#head, { id: this.#blockId(this.#head), time: this.#time });
  }

  #blockId(n: bigint): string {
    const num = Buffer.alloc(8);
    num.writeBigUInt64BE(n);
    return Buffer.concat([num, randomBytes(24)]).toString('hex');
  }

  #account(address: string): Account {
    const a = normalizeTronAddress(address);
    let acc = this.#accounts.get(a);
    if (!acc) {
      acc = { trx: 0n, exists: false, freeNetUsed: 0 };
      this.#accounts.set(a, acc);
    }
    return acc;
  }

  get headTime(): number {
    return this.#time;
  }

  get head(): bigint {
    return this.#head;
  }

  trxOf(address: string): bigint {
    return this.#account(address).trx;
  }

  isActivated(address: string): boolean {
    return this.#account(address).exists;
  }

  /**
   * TRX arriving from outside the exchange (a trader's deposit, the owner's top-up): mined and final at once. Returns
   * the transaction id, which the deposit is then claimed by.
   */
  externalTrxTransfer(input: { from: string; to: string; amountSun: bigint }): string {
    const txid = createHash('sha256').update(`external:${this.#mined.size}:${input.from}:${input.to}:${input.amountSun}:${randomBytes(4).toString('hex')}`).digest('hex');
    this.#mine([]);
    // A tracked account pays it (TRX leaving the budget wallet behind the exchange's back); any other sender is outside.
    const from = this.#account(input.from);
    if (from.trx >= input.amountSun) from.trx -= input.amountSun;
    const to = this.#account(input.to);
    const fee = to.exists ? 0n : this.params.createNewAccountFeeSun + this.params.createAccountFeeSun;
    to.trx += input.amountSun;
    to.exists = true;
    this.#mined.set(txid, {
      txid, block: this.#head, time: this.#time, success: true, result: 'SUCCESS', feeSun: fee, energyUsed: 0n, energyFeeSun: 0n, netFeeSun: 0n,
      trx: { from: normalizeTronAddress(input.from), to: normalizeTronAddress(input.to), amountSun: input.amountSun },
    });
    return txid;
  }

  /** Mines `count` blocks: everything pending and still valid is included in the first. */
  mine(count = 1): void {
    for (let i = 0; i < count; i++) this.#mine([...this.#pending.entries()].filter(([txid]) => !this.swallowed.has(txid)));
  }

  /** Lets chain time pass without anything included (blocks still come, empty). */
  advance(ms: number): void {
    const blocks = Math.max(1, Math.ceil(ms / 3000));
    for (let i = 0; i < blocks; i++) this.#mine([]);
  }

  #mine(include: [string, string][]): void {
    this.#head += 1n;
    this.#time += 3000;
    this.#blocks.set(this.#head, { id: this.#blockId(this.#head), time: this.#time });
    for (const [txid, signedHex] of include) {
      this.#pending.delete(txid);
      const tx = decodeTronTransaction({ signedHex });
      if (tx.expiration <= this.#time) continue; // too late for any block from now on: dropped
      this.#apply(txid, tx, signedHex.length / 2);
    }
  }

  #bandwidth(from: Account, bytes: number): bigint {
    if (from.exists && this.params.freeNetLimit - from.freeNetUsed >= bytes) {
      from.freeNetUsed += bytes;
      return 0n;
    }
    return BigInt(bytes) * this.params.bandwidthPriceSun;
  }

  #apply(txid: string, tx: ReturnType<typeof decodeTronTransaction>, bytes: number): void {
    const c = tx.contract;
    const from = this.#account(c.from);
    if (c.kind === 'TRX') {
      const to = this.#account(c.to);
      const create = to.exists ? 0n : this.params.createNewAccountFeeSun + this.params.createAccountFeeSun;
      const net = create > 0n ? 0n : this.#bandwidth(from, bytes);
      const fee = create + net;
      if (from.trx < c.amountSun + fee) {
        this.#mined.set(txid, { txid, block: this.#head, time: this.#time, success: false, result: 'FAILED', feeSun: 0n, energyUsed: 0n, energyFeeSun: 0n, netFeeSun: 0n });
        return;
      }
      from.trx -= c.amountSun + fee;
      to.trx += c.amountSun;
      to.exists = true;
      this.#mined.set(txid, { txid, block: this.#head, time: this.#time, success: true, result: 'SUCCESS', feeSun: fee, energyUsed: 0n, energyFeeSun: 0n, netFeeSun: net, trx: { from: c.from, to: c.to, amountSun: c.amountSun } });
      return;
    }
    const net = this.#bandwidth(from, bytes);
    const holder = this.chain.balanceOf(c.to) > 0n;
    const energy = holder ? this.params.energyToHolder : this.params.energyToNewHolder;
    const energyFee = energy * this.params.energyPriceSun;
    const cap = tx.feeLimitSun ?? 0n;
    const usdt = this.chain.balanceOf(c.from);
    if (from.trx < net) {
      // Not even its bandwidth: a node never includes it.
      return;
    }
    from.trx -= net;
    if (from.trx < energyFee || cap < energyFee) {
      const burned = from.trx < cap ? from.trx : cap;
      from.trx -= burned;
      this.#mined.set(txid, { txid, block: this.#head, time: this.#time, success: false, result: 'OUT_OF_ENERGY', feeSun: burned + net, energyUsed: burned / this.params.energyPriceSun, energyFeeSun: burned, netFeeSun: net });
      return;
    }
    if (usdt < c.amountMinor || c.contract !== this.chain.tokenContract) {
      // The contract reverts (not enough USDT): the energy spent up to the revert is burned.
      const burned = energyFee / 4n;
      from.trx -= burned;
      this.#mined.set(txid, { txid, block: this.#head, time: this.#time, success: false, result: 'REVERT', feeSun: burned + net, energyUsed: energy / 4n, energyFeeSun: burned, netFeeSun: net });
      return;
    }
    from.trx -= energyFee;
    this.chain.add({ txHash: txid, logIndex: 0, from: c.from, to: c.to, amountMinor: c.amountMinor, solidified: true });
    this.#mined.set(txid, { txid, block: this.#head, time: this.#time, success: true, result: 'SUCCESS', feeSun: energyFee + net, energyUsed: energy, energyFeeSun: energyFee, netFeeSun: net });
  }

  // ---- what a node answers ---------------------------------------------------------------------------------------

  solidifiedHead(lag = 0n): SolidifiedHead {
    const n = this.#head - this.solidificationLag - lag;
    const b = this.#blocks.get(n) ?? this.#blocks.get(this.#head)!;
    return { number: n, id: b.id, timestamp: b.time };
  }

  broadcast(signedHex: string): BroadcastAnswer {
    let tx: ReturnType<typeof decodeTronTransaction>;
    try {
      tx = decodeTronTransaction({ signedHex });
    } catch (e) {
      return { accepted: false, code: 'OTHER_ERROR', message: (e as Error).message };
    }
    this.received.push(tx.txid);
    if (this.#mined.has(tx.txid) || this.#pending.has(tx.txid)) return { accepted: true, duplicate: true };
    if (tx.signatures.length !== 1 || recoverTxSigner(tx.txid, tx.signatures[0]!) !== tx.contract.from) return { accepted: false, code: 'SIGERROR', message: 'signature does not match the owner' };
    const ref = [...this.#blocks.entries()].find(([n, b]) => (n & 0xffffn) === (tx.refBlockNum & 0xffffn) && b.id.slice(16, 32) === Buffer.from(decodeRefHash(tx.rawDataHex)).toString('hex'));
    if (!ref) return { accepted: false, code: 'TAPOS_ERROR', message: 'reference block not on this chain' };
    if (tx.expiration <= this.#time) return { accepted: false, code: 'TRANSACTION_EXPIRATION_ERROR', message: 'expired' };
    if (tx.expiration > this.#time + 24 * 3600 * 1000) return { accepted: false, code: 'TRANSACTION_EXPIRATION_ERROR', message: 'expiration too far' };
    this.#pending.set(tx.txid, signedHex);
    return { accepted: true, duplicate: false };
  }

  outcome(txid: string, lag = 0n): TxOutcomeAnswer {
    const m = this.#mined.get(txid);
    if (!m) return { status: 'NOT_FOUND' };
    if (m.block > this.#head - this.solidificationLag - lag) return m.block > this.#head - lag ? { status: 'NOT_FOUND' } : { status: 'PENDING' };
    return { status: 'FINAL', blockNumber: m.block, blockTime: new Date(m.time), success: m.success, result: m.result, feeSun: m.feeSun, energyUsed: m.energyUsed, energyFeeSun: m.energyFeeSun, netFeeSun: m.netFeeSun };
  }

  trxTransfer(txid: string): TrxTransferAnswer {
    const m = this.#mined.get(txid);
    if (!m) return { status: 'NOT_FOUND' };
    if (!m.trx || !m.success) return { status: 'NOT_A_TRX_TRANSFER', reason: 'not a successful TRX transfer' };
    return { status: 'FINAL', transfer: { txid, from: m.trx.from, to: m.trx.to, amountSun: m.trx.amountSun, blockNumber: m.block, blockTime: new Date(m.time) } };
  }

  estimate(input: { from: string; to: string; amountMinor: bigint; contract: string }): EnergyEstimate {
    if (this.chain.balanceOf(input.from) < input.amountMinor) return { ok: false, reason: 'REVERT: balance is not sufficient' };
    return { ok: true, energy: this.chain.balanceOf(input.to) > 0n ? this.params.energyToHolder : this.params.energyToNewHolder };
  }

  accountState(address: string): TronAccountState {
    const a = this.#account(address);
    return { address: normalizeTronAddress(address), exists: a.exists, balanceSun: a.trx, freeNetLimit: a.exists ? this.params.freeNetLimit : 0, freeNetUsed: a.freeNetUsed };
  }

  feeParameters(): ChainFeeParameters {
    return {
      energyPriceSun: this.params.energyPriceSun, bandwidthPriceSun: this.params.bandwidthPriceSun, createAccountFeeSun: this.params.createAccountFeeSun,
      createNewAccountFeeSun: this.params.createNewAccountFeeSun, freeNetLimit: this.params.freeNetLimit,
    };
  }

  /** One provider's view of this network, with its own faults. */
  gateway(name: string, group = `group-${name}`): FakeTronGateway {
    return new FakeTronGateway(this, name, group);
  }
}

/** The 8 reference-hash bytes of a raw_data (field 4), for the TAPOS check. */
function decodeRefHash(rawDataHex: string): Uint8Array {
  const raw = Buffer.from(rawDataHex, 'hex');
  // field 1 (2 bytes) is first: 0a 02 xx xx, then field 4: 22 08 <8 bytes>.
  if (raw[0] !== 0x0a || raw[1] !== 0x02 || raw[4] !== 0x22 || raw[5] !== 0x08) throw new DomainError('INVALID_ARGUMENT', 'unexpected raw_data layout');
  return raw.subarray(6, 14);
}

export class FakeTronGateway implements TronSendGateway {
  readonly name: string;
  readonly independenceGroup: string;
  readonly #net: FakeTronNetwork;
  /** Every call throws (unreachable). */
  down = false;
  /** A broadcast reaches the network, then the answer is lost (a timeout after delivery). */
  timeoutAfterBroadcast = false;
  /** A broadcast is lost before it reaches the network. */
  loseBroadcast = false;
  /** Blocks this gateway is behind the chain. */
  lag = 0n;
  /** Answers FINAL with a different block for every transaction (a provider that contradicts the others). */
  liar = false;

  constructor(net: FakeTronNetwork, name: string, group: string) {
    this.#net = net;
    this.name = name;
    this.independenceGroup = group;
  }

  #up(): void {
    if (this.down) throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name} is unreachable (test)`, { transient: true });
  }

  async solidifiedHead(): Promise<SolidifiedHead> {
    this.#up();
    return this.#net.solidifiedHead(this.lag);
  }

  async chainFeeParameters(): Promise<ChainFeeParameters> {
    this.#up();
    return this.#net.feeParameters();
  }

  async accountState(address: string): Promise<TronAccountState> {
    this.#up();
    return this.#net.accountState(address);
  }

  async estimateTrc20Energy(input: { from: string; contract: string; to: string; amountMinor: bigint }): Promise<EnergyEstimate> {
    this.#up();
    return this.#net.estimate(input);
  }

  async broadcastHex(signedHex: string): Promise<BroadcastAnswer> {
    this.#up();
    if (this.loseBroadcast) throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name}: connection reset (test)`, { transient: true });
    const answer = this.#net.broadcast(signedHex);
    if (this.timeoutAfterBroadcast) throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name}: timed out (test)`, { transient: true });
    return answer;
  }

  async transactionOutcome(txid: string): Promise<TxOutcomeAnswer> {
    this.#up();
    const o = this.#net.outcome(txid, this.lag);
    if (this.liar && o.status === 'FINAL') return { ...o, blockNumber: o.blockNumber + 7n };
    return o;
  }

  async trxTransfer(txid: string): Promise<TrxTransferAnswer> {
    this.#up();
    return this.#net.trxTransfer(txid);
  }
}
