import { DomainError, type TronAddress } from '@inrp2p/kernel';
import type { TronReferenceBlock } from './tron-tx.ts';

/**
 * What the signer needs from the chain to send (ADR 0017 §4), one provider at a time. Like `TronProvider`, a gateway
 * returns facts and never decides: whether an attempt landed, failed or can no longer land is decided by
 * `TronSendNetwork` from every configured provider, and by the domain from that.
 *
 * Endpoints (TRON HTTP API): `/walletsolidity/getnowblock` (the solidified head, the anchor of every transaction),
 * `/wallet/getchainparameters` (what energy, bandwidth and account creation cost), `/wallet/getaccount` and
 * `/wallet/getaccountresource` (an address's TRX, whether it exists, its free bandwidth),
 * `/wallet/triggerconstantcontract` (the energy a USDT transfer will burn, simulated), `/wallet/broadcasthex`,
 * `/walletsolidity/gettransactioninfobyid` and `/wallet/gettransactioninfobyid` (the outcome, final or not), and
 * `/walletsolidity/gettransactionbyid` (what a TRX deposit transferred).
 */
export type SolidifiedHead = TronReferenceBlock;

export interface ChainFeeParameters {
  /** sun per unit of energy burned (`getEnergyFee`). */
  readonly energyPriceSun: bigint;
  /** sun per byte of bandwidth burned (`getTransactionFee`). */
  readonly bandwidthPriceSun: bigint;
  /** burned for the bandwidth of a transfer that creates an account (`getCreateAccountFee`). */
  readonly createAccountFeeSun: bigint;
  /** burned for creating an account by a system contract — a TRX transfer to a new address (`getCreateNewAccountFeeInSystemContract`). */
  readonly createNewAccountFeeSun: bigint;
  /** bytes of free bandwidth an activated account gets a day (`getFreeNetLimit`). */
  readonly freeNetLimit: number;
}

export interface TronAccountState {
  readonly address: TronAddress;
  /** False for an address the chain has never seen TRX at (not activated). */
  readonly exists: boolean;
  readonly balanceSun: bigint;
  readonly freeNetLimit: number;
  readonly freeNetUsed: number;
}

export type EnergyEstimate = { readonly ok: true; readonly energy: bigint } | { readonly ok: false; readonly reason: string };

export type BroadcastAnswer =
  | { readonly accepted: true; readonly duplicate: boolean }
  | { readonly accepted: false; readonly code: string; readonly message: string };

export interface TxFinalFacts {
  readonly blockNumber: bigint;
  readonly blockTime: Date;
  readonly success: boolean;
  /** `SUCCESS`, `REVERT`, `OUT_OF_ENERGY`, … (TRX transfers have no receipt result: `SUCCESS` when included). */
  readonly result: string;
  /** TRX burned in all (sun), and its parts. */
  readonly feeSun: bigint;
  readonly energyUsed: bigint;
  readonly energyFeeSun: bigint;
  readonly netFeeSun: bigint;
}

export type TxOutcomeAnswer =
  | ({ readonly status: 'FINAL' } & TxFinalFacts)
  /** In a block above the solidified head: may still be reorganized away. */
  | { readonly status: 'PENDING' }
  | { readonly status: 'NOT_FOUND' };

export interface TrxTransferFacts {
  readonly txid: string;
  readonly from: TronAddress;
  readonly to: TronAddress;
  readonly amountSun: bigint;
  readonly blockNumber: bigint;
  readonly blockTime: Date;
}

export type TrxTransferAnswer =
  | { readonly status: 'FINAL'; readonly transfer: TrxTransferFacts }
  | { readonly status: 'PENDING' }
  | { readonly status: 'NOT_FOUND' }
  /** Final, but not a successful plain TRX transfer (another contract, or it failed). */
  | { readonly status: 'NOT_A_TRX_TRANSFER'; readonly reason: string };

export interface TronSendGateway {
  readonly name: string;
  readonly independenceGroup: string;
  solidifiedHead(): Promise<SolidifiedHead>;
  chainFeeParameters(): Promise<ChainFeeParameters>;
  accountState(address: string): Promise<TronAccountState>;
  estimateTrc20Energy(input: { from: string; contract: string; to: string; amountMinor: bigint }): Promise<EnergyEstimate>;
  broadcastHex(signedHex: string): Promise<BroadcastAnswer>;
  transactionOutcome(txid: string): Promise<TxOutcomeAnswer>;
  trxTransfer(txid: string): Promise<TrxTransferAnswer>;
}

// ---------------------------------------------------------------------------------------------------------------

export type CombinedOutcome =
  | { readonly status: 'FINAL'; readonly facts: TxFinalFacts; readonly agreedBy: readonly string[]; readonly agreedGroups: readonly string[]; readonly unavailable: readonly string[] }
  | { readonly status: 'PENDING'; readonly seenBy: readonly string[] }
  /** Every configured provider answered, and none knows the transaction. */
  | { readonly status: 'NOT_FOUND' }
  /** Providers that answered contradict each other: never resolved by majority. */
  | { readonly status: 'CONFLICT'; readonly reason: string }
  /** Not every provider answered, and those that did do not know it: nothing can be concluded. */
  | { readonly status: 'UNKNOWN'; readonly reason: string };

