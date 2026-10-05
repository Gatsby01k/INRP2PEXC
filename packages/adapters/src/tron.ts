import { DomainError, normalizeTronAddress, tronAddressToHex } from '@inrp2p/kernel';
import type { BalanceReading, BalanceSource, ChainNetwork, ChainVerification, ChainVerifier, TransactionTransfers, TransferReceipt } from './chain.ts';

/**
 * TRON provider port (ARCHITECTURE §6 `TronAdapter`). A provider returns **raw facts** — what the chain says —
 * and never a decision: whether a transfer counts is decided by the domain (FI-24, FI-26).
 *
 * Every transfer a provider reports is backed by the transaction's own receipt: block number, execution result and
 * the exact log position come from `gettransactioninfobyid`, never from an index that does not carry them.
 */
export interface Trc20Transfer {
  readonly txHash: string;
  /** Position of the Transfer log in the transaction's receipt (`log[i]`). */
  readonly logIndex: number;
  readonly tokenContract: string;
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amountMinor: bigint;
  readonly blockNumber: bigint;
  readonly blockTime: Date;
  readonly receiptStatus: 'SUCCESS' | 'FAILED';
}

/** One decoded receipt log. Anything that claims the Transfer signature but does not decode is `MALFORMED`. */
export type DecodedLog =
  | { readonly index: number; readonly kind: 'TRANSFER'; readonly transfer: Trc20Transfer }
  | { readonly index: number; readonly kind: 'OTHER' }
  | { readonly index: number; readonly kind: 'MALFORMED'; readonly reason: string };

/** A transaction as its receipt describes it. */
export type TxEvidence =
  | {
      readonly status: 'FOUND';
      readonly txHash: string;
      readonly blockNumber: bigint;
      readonly blockTime: Date;
      /** `receipt.result` (`SUCCESS`, `REVERT`, `OUT_OF_ENERGY`, …). */
      readonly result: string;
      readonly success: boolean;
      readonly logs: readonly DecodedLog[];
    }
  | { readonly status: 'NOT_FOUND'; readonly txHash: string };

/** What one provider knows about one Transfer log. Errors (unreachable, unreadable, inconsistent) are thrown. */
export type TransferLookup =
  | { readonly status: 'FOUND'; readonly transfer: Trc20Transfer }
  | { readonly status: 'TX_FAILED'; readonly txHash: string; readonly blockNumber: bigint; readonly blockTime: Date; readonly result: string }
  | { readonly status: 'NOT_FOUND' };

export interface TronTransferWindowQuery {
  readonly address: string;
  readonly contract: string;
  /** First block of the window (inclusive). */
  readonly sinceBlock: bigint;
  /** Last block of the window (inclusive). */
  readonly untilBlock: bigint;
}

/**
 * The incoming transfers of one address in one block window, **and how much of the window they are known to
 * cover**. A provider never turns "I could not read it" into "there was nothing": an interrupted page, a repeated
 * pagination token, the page limit, the time budget, a receipt it could not obtain or one that contradicts the
 * index all leave `complete = false`, and `completeThrough` names the highest block below which nothing can be
 * missing. The scanner moves its cursor no further than that.
 */
export interface TransferWindow {
  readonly transfers: readonly Trc20Transfer[];
  readonly complete: boolean;
  /** Every transfer in `[sinceBlock, completeThrough]` is in `transfers`; `sinceBlock − 1` when nothing is certain. */
  readonly completeThrough: bigint;
  readonly incompleteReason?: string;
  /** History pages read. */
  readonly pages: number;
  /** HTTP requests made for this window, retries included. */
  readonly requests: number;
}

export interface TronProvider {
  readonly name: string;
  /**
   * Stable independence group: who actually operates the data behind this adapter (vendor, cluster, upstream
   * node). Two adapters with different names but the same group are **one** source of truth for D-05, so they can
   * never form a quorum between them. It is declared, never inferred from a URL, because two hostnames of the
   * same vendor look independent and are not.
   */
  readonly independenceGroup: string;
  /** Head of the chain, including blocks that may still be reorganized. */
  getLatestBlockNumber(): Promise<bigint>;
  /** Highest irreversible block (solidified by ≥ 2/3 of the SRs) — the finality line for FI-24. */
  getSolidifiedBlockNumber(): Promise<bigint>;
  /** TRC20 transfers of one contract **into** one address within a block window, with explicit completeness. */
  readIncomingTransfers(query: TronTransferWindowQuery): Promise<TransferWindow>;
  /** One transaction's receipt, decoded. */
  getTransaction(txHash: string): Promise<TxEvidence>;
  /** One Transfer log of one transaction. */
  getTransfer(txHash: string, logIndex: number): Promise<TransferLookup>;
  /**
   * The TRC20 balance of an address at the solidified head, and that head — read so that both belong to the same
   * block (B2). A balance whose block cannot be pinned is an error, never a number.
   */
  getSolidifiedBalance(address: string, contract: string): Promise<BalanceReading>;
}


