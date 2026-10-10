import { createHash } from 'node:crypto';
import { normalizeTronAddress, tronAddressToHex } from '@inrp2p/kernel';
import { FAKE_USDT_CONTRACT } from './fake-chain.ts';

/**
 * An in-memory TRON node + TronGrid index that answers HTTP the way the documented APIs do, so the HTTP provider is
 * tested against the wire shapes it will meet in production rather than against a fake that already speaks the
 * domain's types:
 *
 * - `/v1/accounts/{address}/transactions/trc20` — the account TRC20 history: `data[]` rows with `transaction_id`,
 *   `token_info`, `block_timestamp`, `from`, `to`, `type`, `value` and **no block number or event index**
 *   (developers.tron.network/reference/get-trc20-transaction-info-by-account-address), paginated with `limit` ≤ 200
 *   and an opaque `meta.fingerprint`, filtered by `min_timestamp` / `max_timestamp`;
 * - `/wallet/gettransactioninfobyid` (and the `walletsolidity` variant, which only knows solidified blocks) — the
 *   receipt, whose `log[].address` is 20-byte hex **without** the `41` prefix and whose `topics` and `data` are bare
 *   hex (developers.tron.network/docs/event);
 * - `/wallet/getnowblock`, `/walletsolidity/getnowblock`, `/wallet/getblockbynum`;
 * - `/walletsolidity/triggerconstantcontract` (`balanceOf`) and `/walletsolidity/getaccount` for balances.
 *
 * Faults are explicit knobs, so a test says exactly which failure it is about.
 */

/** keccak256("Transfer(address,address,uint256)"), the published TRC20 event topic. */
export const TRANSFER_EVENT_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // secret-scan:allow — published event topic

const hex64 = (n: bigint) => n.toString(16).padStart(64, '0');
const topicOf = (address: string) => `${'0'.repeat(24)}${tronAddressToHex(address).slice(2)}`;

export interface RawLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/** A TRC20 Transfer emitted by `contract` (a base58 address), as TRON writes it into the receipt. */
export function transferLog(input: { contract?: string; from: string; to: string; value: bigint }): RawLog {
  return {
    address: tronAddressToHex(input.contract ?? FAKE_USDT_CONTRACT).slice(2),
    topics: [TRANSFER_EVENT_TOPIC, topicOf(input.from), topicOf(input.to)],
    data: hex64(input.value),
  };
}

/** A log of some other event (an Approval, a swap), which a reader of Transfers must step over. */
export function otherLog(contract: string = FAKE_USDT_CONTRACT): RawLog {
  return {
    address: tronAddressToHex(contract).slice(2),
    topics: [createHash('sha256').update('Approval(address,address,uint256)').digest('hex'), hex64(1n), hex64(2n)],
    data: hex64(7n),
  };
}

export interface FakeTx {
  readonly txHash: string;
  readonly blockNumber: bigint;
  /** `SUCCESS`, or a TVM failure such as `REVERT` / `OUT_OF_ENERGY`; a failed transaction keeps no logs. */
  readonly result: string;
  readonly logs: readonly RawLog[];
  /** Position in the block (the index orders a block's transactions in the history). */
  readonly index: number;
}

export interface FaultRule {
  /** Path (with query) substring or predicate the rule applies to. */
  readonly match: string | ((url: string) => boolean);
  /** How many matching requests fail before the rule is spent (default: forever). */
  times?: number;
  /** HTTP status to answer; omitted means the connection fails (a thrown fetch). */
  readonly status?: number;
  /** A body to answer with instead of a status error (e.g. a malformed envelope). */
  readonly body?: unknown;
}

export interface FakeTronGridOptions {
  readonly head?: bigint;
  readonly solidificationLag?: bigint;
  /** Timestamp of block 0, in ms. Blocks are 3 s apart unless a slot is skipped with `skipSlot`. */
  readonly genesisMs?: number;
  readonly baseUrl?: string;
}

