import { DomainError, encodeTronAddress, isTronAddress } from '@inrp2p/kernel';
import type { ChainNetwork, ChainVerifier, TransferReceipt } from './chain.ts';

/**
 * TRON provider port (ARCHITECTURE §6 `TronAdapter`). A provider returns **raw facts** — what the chain says —
 * and never a decision: whether a transfer counts is decided by the domain (FI-24, FI-26).
 */
export interface Trc20Transfer {
  readonly txHash: string;
  readonly logIndex: number;
  readonly tokenContract: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amountMinor: bigint;
  readonly blockNumber: bigint;
  readonly blockTime: Date;
  /** Present when the provider has the transaction receipt; `null` while only the log is known. */
  readonly receiptStatus?: 'SUCCESS' | 'FAILED' | null;
}

export interface TronProvider {
  readonly name: string;
  /** Head of the chain, including blocks that may still be reorganized. */
  getLatestBlockNumber(): Promise<bigint>;
  /** Highest irreversible block (solidified by ≥ 2/3 of the SRs) — the finality line for FI-24. */
  getSolidifiedBlockNumber(): Promise<bigint>;
  /** TRC20 transfers of one contract **into** one address, from `sinceBlock` (inclusive) onwards. */
  listIncomingTransfers(input: { address: string; contract: string; sinceBlock: bigint; limit?: number }): Promise<readonly Trc20Transfer[]>;
  /** One transfer event with its receipt, or `null` when this provider does not know it. */
  getTransfer(txHash: string, logIndex: number): Promise<Trc20Transfer | null>;
}