export interface TronHttpProviderOptions {
  readonly name: string;
  /** See `TronProvider.independenceGroup` — declared per deployment, never guessed from the URL. */
  readonly independenceGroup: string;
  /** e.g. `https://api.trongrid.io` or a self-hosted node with a TronGrid-compatible index. */
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** Per HTTP request. */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** History page size (TronGrid caps it at 200). */
  readonly pageSize?: number;
  /** Most history pages one window read follows before it reports itself incomplete. */
  readonly maxPages?: number;
  /** Receipts fetched in parallel for one window. */
  readonly receiptConcurrency?: number;
  /** Extra attempts for a transient failure (network, timeout, 429, 5xx, unreadable body). */
  readonly retries?: number;
  readonly retryBaseDelayMs?: number;
  /** Wall-clock budget of one window read; past it the read stops and reports what it covered. */
  readonly readBudgetMs?: number;
}

/** keccak256("Transfer(address,address,uint256)") — a public constant of the ERC20/TRC20 standard, not a secret. */
const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // secret-scan:allow — published event topic
const MAX_STORABLE = (1n << 63n) - 1n;

/** Provider names and independence groups are short, stable identifiers; an empty one is a configuration bug. */
const requireProviderId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,60}$/i.test(value.trim())) {
    throw new DomainError('INVALID_ARGUMENT', `provider ${field} must be a short stable identifier`);
  }
  return value.trim();
};

const evidence = (message: string, details: Record<string, unknown> = {}) => new DomainError('CHAIN_EVIDENCE_INVALID', message, details);

/** A 64-hex transaction id, lowercase, without `0x`. */
export function normalizeTxHash(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/^0x/, '') : '';
  if (!/^[0-9a-f]{64}$/.test(raw)) throw new DomainError('INVALID_ARGUMENT', 'txHash must be 64 hex characters');
  return raw;
}

const safeInt = (value: unknown, field: string, min = 0): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw evidence(`provider returned an unusable ${field}`);
  return value;
};

const toBlock = (value: unknown, field: string): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]{1,19}$/.test(value)) return BigInt(value);
  throw evidence(`provider returned an unusable ${field}`);
};

/** The account of an indexed address topic: 32 bytes whose first 12 are zero (ABI), the last 20 the account id. */
function addressFromTopic(topic: unknown): string | null {
  if (typeof topic !== 'string') return null;
  const hex = topic.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(hex) || !/^0{24}$/.test(hex.slice(0, 24))) return null;
  return normalizeTronAddress(hex.slice(24));
}

/**
 * Decodes a `gettransactioninfobyid` answer (developers.tron.network/reference/gettransactioninfobyid and
 * /docs/event): `{}` for an unknown transaction; otherwise `id`, `blockNumber`, `blockTimeStamp`, `receipt.result`
 * and `log[]` whose `address` is the emitting contract as 20-byte hex without the `41` version byte, whose `topics`
 * are 32-byte hex words (signature, then indexed parameters) and whose `data` holds the non-indexed parameters.
 * Anything the domain would rely on that does not decode is a hard error, never a missing fact.
 */
export function parseTransactionInfo(info: unknown, txHash: string): TxEvidence {
  if (info === null || typeof info !== 'object' || Array.isArray(info)) throw evidence('provider returned a receipt that is not an object');
  const r = info as Record<string, unknown>;
  if (Object.keys(r).length === 0) return { status: 'NOT_FOUND', txHash };
  if (typeof r.id !== 'string' || r.id.toLowerCase().replace(/^0x/, '') !== txHash) throw evidence('provider answered for another transaction', { asked: txHash });
  const blockNumber = BigInt(safeInt(r.blockNumber, 'receipt block number', 1));
  const blockTime = new Date(safeInt(r.blockTimeStamp, 'receipt block time', 1));
  const receipt = r.receipt as Record<string, unknown> | undefined;
  if (!receipt || typeof receipt !== 'object' || typeof receipt.result !== 'string' || receipt.result.length === 0) {
    // A TRC20 transfer is a contract call, whose receipt always states how it ended. Without that we know nothing.
    throw evidence('provider returned a receipt without its execution result', { txHash });
  }
  const result = receipt.result;
  const success = result === 'SUCCESS' && r.result !== 'FAILED';
  const rawLogs = r.log === undefined ? [] : r.log;
  if (!Array.isArray(rawLogs)) throw evidence('provider returned an unreadable log list');
  const logs: DecodedLog[] = rawLogs.map((raw, index) => decodeLog(raw, index, { txHash, blockNumber, blockTime, success }));
  return { status: 'FOUND', txHash, blockNumber, blockTime, result, success, logs };
}

