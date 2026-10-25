import { createHash, randomUUID } from 'node:crypto';
import { DomainError, type TronAddress, encodeTronAddress, normalizeTronAddress } from '@inrp2p/kernel';
import {
  GASFREE_MAINNET, type GasFreeAccount, type GasFreeChain, type GasFreePermit, type GasFreeRefusal, type GasFreeService, type GasFreeTrace,
  gasFreeAddressOf, permitDigest, recoverPermitSigner,
} from '../gasfree.ts';
import type { FakeTronNetwork } from './fake-tron-network.ts';

/** A GasFree deployment for tests: mainnet's controller and proxy, the fake chain's USDT. */
export const fakeGasFreeChain = (tokenContract: string): GasFreeChain => Object.freeze({ ...GASFREE_MAINNET, name: 'TEST' as const, usdt: normalizeTronAddress(tokenContract) });

interface Trace {
  id: string;
  state: GasFreeTrace['state'];
  txid: string | null;
  permit: GasFreePermit;
}

/**
 * GasFree for tests, behaving like the controller and its relayer where the exchange depends on them (ADR 0022): a permit
 * is checked the way the controller checks it — the owner's signature over the TIP-712 digest, its nonce, its deadline
 * by chain time, its cap against the fee in force, the account's USDT — and executed as one transaction moving the fee to
 * the provider and the value to the receiver, from the GasFree account. Nonces and fees are the controller's views on
 * the shared `FakeTronNetwork`, as the signer reads them.
 *
 * Faults are explicit: `down` (no answer, nothing taken), `loseAnswer` (taken and executed, the answer lost), `stall`
 * (taken, executed only on `finish()`), `failOnChain` (executed, the transaction reverts: nothing moves).
 */
export class FakeGasFree implements GasFreeService {
  readonly chain: GasFreeChain;
  readonly #net: FakeTronNetwork;
  readonly provider: TronAddress;
  transferFee = 1_500_000n;
  activateFee = 1_500_000n;
  down = false;
  loseAnswer = false;
  stall = false;
  failOnChain = false;
  readonly #nonces = new Map<string, bigint>();
  readonly #active = new Set<string>();
  readonly #traces = new Map<string, Trace>();
  /** Every permit taken, in order — what tests count to prove nothing was sent twice. */
  readonly taken: GasFreePermit[] = [];