export class FakeTronGrid {
  readonly baseUrl: string;
  readonly #txs = new Map<string, FakeTx>();
  readonly #slotSkips = new Map<bigint, number>();
  #head: bigint;
  solidificationLag: bigint;
  readonly genesisMs: number;
  /** TRX balance (sun) per base58 address, for `getaccount`. */
  readonly trx = new Map<string, bigint>();

  // ---- Knobs -------------------------------------------------------------------------------------------------
  /** Largest page the index serves (TronGrid caps `limit` at 200). */
  pageCap = 200;
  /** Add a fingerprint to every full page even when nothing follows (an index cannot know without looking). */
  fingerprintOnFullPage = true;
  /** The legacy shape some fixtures invented: a `block` field on history rows. Off — TronGrid does not send it. */
  historyIncludesBlock = false;
  /** Every next page answers with the same fingerprint (a broken index). */
  fingerprintLoop = false;
  /** Transactions whose `gettransactioninfobyid` answers `{}` although the history lists them. */
  readonly receiptsWithheld = new Set<string>();
  /** Transactions whose receipt omits `receipt.result`. */
  readonly receiptResultOmitted = new Set<string>();
  /** Fault injection: the first matching rule decides. */
  faults: FaultRule[] = [];
  /** Every request made, as `METHOD path?query`, so a test can count calls. */
  readonly requests: string[] = [];

  constructor(opts: FakeTronGridOptions = {}) {
    this.#head = opts.head ?? 1_000n;
    this.solidificationLag = opts.solidificationLag ?? 19n;
    this.genesisMs = opts.genesisMs ?? 1_700_000_000_000;
    this.baseUrl = (opts.baseUrl ?? 'https://trongrid.example.test').replace(/\/+$/, '');
  }

  get head(): bigint {
    return this.#head;
  }

  get solidified(): bigint {
    const s = this.#head - this.solidificationLag;
    return s > 0n ? s : 0n;
  }