function decodeLog(raw: unknown, index: number, tx: { txHash: string; blockNumber: bigint; blockTime: Date; success: boolean }): DecodedLog {
  if (raw === null || typeof raw !== 'object') return { index, kind: 'MALFORMED', reason: 'log is not an object' };
  const l = raw as Record<string, unknown>;
  if (!Array.isArray(l.topics) || l.topics.length === 0 || typeof l.topics[0] !== 'string') return { index, kind: 'OTHER' };
  if (l.topics[0].toLowerCase().replace(/^0x/, '') !== TRANSFER_TOPIC) return { index, kind: 'OTHER' };
  // A TRC721 Transfer shares the signature but indexes the token id as a fourth topic and has no data.
  if (l.topics.length === 4) return { index, kind: 'OTHER' };
  if (l.topics.length !== 3) return { index, kind: 'MALFORMED', reason: `Transfer log with ${l.topics.length} topics` };
  let contract: string;
  try {
    contract = normalizeTronAddress(l.address);
  } catch {
    return { index, kind: 'MALFORMED', reason: 'Transfer log contract address does not decode' };
  }
  let from: string | null;
  let to: string | null;
  try {
    from = addressFromTopic(l.topics[1]);
    to = addressFromTopic(l.topics[2]);
  } catch {
    from = null;
    to = null;
  }
  if (!from || !to) return { index, kind: 'MALFORMED', reason: 'Transfer log address topics do not decode' };
  const data = typeof l.data === 'string' ? l.data.toLowerCase().replace(/^0x/, '') : '';
  if (!/^[0-9a-f]{64}$/.test(data)) return { index, kind: 'MALFORMED', reason: 'Transfer log value is not one 32-byte word' };
  const amount = BigInt(`0x${data}`);
  if (amount > MAX_STORABLE) return { index, kind: 'MALFORMED', reason: 'Transfer value exceeds what can be recorded' };
  return {
    index,
    kind: 'TRANSFER',
    transfer: {
      txHash: tx.txHash,
      logIndex: index,
      tokenContract: contract,
      fromAddress: from,
      toAddress: to,
      amountMinor: amount,
      blockNumber: tx.blockNumber,
      blockTime: tx.blockTime,
      receiptStatus: tx.success ? 'SUCCESS' : 'FAILED',
    },
  };
}

interface HistoryRow {
  readonly txHash: string;
  readonly timestamp: number;
  /** The token the index says moved, when it says so; the receipt decides either way. */
  readonly contract: string | null;
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
}

/** Decodes one account-history row; the index's word is checked against the receipt later, never trusted alone. */
function parseHistoryRow(raw: unknown): HistoryRow {
  if (raw === null || typeof raw !== 'object') throw evidence('history row is not an object');
  const r = raw as Record<string, unknown>;
  const txHash = normalizeTxHash(r.transaction_id);
  const timestamp = safeInt(r.block_timestamp, 'history block timestamp', 1);
  const value =
    typeof r.value === 'string' && /^[0-9]{1,30}$/.test(r.value) ? BigInt(r.value)
      : typeof r.value === 'number' && Number.isSafeInteger(r.value) && r.value >= 0 ? BigInt(r.value)
        : null;
  if (value === null) throw evidence('history row value is not an integer');
  const token = r.token_info as Record<string, unknown> | undefined;
  const contract = token && token.address !== undefined ? normalizeTronAddress(token.address) : null;
  return { txHash, timestamp, contract, from: normalizeTronAddress(r.from), to: normalizeTronAddress(r.to), value };
}