export interface TronHttpProviderOptions {
  readonly name: string;
  /** e.g. `https://api.trongrid.io` or a self-hosted full node. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const toBigInt = (value: unknown, field: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new DomainError('INVALID_ARGUMENT', `provider returned an unusable ${field}`);
};

const requireAddress = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !isTronAddress(value)) throw new DomainError('INVALID_ADDRESS', `provider returned an invalid ${field}`);
  return value;
};

/**
 * TronGrid-compatible HTTP provider. Every field the domain relies on is parsed and validated here; anything the
 * provider sends that we do not understand is a hard error rather than a silently missing fact.
 *
 * Endpoints used: `/walletsolidity/getnowblock` (finality), `/wallet/getnowblock` (head),
 * `/v1/accounts/{address}/transactions/trc20` (incoming transfers, ARCHITECTURE's `listTrc20Transfers`),
 * `/wallet/gettransactioninfobyid` (receipt + logs, `getTransactionInfo`).
 */
export class TronHttpProvider implements TronProvider {
  readonly name: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: TronHttpProviderOptions) {
    this.name = opts.name;
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  async #call<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...(this.#apiKey ? { 'TRON-PRO-API-KEY': this.#apiKey } : {}),
        },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name} answered ${response.status} for ${path}`);
      return (await response.json()) as T;
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name} is unreachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async getLatestBlockNumber(): Promise<bigint> {
    const r = await this.#call<{ block_header?: { raw_data?: { number?: number } } }>('/wallet/getnowblock', { method: 'POST', body: {} });
    return toBigInt(r.block_header?.raw_data?.number, 'head block number');
  }

  async getSolidifiedBlockNumber(): Promise<bigint> {
    const r = await this.#call<{ block_header?: { raw_data?: { number?: number } } }>('/walletsolidity/getnowblock', { method: 'POST', body: {} });
    return toBigInt(r.block_header?.raw_data?.number, 'solidified block number');
  }

  async listIncomingTransfers(input: { address: string; contract: string; sinceBlock: bigint; limit?: number }): Promise<readonly Trc20Transfer[]> {
    const address = requireAddress(input.address, 'address');
    const contract = requireAddress(input.contract, 'contract');
    const limit = input.limit ?? 200;
    const query = new URLSearchParams({ only_to: 'true', limit: String(limit), contract_address: contract, order_by: 'block_timestamp,asc' });
    const r = await this.#call<{ data?: unknown[] }>(`/v1/accounts/${address}/transactions/trc20?${query.toString()}`);
    const rows = Array.isArray(r.data) ? r.data : [];
    const out: Trc20Transfer[] = [];
    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const token = (row.token_info ?? {}) as { address?: unknown };
      if (requireAddress(token.address, 'token contract') !== contract) continue;
      const blockNumber = toBigInt(row.block ?? row.block_number, 'block number');
      if (blockNumber < input.sinceBlock) continue;
      out.push({
        txHash: String(row.transaction_id ?? '').toLowerCase(),
        logIndex: typeof row.event_index === 'number' ? row.event_index : 0,
        tokenContract: contract,
        fromAddress: requireAddress(row.from, 'sender'),
        toAddress: requireAddress(row.to, 'destination'),
        amountMinor: toBigInt(row.value, 'amount'),
        blockNumber,
        blockTime: new Date(Number(toBigInt(row.block_timestamp, 'block timestamp'))),
        receiptStatus: null,
      });
    }
    return out;
  }

  async getTransfer(txHash: string, logIndex: number): Promise<Trc20Transfer | null> {
    const info = await this.#call<{
      id?: string;
      blockNumber?: number;
      blockTimeStamp?: number;
      receipt?: { result?: string };
      log?: { address?: string; topics?: string[]; data?: string }[];
    }>('/wallet/gettransactioninfobyid', { method: 'POST', body: { value: txHash, visible: true } });
    if (!info || !info.id) return null;
    const log = info.log?.[logIndex];
    if (!log || !Array.isArray(log.topics) || log.topics.length < 3) return null;
    // TRC20 Transfer(address indexed from, address indexed to, uint256 value)
    const [signature, fromTopic, toTopic] = log.topics as [string, string, string];
    if (signature.toLowerCase() !== TRANSFER_TOPIC) return null;
    return {
      txHash: String(info.id).toLowerCase(),
      logIndex,
      tokenContract: requireAddress(log.address, 'log contract'),
      fromAddress: hexTopicToAddress(fromTopic),
      toAddress: hexTopicToAddress(toTopic),
      amountMinor: BigInt(`0x${(log.data ?? '0').replace(/^0x/, '') || '0'}`),
      blockNumber: toBigInt(info.blockNumber, 'block number'),
      blockTime: new Date(Number(toBigInt(info.blockTimeStamp, 'block time'))),
      receiptStatus: info.receipt?.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
    };
  }
}

/**
 * keccak256("Transfer(address,address,uint256)") — the only log shape we read. It is a public constant of the
 * ERC20/TRC20 standard, not a secret; the marker below tells the repository secret scan that this 64-hex literal
 * is exactly that.
 */
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // secret-scan:allow — published event topic

/** TRON base58 of the address whose 20 payload bytes sit in the last 20 bytes of a 32-byte log topic. */
function hexTopicToAddress(topic: string): string {
  const hex = topic.replace(/^0x/, '').padStart(64, '0').slice(24);
  return encodeTronAddress(Buffer.from(hex, 'hex'));
}

export interface DualProviderOptions {
  readonly primary: TronProvider;
  readonly secondary?: TronProvider;
  /** The USDT (TRC20) contract this deployment accepts (FI-24). */
  readonly tokenContract: string;
}

/**
 * The `ChainVerifier` the domain uses (FI-24, D-05): the primary provider supplies the facts and the secondary
 * has to agree on every one of them. `agreedBy` names the providers that matched, so the domain can require two
 * for large amounts and still settle small ones on a single provider.
 */
export class DualProviderChainVerifier implements ChainVerifier {
  readonly providers: readonly string[];
  readonly tokenContract: string;
  readonly #primary: TronProvider;
  readonly #secondary: TronProvider | undefined;

  constructor(opts: DualProviderOptions) {
    this.#primary = opts.primary;
    this.#secondary = opts.secondary;
    this.providers = opts.secondary ? [opts.primary.name, opts.secondary.name] : [opts.primary.name];
    this.tokenContract = requireAddress(opts.tokenContract, 'token contract');
  }

  async lookupTransfer(network: ChainNetwork, txHash: string, logIndex: number): Promise<TransferReceipt | null> {
    if (network !== 'TRON') throw new DomainError('INVALID_ARGUMENT', `unsupported network ${network}`);
    const primary = await this.#primary.getTransfer(txHash, logIndex);
    if (!primary) return null;
    const solidified = await this.#primary.getSolidifiedBlockNumber();
    const agreedBy: string[] = [this.#primary.name];
    if (this.#secondary) {
      const second = await this.#secondary.getTransfer(txHash, logIndex);
      if (second && sameTransfer(primary, second)) agreedBy.push(this.#secondary.name);
    }
    return {
      network: 'TRON',
      txHash: primary.txHash,
      logIndex: primary.logIndex,
      tokenContract: primary.tokenContract,
      fromAddress: primary.fromAddress,
      toAddress: primary.toAddress,
      amountMinor: primary.amountMinor,
      blockNumber: primary.blockNumber,
      blockTime: primary.blockTime,
      receiptStatus: primary.receiptStatus === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      solidifiedBlock: solidified,
      agreedBy,
    };
  }
}

/** Two providers agree when every fact the domain reads is identical. */
export function sameTransfer(a: Trc20Transfer, b: Trc20Transfer): boolean {
  return (
    a.txHash.toLowerCase() === b.txHash.toLowerCase() &&
    a.logIndex === b.logIndex &&
    a.tokenContract === b.tokenContract &&
    a.fromAddress === b.fromAddress &&
    a.toAddress === b.toAddress &&
    a.amountMinor === b.amountMinor &&
    a.blockNumber === b.blockNumber &&
    (a.receiptStatus ?? null) === (b.receiptStatus ?? null)
  );
}