export type ExpiryProof = { readonly proved: true; readonly by: readonly string[] } | { readonly proved: false; readonly reason: string };

const sameFacts = (a: TxFinalFacts, b: TxFinalFacts): boolean =>
  a.blockNumber === b.blockNumber && a.success === b.success && a.result === b.result && a.feeSun === b.feeSun;

const settle = async <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/**
 * Every configured gateway, combined (ADR 0017 §4). A broadcast goes to all of them — the same bytes, so a duplicate is
 * harmless and one unreachable node never decides whether the transfer is attempted. An outcome is FINAL when a
 * provider reports the transaction in a solidified block and none contradicts it; it is NOT_FOUND only when every one
 * of them answered and none knows it. An attempt is proved dead only when, in addition, every provider's solidified
 * head is past its expiration: from then on no block can include it, anywhere.
 */
export class TronSendNetwork {
  readonly gateways: readonly TronSendGateway[];

  constructor(gateways: readonly TronSendGateway[]) {
    if (gateways.length === 0) throw new DomainError('INVALID_ARGUMENT', 'at least one TRON gateway is needed to send');
    const names = new Set(gateways.map((g) => g.name));
    if (names.size !== gateways.length) throw new DomainError('INVALID_ARGUMENT', 'TRON gateway names must be unique');
    this.gateways = gateways;
  }

  get names(): readonly string[] {
    return this.gateways.map((g) => g.name);
  }