  constructor(net: FakeTronNetwork, chain?: GasFreeChain) {
    this.#net = net;
    this.chain = chain ?? fakeGasFreeChain(net.chain.tokenContract);
    this.provider = encodeTronAddress(createHash('sha256').update('fake-gasfree-provider').digest().subarray(0, 20));
    const owner = (param: string) => normalizeTronAddress(param.slice(24, 64));
    net.registerView(this.chain.controller, 'nonces(address)', (p) => this.#nonces.get(owner(p)) ?? 0n);
    net.registerView(this.chain.controller, 'tokenFees(address)', () => this.transferFee);
    net.registerView(this.chain.controller, 'activateFees(address)', () => this.activateFee);
  }

  #up(): void {
    if (this.down) throw new DomainError('GASFREE_UNAVAILABLE', 'GasFree is unreachable (test)', { transient: true });
    // As GasFree does: an authorization still waiting past its deadline is dropped — it can never execute.
    for (const t of this.#traces.values()) if (t.state === 'WAITING' && t.permit.deadline * 1000n <= BigInt(this.#net.headTime)) t.state = 'FAILED';
  }

  #pending(user: string): boolean {
    return [...this.#traces.values()].some((t) => t.permit.user === user && (t.state === 'WAITING' || t.state === 'INPROGRESS'));
  }

  isActive(owner: string): boolean {
    return this.#active.has(normalizeTronAddress(owner));
  }

  async serviceProvider(): Promise<TronAddress> {
    this.#up();
    return this.provider;
  }

  async account(user: TronAddress): Promise<GasFreeAccount> {
    this.#up();
    return { gasFreeAddress: gasFreeAddressOf(user, this.chain), active: this.#active.has(user), nonce: this.#nonces.get(user) ?? 0n, allowSubmit: !this.#pending(user) };
  }

  async submit(p: GasFreePermit, signature: string, _requestId: string): Promise<GasFreeTrace | GasFreeRefusal> {
    this.#up();
    const refuse = (reason: string, message: string): GasFreeRefusal => ({ refused: true, reason, message });
    if (p.serviceProvider !== this.provider) return refuse('ProviderAddressNotMatchException', 'not this provider');
    if (p.token !== this.chain.usdt) return refuse('UnsupportedTokenException', 'only USDT');
    if (p.version !== 1n) return refuse('VersionNotSupportedException', 'version 1 only');
    if (p.deadline * 1000n <= BigInt(this.#net.headTime)) return refuse('DeadlineExceededException', 'expired');
    let signer: TronAddress;
    try {
      signer = recoverPermitSigner(permitDigest(p, this.chain), signature);
    } catch {
      return refuse('InvalidSignatureException', 'unreadable signature');
    }
    if (signer !== p.user) return refuse('InvalidSignatureException', `signed by ${signer}, not ${p.user}`);
    if (this.#pending(p.user)) return refuse('TooManyPendingTransferException', 'one at a time');
    if (p.nonce !== (this.#nonces.get(p.user) ?? 0n)) return refuse('NonceNotMatchException', `nonce ${p.nonce}, expected ${this.#nonces.get(p.user) ?? 0n}`);
    const fee = this.transferFee + (this.#active.has(p.user) ? 0n : this.activateFee);
    if (fee > p.maxFee) return refuse('MaxFeeExceededException', `fee ${fee} above ${p.maxFee}`);
    if (this.#net.chain.balanceOf(gasFreeAddressOf(p.user, this.chain)) < p.value + fee) return refuse('InsufficientBalanceException', 'not enough USDT');
    const trace: Trace = { id: randomUUID(), state: 'WAITING', txid: null, permit: p };
    this.#traces.set(trace.id, trace);
    this.taken.push(p);
    if (!this.stall) this.#execute(trace);
    if (this.loseAnswer) throw new DomainError('GASFREE_UNAVAILABLE', 'GasFree timed out (test)', { transient: true });
    return { id: trace.id, state: trace.state, txid: trace.txid };
  }

  /** Executes every stalled permit now. */
  finish(): void {
    for (const t of this.#traces.values()) if (t.state === 'WAITING') this.#execute(t);
  }

  #execute(t: Trace): void {
    const p = t.permit;
    const account = gasFreeAddressOf(p.user, this.chain);
    const txid = createHash('sha256').update(`gasfree:${t.id}`).digest('hex');
    t.txid = txid;
    // The deadline is the controller's own check, at execution.
    if (this.failOnChain || p.deadline * 1000n <= BigInt(this.#net.headTime)) {
      this.#net.mineContractCall(txid, false);
      t.state = 'FAILED';
      return;
    }
    const fee = this.transferFee + (this.#active.has(p.user) ? 0n : this.activateFee);
    this.#net.chain.add({ txHash: txid, logIndex: 0, from: account, to: this.provider, amountMinor: fee, solidified: true });
    this.#net.chain.add({ txHash: txid, logIndex: 1, from: account, to: p.receiver, amountMinor: p.value, solidified: true });
    this.#net.mineContractCall(txid, true);
    this.#nonces.set(p.user, p.nonce + 1n);
    this.#active.add(p.user);
    t.state = 'SUCCEED';
  }

  async trace(id: string): Promise<GasFreeTrace> {
    this.#up();
    const t = this.#traces.get(id);
    if (!t) throw new DomainError('GASFREE_UNAVAILABLE', `no trace ${id} (test)`, { transient: true });
    return { id: t.id, state: t.state, txid: t.txid };
  }
}