class CallCounter {
  requests = 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` over `items` with at most `limit` in flight, keeping the input order in the output. */
async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return out;
}

/**
 * TronGrid-compatible HTTP provider. Every field the domain relies on is parsed and validated here; anything the
 * provider sends that we do not understand is a hard error rather than a silently missing fact.
 *
 * Endpoints: `/wallet/getnowblock` (head), `/walletsolidity/getnowblock` (finality), `/wallet/getblockbynum` (the
 * timestamps bounding a block window), `/v1/accounts/{address}/transactions/trc20` (which transactions touched an
 * address — an index without block numbers or log positions), `/wallet/gettransactioninfobyid` (the receipt: block,
 * result and the Transfer logs with their positions).
 */
export class TronHttpProvider implements TronProvider {
  readonly name: string;
  readonly independenceGroup: string;
  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #receiptConcurrency: number;
  readonly #retries: number;
  readonly #retryBaseDelayMs: number;
  readonly #readBudgetMs: number;
  /** Block → timestamp. Immutable for a given block of the canonical chain; bounded. */
  readonly #blockTimes = new Map<bigint, number>();

  constructor(opts: TronHttpProviderOptions) {
    this.name = requireProviderId(opts.name, 'name');
    this.independenceGroup = requireProviderId(opts.independenceGroup, 'independenceGroup');
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
    this.#pageSize = Math.min(Math.max(opts.pageSize ?? 200, 1), 200);
    this.#maxPages = Math.max(opts.maxPages ?? 50, 1);
    this.#receiptConcurrency = Math.max(opts.receiptConcurrency ?? 4, 1);
    this.#retries = Math.max(opts.retries ?? 2, 0);
    this.#retryBaseDelayMs = Math.max(opts.retryBaseDelayMs ?? 250, 0);
    this.#readBudgetMs = Math.max(opts.readBudgetMs ?? 60_000, 1);
  }

  /** One HTTP exchange. Transient failures carry `details.transient`; nothing here ever contains the API key. */
  async #once<T>(path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...(this.#apiKey ? { 'TRON-PRO-API-KEY': this.#apiKey } : {}),
        },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
    } catch (e) {
      throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name} is unreachable: ${(e as Error).message}`, { transient: true });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name} answered ${response.status} for ${path.split('?')[0]}`, {
        status: response.status,
        transient: response.status === 429 || response.status >= 500,
      });
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new DomainError('CHAIN_PROVIDER_ERROR', `${this.name} sent an unreadable body for ${path.split('?')[0]}`, { transient: true });
    }
  }

  /** Bounded retry with backoff for transient failures only; a definite answer is never retried into another. */
  async #call<T>(counter: CallCounter, path: string, init?: { method?: 'GET' | 'POST'; body?: unknown }, deadline?: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      counter.requests += 1;
      try {
        return await this.#once<T>(path, init);
      } catch (e) {
        const transient = e instanceof DomainError && e.details.transient === true;
        if (!transient || attempt >= this.#retries || (deadline !== undefined && Date.now() >= deadline)) throw e;
        await sleep(this.#retryBaseDelayMs * 2 ** attempt);
      }
    }
  }

  async getLatestBlockNumber(): Promise<bigint> {
    const r = await this.#call<{ block_header?: { raw_data?: { number?: unknown } } }>(new CallCounter(), '/wallet/getnowblock', { method: 'POST', body: {} });
    return toBlock(r.block_header?.raw_data?.number, 'head block number');
  }

  async getSolidifiedBlockNumber(): Promise<bigint> {
    const r = await this.#call<{ block_header?: { raw_data?: { number?: unknown } } }>(new CallCounter(), '/walletsolidity/getnowblock', { method: 'POST', body: {} });
    return toBlock(r.block_header?.raw_data?.number, 'solidified block number');
  }

  async #blockTimestamp(block: bigint, counter: CallCounter, deadline: number): Promise<number> {
    const cached = this.#blockTimes.get(block);
    if (cached !== undefined) return cached;
    const r = await this.#call<{ block_header?: { raw_data?: { number?: unknown; timestamp?: unknown } } }>(
      counter, '/wallet/getblockbynum', { method: 'POST', body: { num: Number(block) } }, deadline,
    );
    const number = toBlock(r.block_header?.raw_data?.number, 'block number');
    if (number !== block) throw evidence(`provider answered block ${number} for block ${block}`);
    const ts = safeInt(r.block_header?.raw_data?.timestamp, 'block timestamp', 1);
    if (this.#blockTimes.size >= 256) this.#blockTimes.delete(this.#blockTimes.keys().next().value!);
    this.#blockTimes.set(block, ts);
    return ts;
  }

  async getTransaction(txHash: string): Promise<TxEvidence> {
    return this.#transaction(normalizeTxHash(txHash), new CallCounter());
  }

  async #transaction(hash: string, counter: CallCounter, deadline?: number): Promise<TxEvidence> {
    const info = await this.#call<unknown>(counter, '/wallet/gettransactioninfobyid', { method: 'POST', body: { value: hash } }, deadline);
    return parseTransactionInfo(info, hash);
  }

  async getTransfer(txHash: string, logIndex: number): Promise<TransferLookup> {
    if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new DomainError('INVALID_ARGUMENT', 'logIndex must be a non-negative integer');
    const tx = await this.getTransaction(txHash);
    if (tx.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    if (!tx.success) return { status: 'TX_FAILED', txHash: tx.txHash, blockNumber: tx.blockNumber, blockTime: tx.blockTime, result: tx.result };
    const log = tx.logs[logIndex];
    // The (tx, log) identity was read from a Transfer log. A receipt with no such log, or another event there, is a
    // provider that disagrees with what we recorded — an evidence error, never "the transfer does not exist".
    if (!log) throw evidence(`transaction has no log ${logIndex}`, { txHash: tx.txHash, logIndex });
    if (log.kind === 'MALFORMED') throw evidence(`log ${logIndex} is a malformed Transfer: ${log.reason}`, { txHash: tx.txHash, logIndex });
    if (log.kind !== 'TRANSFER') throw evidence(`log ${logIndex} is not a TRC20 Transfer`, { txHash: tx.txHash, logIndex });
    return { status: 'FOUND', transfer: log.transfer };
  }

  async getSolidifiedBalance(address: string, contract: string): Promise<BalanceReading> {
    const owner = normalizeTronAddress(address);
    const token = normalizeTronAddress(contract);
    const counter = new CallCounter();
    // balanceOf(address): the 32-byte ABI word of the 20-byte account id.
    const parameter = `${'0'.repeat(24)}${tronAddressToHex(owner).slice(2)}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.getSolidifiedBlockNumber();
      const r = await this.#call<{ result?: { result?: unknown }; constant_result?: unknown }>(counter, '/walletsolidity/triggerconstantcontract', {
        method: 'POST',
        body: { owner_address: owner, contract_address: token, function_selector: 'balanceOf(address)', parameter, visible: true },
      });
      const after = await this.getSolidifiedBlockNumber();
      if (before !== after) continue; // the head moved under the call: the balance belongs to neither — read again
      if (r?.result?.result !== true || !Array.isArray(r.constant_result) || typeof r.constant_result[0] !== 'string' || !/^[0-9a-fA-F]{64}$/.test(r.constant_result[0])) {
        throw evidence('provider returned an unreadable balanceOf result');
      }
      const balance = BigInt(`0x${r.constant_result[0]}`);
      if (balance > MAX_STORABLE) throw evidence('balance exceeds what can be recorded');
      const account = await this.#call<{ balance?: unknown }>(counter, '/walletsolidity/getaccount', { method: 'POST', body: { address: owner, visible: true } });
      const trx = account && typeof account === 'object' && typeof account.balance === 'number' && Number.isSafeInteger(account.balance) && account.balance >= 0
        ? BigInt(account.balance)
        : account && typeof account === 'object' && Object.keys(account).length === 0 ? 0n : null;
      return { balanceMinor: balance, solidifiedBlock: before, trxSun: trx };
    }
    throw evidence('the solidified head kept moving while the balance was read');
  }

  /**
   * Reads every history page of the window, then the receipt of every transaction the history names, and returns
   * the Transfer logs into the address that the receipts prove — together with how far that proof reaches.
   */
  async readIncomingTransfers(query: TronTransferWindowQuery): Promise<TransferWindow> {
    const address = normalizeTronAddress(query.address);
    const contract = normalizeTronAddress(query.contract);
    const { sinceBlock, untilBlock } = query;
    if (sinceBlock < 0n || untilBlock < sinceBlock) throw new DomainError('INVALID_ARGUMENT', 'the block window is empty or negative');
    const counter = new CallCounter();
    const deadline = Date.now() + this.#readBudgetMs;
    const unknown = (reason: string, pages = 0): TransferWindow => ({
      transfers: [], complete: false, completeThrough: sinceBlock - 1n, incompleteReason: reason, pages, requests: counter.requests,
    });

    // 1. The window's edges as timestamps: the account history is indexed by block time, not by block number.
    let fromTs: number;
    let toTs: number;
    try {
      fromTs = sinceBlock === 0n ? 0 : await this.#blockTimestamp(sinceBlock, counter, deadline);
      toTs = await this.#blockTimestamp(untilBlock, counter, deadline);
    } catch (e) {
      return unknown(`window edges unavailable: ${(e as Error).message}`);
    }
    if (toTs < fromTs) return unknown('provider block timestamps run backwards');

    // 2. Every page. Blocks are ≥ 3 s apart, so ±1 ms around the edges includes the edge blocks whether the index
    // treats the bounds as inclusive or not, and can never include a neighbouring block.
    const params = new URLSearchParams({
      only_to: 'true',
      limit: String(this.#pageSize),
      contract_address: contract,
      order_by: 'block_timestamp,asc',
      min_timestamp: String(Math.max(fromTs - 1, 0)),
      max_timestamp: String(toTs + 1),
    });
    const rows: HistoryRow[] = [];
    const seenRows = new Set<string>();
    const fingerprints = new Set<string>();
    let pages = 0;
    let stopped: string | null = null;
    let fingerprint: string | null = null;
    for (;;) {
      if (pages >= this.#maxPages) { stopped = `page limit (${this.#maxPages}) reached`; break; }
      if (Date.now() >= deadline) { stopped = 'time budget exhausted'; break; }
      const q = new URLSearchParams(params);
      if (fingerprint) q.set('fingerprint', fingerprint);
      let page: { data?: unknown; success?: unknown; meta?: { fingerprint?: unknown } };
      try {
        page = await this.#call(counter, `/v1/accounts/${address}/transactions/trc20?${q.toString()}`, undefined, deadline);
        if (page === null || typeof page !== 'object' || !Array.isArray(page.data) || page.success === false) throw evidence('history page has no data list');
      } catch (e) {
        stopped = `history page ${pages + 1} failed: ${(e as Error).message}`;
        break;
      }
      pages += 1;
      let fresh = 0;
      try {
        for (const raw of page.data as unknown[]) {
          const row = parseHistoryRow(raw);
          // Another token, or a transfer out of the address, is not an incoming USDT transfer: not ours to read.
          if (row.to !== address || (row.contract !== null && row.contract !== contract)) continue;
          const key = `${row.txHash}:${row.from}:${row.value}:${row.timestamp}`;
          if (!seenRows.has(key)) fresh += 1;
          seenRows.add(key);
          rows.push(row);
        }
      } catch (e) {
        stopped = `history page ${pages} is unreadable: ${(e as Error).message}`;
        break;
      }
      const next = page.meta?.fingerprint;
      if (typeof next === 'string' && next.length > 0) {
        if (fingerprints.has(next)) { stopped = 'pagination token repeated'; break; }
        fingerprints.add(next);
        fingerprint = next;
        continue;
      }
      if ((page.data as unknown[]).length < this.#pageSize) break;
      // A full page and no continuation token: the index cannot have shown everything. Continue from the last
      // timestamp (rows at that timestamp come back and are recognised); if nothing new arrives, the window is read.
      const last = rows[rows.length - 1]!.timestamp;
      if (fresh === 0) { stopped = 'more rows than one page share one timestamp'; break; }
      params.set('min_timestamp', String(last));
      fingerprint = null;
    }

    // 3. One receipt per transaction the history names: the receipt, not the index, says which block, whether it
    // executed, and which log — possibly several — moved USDT into the address.
    const byTx = new Map<string, HistoryRow[]>();
    for (const row of rows) {
      const list = byTx.get(row.txHash);
      if (list) list.push(row);
      else byTx.set(row.txHash, [row]);
    }
    const txHashes = [...byTx.keys()];
    const resolved = await mapBounded(txHashes, this.#receiptConcurrency, async (hash) => {
      const listed = byTx.get(hash)!;
      const firstTs = Math.min(...listed.map((r) => r.timestamp));
      try {
        const tx = await this.#transaction(hash, counter, deadline);
        if (tx.status === 'NOT_FOUND') return { hash, firstTs, ok: false as const, reason: 'receipt unavailable' };
        if (tx.blockTime.getTime() !== firstTs) return { hash, firstTs, ok: false as const, reason: 'receipt block time differs from the history' };
        // A definitive receipt that the transaction failed is evidence that it moved nothing (a reverted call keeps
        // no logs), not a gap in the evidence.
        if (!tx.success) return { hash, firstTs, ok: true as const, blockNumber: tx.blockNumber, transfers: [] as Trc20Transfer[] };
        if (tx.logs.some((l) => l.kind === 'MALFORMED')) return { hash, firstTs, ok: false as const, reason: 'receipt has a malformed Transfer log' };
        const mine = tx.logs.flatMap((l) => (l.kind === 'TRANSFER' && l.transfer.tokenContract === contract && l.transfer.toAddress === address ? [l.transfer] : []));
        for (const row of listed) {
          if (!mine.some((t) => t.fromAddress === row.from && t.amountMinor === row.value)) {
            return { hash, firstTs, ok: false as const, reason: 'receipt does not contain the transfer the history lists' };
          }
        }
        return { hash, firstTs, ok: true as const, blockNumber: tx.blockNumber, transfers: mine.filter((t) => t.amountMinor > 0n) };
      } catch (e) {
        return { hash, firstTs, ok: false as const, reason: (e as Error).message };
      }
    });

    // 4. How far the proof reaches. Blocks have strictly increasing timestamps, so everything earlier than the first
    // thing we could not prove lies in blocks we fully read.
    let horizon = Number.POSITIVE_INFINITY;
    let reason: string | undefined = stopped ?? undefined;
    if (stopped) horizon = rows.length > 0 ? rows[rows.length - 1]!.timestamp : fromTs;
    for (const r of resolved) {
      if (!r.ok && r.firstTs < horizon) {
        horizon = r.firstTs;
        reason = `transaction ${r.hash.slice(0, 12)}…: ${r.reason}`;
      }
    }
    const transfers: Trc20Transfer[] = [];
    let provenThrough = sinceBlock - 1n;
    for (const r of resolved) {
      if (!r.ok) continue;
      // Rows the timestamp margin let in from outside the window are not this window's to report.
      if (r.blockNumber < sinceBlock || r.blockNumber > untilBlock) continue;
      transfers.push(...r.transfers);
      if (r.firstTs < horizon && r.blockNumber > provenThrough) provenThrough = r.blockNumber;
    }
    transfers.sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.txHash !== b.txHash ? (a.txHash < b.txHash ? -1 : 1) : a.logIndex - b.logIndex));
    const complete = horizon === Number.POSITIVE_INFINITY;
    return {
      transfers,
      complete,
      completeThrough: complete ? untilBlock : provenThrough,
      ...(complete ? {} : { incompleteReason: reason ?? 'incomplete' }),
      pages,
      requests: counter.requests,
    };
  }
}