  /** Block timestamp in ms: 3 s slots from genesis, shifted by any skipped slots at or below the block. */
  blockTimestamp(block: bigint): number {
    let skipped = 0;
    for (const [at, slots] of this.#slotSkips) if (at <= block) skipped += slots;
    return this.genesisMs + Number(block) * 3_000 + skipped * 3_000;
  }

  /** A producer missed `slots` slots right before `block`, so its timestamp jumps (and stays shifted after it). */
  skipSlot(block: bigint, slots = 1): void {
    this.#slotSkips.set(block, (this.#slotSkips.get(block) ?? 0) + slots);
  }

  advance(blocks: bigint): void {
    this.#head += blocks;
  }

  solidifyAll(): void {
    this.#head += this.solidificationLag + 1n;
  }

  /** Adds a transaction (any logs). Mines into `blockNumber` (default: a new head block). */
  addTx(input: { txHash?: string; blockNumber?: bigint; result?: string; logs: readonly RawLog[] }): FakeTx {
    const blockNumber = input.blockNumber ?? this.#head + 1n;
    if (blockNumber > this.#head) this.#head = blockNumber;
    const txHash = (input.txHash ?? createHash('sha256').update(`tx:${this.#txs.size}:${blockNumber}`).digest('hex')).toLowerCase();
    const index = [...this.#txs.values()].filter((t) => t.blockNumber === blockNumber).length;
    const result = input.result ?? 'SUCCESS';
    const tx: FakeTx = { txHash, blockNumber, result, logs: result === 'SUCCESS' ? input.logs : [], index };
    this.#txs.set(txHash, tx);
    return tx;
  }

  /** One TRC20 transfer in its own transaction (the common case). */
  addTransfer(input: { from: string; to: string; value: bigint; contract?: string; txHash?: string; blockNumber?: bigint; result?: string }): FakeTx {
    return this.addTx({ ...input, logs: [transferLog(input)] });
  }

  /** A reorganization dropped the transaction: every endpoint stops knowing it. */
  orphan(txHash: string): void {
    this.#txs.delete(txHash.toLowerCase());
  }

  tx(txHash: string): FakeTx | undefined {
    return this.#txs.get(txHash.toLowerCase());
  }

  /** USDT (or `contract`) balance of `address`: incoming minus outgoing Transfers of successful transactions. */
  balanceOf(address: string, contract: string = FAKE_USDT_CONTRACT, atBlock: bigint = this.#head): bigint {
    const acct = tronAddressToHex(address).slice(2);
    const c = tronAddressToHex(contract).slice(2);
    let sum = 0n;
    for (const tx of this.#txs.values()) {
      if (tx.blockNumber > atBlock) continue;
      for (const l of tx.logs) {
        if (l.address !== c || l.topics[0] !== TRANSFER_EVENT_TOPIC || l.topics.length !== 3) continue;
        const value = BigInt(`0x${l.data}`);
        if (l.topics[2]!.slice(24) === acct) sum += value;
        if (l.topics[1]!.slice(24) === acct) sum -= value;
      }
    }
    return sum;
  }

  /** The history rows for one account, in block, transaction and log order (what the index serves). */
  #historyRows(address: string, q: URLSearchParams) {
    const acct = tronAddressToHex(address).slice(2);
    const contractFilter = q.get('contract_address');
    const contractHex = contractFilter ? tronAddressToHex(normalizeTronAddress(contractFilter)).slice(2) : null;
    const onlyTo = q.get('only_to') === 'true';
    const onlyFrom = q.get('only_from') === 'true';
    const onlyConfirmed = q.get('only_confirmed') === 'true';
    const min = q.get('min_timestamp') ? Number(q.get('min_timestamp')) : 0;
    const max = q.get('max_timestamp') ? Number(q.get('max_timestamp')) : Number.MAX_SAFE_INTEGER;
    const rows: { sortKey: [bigint, number, number]; row: Record<string, unknown> }[] = [];
    for (const tx of this.#txs.values()) {
      if (tx.result !== 'SUCCESS') continue;
      if (onlyConfirmed && tx.blockNumber > this.solidified) continue;
      const ts = this.blockTimestamp(tx.blockNumber);
      if (ts < min || ts > max) continue;
      tx.logs.forEach((l, i) => {
        if (l.topics[0] !== TRANSFER_EVENT_TOPIC || l.topics.length !== 3) return;
        if (contractHex && l.address !== contractHex) return;
        const toHit = l.topics[2]!.slice(24) === acct;
        const fromHit = l.topics[1]!.slice(24) === acct;
        if ((onlyTo && !toHit) || (onlyFrom && !fromHit) || (!toHit && !fromHit)) return;
        const row: Record<string, unknown> = {
          transaction_id: tx.txHash,
          token_info: { symbol: 'USDT', address: normalizeTronAddress(l.address), decimals: 6, name: 'Tether USD' },
          block_timestamp: ts,
          from: normalizeTronAddress(l.topics[1]!.slice(24)),
          to: normalizeTronAddress(l.topics[2]!.slice(24)),
          type: 'Transfer',
          value: BigInt(`0x${l.data}`).toString(),
        };
        if (this.historyIncludesBlock) row.block = Number(tx.blockNumber);
        rows.push({ sortKey: [tx.blockNumber, tx.index, i], row });
      });
    }
    rows.sort((a, b) => (a.sortKey[0] !== b.sortKey[0] ? (a.sortKey[0] < b.sortKey[0] ? -1 : 1) : a.sortKey[1] !== b.sortKey[1] ? a.sortKey[1] - b.sortKey[1] : a.sortKey[2] - b.sortKey[2]));
    if ((q.get('order_by') ?? 'block_timestamp,desc') === 'block_timestamp,desc') rows.reverse();
    return rows.map((r) => r.row);
  }

  #receipt(txHash: string, solidifiedOnly: boolean): Record<string, unknown> {
    const tx = this.#txs.get(txHash.toLowerCase());
    if (!tx || this.receiptsWithheld.has(tx.txHash)) return {};
    if (solidifiedOnly && tx.blockNumber > this.solidified) return {};
    const receipt: Record<string, unknown> = { energy_usage_total: 31_895, net_usage: 345 };
    if (!this.receiptResultOmitted.has(tx.txHash)) receipt.result = tx.result;
    const info: Record<string, unknown> = {
      id: tx.txHash,
      fee: 345_000,
      blockNumber: Number(tx.blockNumber),
      blockTimeStamp: this.blockTimestamp(tx.blockNumber),
      contractResult: [tx.result === 'SUCCESS' ? hex64(1n) : ''],
      contract_address: tx.logs[0] ? `41${tx.logs[0].address}` : tronAddressToHex(FAKE_USDT_CONTRACT),
      receipt,
    };
    if (tx.logs.length > 0) info.log = tx.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data }));
    if (tx.result !== 'SUCCESS') {
      info.result = 'FAILED';
      info.resMessage = Buffer.from('REVERT opcode executed').toString('hex');
    }
    return info;
  }

  #block(n: bigint): Record<string, unknown> {
    if (n < 0n || n > this.#head) return {};
    return {
      blockID: `${n.toString(16).padStart(16, '0')}${createHash('sha256').update(`block:${n}`).digest('hex').slice(16)}`,
      block_header: { raw_data: { number: Number(n), timestamp: this.blockTimestamp(n), witness_address: '41'.padEnd(42, '1') } },
    };
  }

  /** `fetch`-compatible handler. */
  readonly fetch: typeof fetch = async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const pathAndQuery = `${url.pathname}${url.search}`;
    this.requests.push(`${method} ${pathAndQuery}`);
    const fault = this.faults.find((f) => (f.times ?? 1) > 0 && (typeof f.match === 'string' ? pathAndQuery.includes(f.match) : f.match(pathAndQuery)));
    if (fault) {
      if (fault.times !== undefined) fault.times -= 1;
      if (fault.body !== undefined) return json(fault.body);
      if (fault.status === undefined) throw new TypeError('fetch failed: ECONNRESET');
      return new Response('{"Error":"fault"}', { status: fault.status, headers: { 'content-type': 'application/json' } });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const p = url.pathname;
    if (p === '/wallet/getnowblock') return json(this.#block(this.#head));
    if (p === '/walletsolidity/getnowblock') return json(this.#block(this.solidified));
    if (p === '/wallet/getblockbynum') return json(this.#block(BigInt(Number(body.num))));
    if (p === '/wallet/gettransactioninfobyid') return json(this.#receipt(String(body.value ?? ''), false));
    if (p === '/walletsolidity/gettransactioninfobyid') return json(this.#receipt(String(body.value ?? ''), true));
    if (p === '/walletsolidity/getaccount') {
      const address = normalizeTronAddress(String(body.address ?? ''));
      const sun = this.trx.get(address);
      return json(sun === undefined ? {} : { address: tronAddressToHex(address), balance: Number(sun) });
    }
    if (p === '/walletsolidity/triggerconstantcontract') {
      const contract = normalizeTronAddress(String(body.contract_address ?? ''));
      const param = String(body.parameter ?? '');
      const owner = normalizeTronAddress(param.slice(24, 64));
      return json({ result: { result: true }, energy_used: 935, constant_result: [hex64(this.balanceOf(owner, contract, this.solidified))] });
    }
    const history = /^\/v1\/accounts\/([^/]+)\/transactions\/trc20$/.exec(p);
    if (history) {
      const address = normalizeTronAddress(history[1]!);
      const all = this.#historyRows(address, url.searchParams);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20), 1), this.pageCap);
      const fp = url.searchParams.get('fingerprint');
      const offset = fp ? Number(JSON.parse(Buffer.from(fp, 'base64url').toString('utf8')).o) : 0;
      const page = all.slice(offset, offset + limit);
      const more = offset + limit < all.length || (this.fingerprintOnFullPage && page.length === limit);
      const meta: Record<string, unknown> = { at: Date.now(), page_size: page.length };
      if (more) {
        const nextOffset = this.fingerprintLoop ? offset : offset + limit;
        const fingerprint = Buffer.from(JSON.stringify({ o: nextOffset })).toString('base64url');
        const next = new URL(url.toString());
        next.searchParams.set('fingerprint', fingerprint);
        meta.fingerprint = fingerprint;
        meta.links = { next: next.toString() };
      }
      return json({ data: page, success: true, meta });
    }
    return new Response('{"Error":"not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