  async #first<T>(what: string, ask: (g: TronSendGateway) => Promise<T>): Promise<{ value: T; by: string }> {
    const errors: string[] = [];
    for (const g of this.gateways) {
      const r = await settle(ask(g));
      if (r.ok) return { value: r.value, by: g.name };
      errors.push(`${g.name}: ${r.error}`);
    }
    throw new DomainError('CHAIN_PROVIDER_ERROR', `no TRON provider answered ${what}: ${errors.join('; ')}`, { transient: true });
  }

  /** The anchor for a new transaction: a solidified block, which no reorganization can remove. */
  referenceBlock(): Promise<SolidifiedHead> {
    return this.#first('the solidified head', (g) => g.solidifiedHead()).then((r) => r.value);
  }

  feeParameters(): Promise<{ value: ChainFeeParameters; by: string }> {
    return this.#first('the chain parameters', (g) => g.chainFeeParameters());
  }

  /**
   * The state of an address as the most cautious provider sees it: the lowest TRX balance, and "not activated" if any
   * provider does not know the account. The signer tops up against this and never against an optimistic reading.
   */
  async accountState(address: string): Promise<TronAccountState> {
    const answers = await Promise.all(this.gateways.map((g) => settle(g.accountState(address))));
    const ok = answers.filter((a): a is { ok: true; value: TronAccountState } => a.ok).map((a) => a.value);
    if (ok.length === 0) {
      const errors = answers.map((a, i) => `${this.gateways[i]!.name}: ${a.ok ? 'answered' : a.error}`).join('; ');
      throw new DomainError('CHAIN_PROVIDER_ERROR', `no TRON provider answered for ${address}: ${errors}`, { transient: true });
    }
    return ok.reduce((m, a) => ({
      address: m.address,
      exists: m.exists && a.exists,
      balanceSun: a.balanceSun < m.balanceSun ? a.balanceSun : m.balanceSun,
      freeNetLimit: Math.min(m.freeNetLimit, a.freeNetLimit),
      freeNetUsed: Math.max(m.freeNetUsed, a.freeNetUsed),
    }));
  }

  /** The energy a transfer will burn: the highest any provider simulates. */
  async estimateTrc20Energy(input: { from: string; contract: string; to: string; amountMinor: bigint }): Promise<EnergyEstimate> {
    const answers = await Promise.all(this.gateways.map((g) => settle(g.estimateTrc20Energy(input))));
    const ok = answers.filter((a): a is { ok: true; value: EnergyEstimate } => a.ok).map((a) => a.value);
    if (ok.length === 0) return { ok: false, reason: 'no provider could simulate the transfer' };
    const estimates = ok.filter((e): e is { ok: true; energy: bigint } => e.ok);
    if (estimates.length === 0) return ok[0]!;
    return { ok: true, energy: estimates.reduce((m, e) => (e.energy > m ? e.energy : m), 0n) };
  }

  /** Sends the same signed bytes to every provider; the result says who took it. Never throws for a provider error. */
  async broadcast(signedHex: string): Promise<{ accepted: readonly string[]; rejected: readonly { by: string; code: string; message: string }[]; unreachable: readonly string[] }> {
    const answers = await Promise.all(this.gateways.map(async (g) => ({ g, r: await settle(g.broadcastHex(signedHex)) })));
    const accepted: string[] = [];
    const rejected: { by: string; code: string; message: string }[] = [];
    const unreachable: string[] = [];
    for (const { g, r } of answers) {
      if (!r.ok) unreachable.push(`${g.name}: ${r.error}`.slice(0, 200));
      else if (r.value.accepted) accepted.push(g.name);
      else rejected.push({ by: g.name, code: r.value.code, message: r.value.message.slice(0, 200) });
    }
    return { accepted, rejected, unreachable };
  }

  async outcome(txid: string): Promise<CombinedOutcome> {
    const answers = await Promise.all(this.gateways.map(async (g) => ({ g, r: await settle(g.transactionOutcome(txid)) })));
    const finals = answers.filter((a) => a.r.ok && a.r.value.status === 'FINAL') as { g: TronSendGateway; r: { ok: true; value: { status: 'FINAL' } & TxFinalFacts } }[];
    const unavailable = answers.filter((a) => !a.r.ok).map((a) => a.g.name);
    if (finals.length > 0) {
      const first = finals[0]!.r.value;
      const disagree = finals.find((f) => !sameFacts(f.r.value, first));
      if (disagree) return { status: 'CONFLICT', reason: `${finals[0]!.g.name} and ${disagree.g.name} report different outcomes for ${txid}` };
      const facts: TxFinalFacts = {
        blockNumber: first.blockNumber, blockTime: first.blockTime, success: first.success, result: first.result,
        feeSun: first.feeSun, energyUsed: first.energyUsed, energyFeeSun: first.energyFeeSun, netFeeSun: first.netFeeSun,
      };
      return {
        status: 'FINAL', facts, agreedBy: finals.map((f) => f.g.name),
        agreedGroups: [...new Set(finals.map((f) => f.g.independenceGroup.toLowerCase()))], unavailable,
      };
    }
    const pending = answers.filter((a) => a.r.ok && a.r.value.status === 'PENDING').map((a) => a.g.name);
    if (pending.length > 0) return { status: 'PENDING', seenBy: pending };
    if (unavailable.length > 0) return { status: 'UNKNOWN', reason: `unavailable: ${unavailable.join(', ')}` };
    return { status: 'NOT_FOUND' };
  }

  /**
   * Proof that a transaction can never land: every provider answered, none knows it, and every provider's solidified
   * head is a block later than its expiration plus `marginMs`. A node accepts a transaction only into a block whose
   * time is before its expiration; once a solidified block is past it, every block that could have held it is final.
   */
  async proveExpired(txid: string, expiration: number, marginMs = 60_000): Promise<ExpiryProof> {
    const answers = await Promise.all(this.gateways.map(async (g) => ({
      g,
      head: await settle(g.solidifiedHead()),
      out: await settle(g.transactionOutcome(txid)),
    })));
    for (const a of answers) {
      if (!a.head.ok) return { proved: false, reason: `${a.g.name} did not report its solidified head: ${a.head.error}` };
      if (!a.out.ok) return { proved: false, reason: `${a.g.name} did not answer for ${txid}: ${a.out.error}` };
      if (a.out.value.status !== 'NOT_FOUND') return { proved: false, reason: `${a.g.name} knows ${txid} (${a.out.value.status})` };
      if (a.head.value.timestamp <= expiration + marginMs) return { proved: false, reason: `${a.g.name}'s solidified head is not yet past the expiration` };
    }
    return { proved: true, by: answers.map((a) => a.g.name) };
  }

  /** What a TRX deposit transferred, final, from every provider that knows it — agreeing, or refused. */
  async trxTransfer(txid: string): Promise<TrxTransferAnswer & { readonly agreedGroups?: readonly string[] }> {
    const answers = await Promise.all(this.gateways.map(async (g) => ({ g, r: await settle(g.trxTransfer(txid)) })));
    const ok = answers.filter((a) => a.r.ok) as { g: TronSendGateway; r: { ok: true; value: TrxTransferAnswer } }[];
    if (ok.length === 0) {
      // Which provider refused and why (a rate limit, a timeout): without it the failure reads like a missing transaction.
      const errors = answers.map((a) => `${a.g.name}: ${a.r.ok ? 'answered' : a.r.error}`).join('; ');
      throw new DomainError('CHAIN_PROVIDER_ERROR', `no TRON provider answered for ${txid}: ${errors}`, { transient: true });
    }
    const finals = ok.filter((a) => a.r.value.status === 'FINAL') as { g: TronSendGateway; r: { ok: true; value: { status: 'FINAL'; transfer: TrxTransferFacts } } }[];
    const refused = ok.find((a) => a.r.value.status === 'NOT_A_TRX_TRANSFER');
    if (refused) return refused.r.value;
    if (finals.length > 0) {
      const t = finals[0]!.r.value.transfer;
      const differ = finals.find((f) => f.r.value.transfer.from !== t.from || f.r.value.transfer.to !== t.to || f.r.value.transfer.amountSun !== t.amountSun || f.r.value.transfer.blockNumber !== t.blockNumber);
      if (differ) throw new DomainError('CHAIN_EVIDENCE_INVALID', `providers report different facts for ${txid}`);
      return { status: 'FINAL', transfer: t, agreedGroups: [...new Set(finals.map((f) => f.g.independenceGroup.toLowerCase()))] };
    }
    if (ok.some((a) => a.r.value.status === 'PENDING')) return { status: 'PENDING' };
    return { status: 'NOT_FOUND' };
  }
}