export interface QuorumVerifierOptions {
  /** In priority order: the first one that finds the transfer supplies the facts the others must match. */
  readonly providers: readonly TronProvider[];
  /** The USDT (TRC20) contract this deployment accepts (FI-24). */
  readonly tokenContract: string;
  /** Per-provider wall-clock limit for one verification. */
  readonly providerTimeoutMs?: number;
}

type ProviderAnswer =
  | { readonly provider: TronProvider; readonly kind: 'FOUND'; readonly transfer: Trc20Transfer; readonly solidified: bigint }
  | { readonly provider: TronProvider; readonly kind: 'TX_FAILED'; readonly blockNumber: bigint; readonly blockTime: Date; readonly result: string; readonly solidified: bigint }
  | { readonly provider: TronProvider; readonly kind: 'NOT_FOUND' }
  | { readonly provider: TronProvider; readonly kind: 'ERROR'; readonly reason: string };

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DomainError('CHAIN_PROVIDER_ERROR', `${what} timed out`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

/**
 * The `ChainVerifier` the domain uses (FI-24, D-05). Every configured provider is asked, independently and in
 * parallel; one that fails or times out is reported as unavailable and never as an answer. Facts come from the
 * first provider (in priority order) that finds the transfer; another provider agrees only when it reports exactly
 * the same facts **and** calls the block final by its own solidified head. Two providers that contradict each other
 * produce `CONFLICT`, at any amount — the verifier does not vote. The receipt carries who agreed (`agreedBy`, for
 * the audit trail) and **how many independent sources** that amounts to (`agreedGroups`), which is what the D-05
 * quorum is measured on: a second adapter in the primary's independence group adds redundancy and nothing else.
 */
export class QuorumChainVerifier implements ChainVerifier {
  readonly providers: readonly string[];
  readonly independenceGroups: readonly string[];
  readonly tokenContract: string;
  readonly #providers: readonly TronProvider[];
  readonly #timeoutMs: number;

  constructor(opts: QuorumVerifierOptions) {
    if (opts.providers.length === 0) throw new DomainError('INVALID_ARGUMENT', 'at least one TRON provider is required');
    const names = opts.providers.map((p) => requireProviderId(p.name, 'name'));
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) throw new DomainError('INVALID_ARGUMENT', 'provider names must be distinct');
    this.#providers = opts.providers;
    this.providers = names;
    this.independenceGroups = distinctGroups(opts.providers);
    this.tokenContract = normalizeTronAddress(opts.tokenContract);
    this.#timeoutMs = opts.providerTimeoutMs ?? 20_000;
  }

  async #ask(p: TronProvider, txHash: string, logIndex: number): Promise<ProviderAnswer> {
    try {
      const [lookup, solidified] = await withTimeout(Promise.all([p.getTransfer(txHash, logIndex), p.getSolidifiedBlockNumber()]), this.#timeoutMs, p.name);
      if (lookup.status === 'NOT_FOUND') return { provider: p, kind: 'NOT_FOUND' };
      if (lookup.status === 'TX_FAILED') return { provider: p, kind: 'TX_FAILED', blockNumber: lookup.blockNumber, blockTime: lookup.blockTime, result: lookup.result, solidified };
      return { provider: p, kind: 'FOUND', transfer: lookup.transfer, solidified };
    } catch (e) {
      return { provider: p, kind: 'ERROR', reason: (e as Error).message };
    }
  }

  async verifyTransfer(network: ChainNetwork, txHash: string, logIndex: number): Promise<ChainVerification> {
    if (network !== 'TRON') throw new DomainError('INVALID_ARGUMENT', `unsupported network ${network}`);
    const hash = normalizeTxHash(txHash);
    const answers = await Promise.all(this.#providers.map((p) => this.#ask(p, hash, logIndex)));
    const unavailable = answers.filter((a) => a.kind === 'ERROR').map((a) => a.provider.name);
    const found = answers.filter((a): a is Extract<ProviderAnswer, { kind: 'FOUND' }> => a.kind === 'FOUND');
    const failed = answers.filter((a): a is Extract<ProviderAnswer, { kind: 'TX_FAILED' }> => a.kind === 'TX_FAILED');

    if (found.length > 0) {
      const anchor = found[0]!;
      const disagreeing = found.filter((a) => !sameTransfer(a.transfer, anchor.transfer));
      if (disagreeing.length > 0 || failed.length > 0) {
        return {
          status: 'CONFLICT',
          reason: failed.length > 0
            ? `${failed.map((a) => a.provider.name).join(', ')} report the transaction failed; ${anchor.provider.name} reports the transfer`
            : `${disagreeing.map((a) => a.provider.name).join(', ')} report different facts than ${anchor.provider.name}`,
          unavailable,
        };
      }
      const t = anchor.transfer;
      const final = found.filter((a) => a.solidified >= t.blockNumber);
      const backing = final.length > 0 ? final : found;
      const solidifiedBlock = final.length > 0
        ? final.reduce((m, a) => (a.solidified < m ? a.solidified : m), final[0]!.solidified)
        : found.reduce((m, a) => (a.solidified > m ? a.solidified : m), found[0]!.solidified);
      const receipt: TransferReceipt = {
        network: 'TRON',
        txHash: t.txHash,
        logIndex: t.logIndex,
        tokenContract: t.tokenContract,
        fromAddress: t.fromAddress,
        toAddress: t.toAddress,
        amountMinor: t.amountMinor,
        blockNumber: t.blockNumber,
        blockTime: t.blockTime,
        receiptStatus: t.receiptStatus,
        solidifiedBlock,
        agreedBy: backing.map((a) => a.provider.name),
        agreedGroups: distinctGroups(backing.map((a) => a.provider)),
        unavailable,
        degraded: unavailable.length > 0,
      };
      return { status: 'FOUND', receipt };
    }
    if (failed.length > 0) {
      const anchor = failed[0]!;
      if (failed.some((a) => a.blockNumber !== anchor.blockNumber)) {
        return { status: 'CONFLICT', reason: 'providers place the failed transaction in different blocks', unavailable };
      }
      const final = failed.filter((a) => a.solidified >= anchor.blockNumber);
      return {
        status: 'TX_FAILED', txHash: hash, blockNumber: anchor.blockNumber, blockTime: anchor.blockTime, result: anchor.result,
        agreedBy: final.map((a) => a.provider.name), agreedGroups: distinctGroups(final.map((a) => a.provider)), unavailable,
      };
    }
    const absent = answers.filter((a) => a.kind === 'NOT_FOUND').map((a) => a.provider);
    if (absent.length > 0) {
      return { status: 'NOT_FOUND', absentBy: absent.map((p) => p.name), absentGroups: distinctGroups(absent), unavailable };
    }
    return { status: 'UNAVAILABLE', reason: answers.map((a) => (a.kind === 'ERROR' ? `${a.provider.name}: ${a.reason}` : '')).filter(Boolean).join('; '), unavailable };
  }

  async transactionTransfers(network: ChainNetwork, txHash: string): Promise<TransactionTransfers> {
    if (network !== 'TRON') throw new DomainError('INVALID_ARGUMENT', `unsupported network ${network}`);
    const hash = normalizeTxHash(txHash);
    let lastError: unknown = null;
    let notFoundBy: string | null = null;
    for (const p of this.#providers) {
      try {
        const tx = await withTimeout(p.getTransaction(hash), this.#timeoutMs, p.name);
        if (tx.status === 'NOT_FOUND') { notFoundBy ??= p.name; continue; }
        if (!tx.success) return { status: 'TX_FAILED', txHash: hash, transfers: [], provider: p.name };
        const transfers = tx.logs.flatMap((l) => (l.kind === 'TRANSFER' ? [{ network: 'TRON' as const, ...l.transfer }] : []));
        return { status: 'FOUND', txHash: hash, transfers, provider: p.name };
      } catch (e) {
        lastError = e;
      }
    }
    if (notFoundBy) return { status: 'NOT_FOUND', txHash: hash, transfers: [], provider: notFoundBy };
    throw lastError instanceof DomainError ? lastError : new DomainError('CHAIN_PROVIDER_ERROR', 'no provider could read this transaction');
  }

  balanceSources(): readonly BalanceSource[] {
    return this.#providers;
  }
}

/** The independence groups of a set of providers, deduplicated case-insensitively and in a stable order. */
export function distinctGroups(providers: readonly TronProvider[]): readonly string[] {
  const seen = new Map<string, string>();
  for (const p of providers) {
    const group = requireProviderId(p.independenceGroup, 'independenceGroup');
    const key = group.toLowerCase();
    if (!seen.has(key)) seen.set(key, group);
  }
  return [...seen.values()];
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
    a.receiptStatus === b.receiptStatus
  );
}

/** The hex form a TRON node uses for a base58 address — exposed for adapters that call contract methods. */
export const tronHex = tronAddressToHex;
