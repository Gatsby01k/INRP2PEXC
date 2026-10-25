import { createHmac } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { DomainError, type TronAddress, encodeTronAddress, normalizeTronAddress, tronAddressToHex } from '@inrp2p/kernel';

/**
 * GasFree (ADR 0022): TRON's own relayer for TRC20 transfers whose network is paid in the token itself. A deal address
 * is the **GasFree account** of one of the exchange's HD keys — a contract address the `GasFreeController` derives from
 * that key with CREATE2 — so it never needs TRX: the exchange signs a `PermitTransfer` (TIP-712) with the key, a service
 * provider submits it, and the controller moves `value` to the receiver and its fee (a fixed USDT amount per transfer,
 * plus a one-time activation on the account's first transfer, both set on chain per token) to the provider — in one
 * transaction, from the account's own USDT. Nobody prepays anything.
 *
 * Everything that decides where money goes is computed here, locally, and held by the tests to the controller's own
 * views on mainnet (`getGasFreeAddress`, `getMessageHashForTransfer`): an address issued to a client, and the bytes the
 * signer signs, never come from the provider's API. The API only carries a signed permit and reports on it; what
 * happened is read from the chain.
 */

export interface GasFreeChain {
  readonly name: 'MAINNET' | 'NILE' | 'TEST';
  /** TIP-712 `chainId`: the low 32 bits of the genesis block id. */
  readonly chainId: bigint;
  readonly controller: TronAddress;
  readonly beacon: TronAddress;
  /** The account proxy's creation code (`GasFreeController.creationCode()`), hex without 0x. */
  readonly creationCode: string;
  /** The USDT contract the accounts hold. */
  readonly usdt: TronAddress;
  /** `https://open.gasfree.io/tron`, `https://open-test.gasfree.io/nile` — its path is part of every request signature. */
  readonly apiBase: string;
}

// The deployed account proxy (gasfree-sdk-js `constant/common.ts`, identical bytecode on both networks but for its metadata hash).
const PROXY = '60a06040908082526103e5803803809161001982856101d6565b833981019082818303126101d2576100308161020d565b91602091828101519060018060401b0382116101d2570181601f820112156101d25780519061005e8261022a565b9261006b875194856101d6565b8284528483830101116101d25783905f5b8381106101be5750505f9183010152823b1561017a5780516100b3575b50506080525161013c90816102a982396080518160180152f35b8351635c60da1b60e01b81529082826004816001600160a01b0388165afa918215610170575f9261012d575b50905f80838561011c9695519101845af4903d15610124573d6101018161022a565b9061010e885192836101d6565b81525f81943d92013e610245565b505f80610099565b60609250610245565b90918382813d8311610169575b61014481836101d6565b810103126101665750905f8061015d61011c959461020d565b939450506100df565b80fd5b503d61013a565b85513d5f823e3d90fd5b835162461bcd60e51b815260048101839052601b60248201527f626561636f6e2073686f756c64206265206120636f6e747261637400000000006044820152606490fd5b81810183015185820184015285920161007c565b5f80fd5b601f909101601f19168101906001600160401b038211908210176101f957604052565b634e487b7160e01b5f52604160045260245ffd5b516001600160a81b03811681036101d2576001600160a01b031690565b6001600160401b0381116101f957601f01601f191660200190565b9061026c575080511561025a57805190602001fd5b604051630a12f52160e11b8152600490fd5b8151158061029f575b61027d575090565b604051639996b31560e01b81526001600160a01b039091166004820152602490fd5b50803b1561027556fe60806040819052635c60da1b60e01b81526020816004817f00000000000000000000000000000000000000000000000000000000000000006001600160a01b03165afa9081156100ae575f91610056575b506100e8565b6020903d82116100a6575b601f8201601f1916810167ffffffffffffffff8111828210176100925761008c9350604052016100b9565b5f610050565b634e487b7160e01b84526041600452602484fd5b3d9150610061565b6040513d5f823e3d90fd5b602090607f1901126100e4576080516001600160a81b03811681036100e4576001600160a01b031690565b5f80fd5b5f808092368280378136915af43d82803e15610102573d90f35b3d90fdfea26474726f6e58221220';

export const GASFREE_MAINNET: GasFreeChain = Object.freeze({
  name: 'MAINNET',
  chainId: 0x2b6653dcn,
  controller: 'TFFAMQLZybALaLb4uxHA9RBE7pxhUAjF3U' as TronAddress,
  beacon: 'TSP9UW6FQhT76XD2jWA6ipGMx3yGbjDffP' as TronAddress,
  creationCode: `${PROXY}309a2919b7a1b203f1a7a1c544a7d671bb94b0adf8a39e4c9b6eeb6d03939ffe64736f6c63430008140033`,
  usdt: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' as TronAddress,
  apiBase: 'https://open.gasfree.io/tron',
});

export const GASFREE_NILE: GasFreeChain = Object.freeze({
  name: 'NILE',
  chainId: 0xcd8690dcn,
  controller: 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc' as TronAddress,
  beacon: 'TLtCGmaxH3PbuaF6kbybwteZcHptEdgQGC' as TronAddress,
  creationCode: `${PROXY}19fba3a984dfef08920adc4d0e531dbd369df1dec237bfb02ce668f5d8e2704064736f6c63430008140033`,
  usdt: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' as TronAddress,
  apiBase: 'https://open-test.gasfree.io/nile',
});

/** The deployment a controller address belongs to — how the web app knows which GasFree a recorded reading came from. */
export function gasFreeChainOfController(controller: string): GasFreeChain {
  const c = normalizeTronAddress(controller);
  const chain = [GASFREE_MAINNET, GASFREE_NILE].find((x) => x.controller === c);
  if (!chain) throw new DomainError('GASFREE_MISMATCH', `${c} is not a GasFree controller this exchange knows`);
  return chain;
}

const hexToBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const word = (n: bigint): string => {
  if (n < 0n || n >= 1n << 256n) throw new DomainError('INVALID_ARGUMENT', 'a uint256 is 0…2²⁵⁶−1');
  return n.toString(16).padStart(64, '0');
};
/** The 20-byte EVM form of a TRON address, as the controller sees it. */
const evm = (a: string): string => tronAddressToHex(normalizeTronAddress(a)).slice(2);
const keccakHex = (h: string): string => toHex(keccak_256(hexToBytes(h)));
/** The 32-byte ABI word of an address — the parameter of the controller's views (`nonces(address)`, `tokenFees(address)`). */
export const abiAddressWord = (a: string): string => evm(a).padStart(64, '0');
const keccakText = (s: string): string => toHex(keccak_256(new TextEncoder().encode(s)));

/**
 * The GasFree account of `user` (its owner, an HD key's address): `GasFreeController.getGasFreeAddress(user)`, computed
 * locally. CREATE2 with TRON's `0x41` prefix, salt = the owner's 20 bytes left-padded, and the proxy's init code =
 * creation code ‖ abi.encode(beacon, abi.encodeWithSignature("initialize(address)", owner)).
 */
export function gasFreeAddressOf(user: string, chain: GasFreeChain): TronAddress {
  const salt = evm(user).padStart(64, '0');
  const initialize = `${keccakText('initialize(address)').slice(0, 8)}${salt}`;
  const initLen = initialize.length / 2;
  const initPadded = initialize.padEnd(Math.ceil(initLen / 32) * 64, '0');
  const args = `${evm(chain.beacon).padStart(64, '0')}${word(64n)}${word(BigInt(initLen))}${initPadded}`;
  const bytecodeHash = keccakHex(`${chain.creationCode}${args}`);
  const address = keccakHex(`41${evm(chain.controller)}${salt}${bytecodeHash}`).slice(24);
  return encodeTronAddress(hexToBytes(address));
}

/** One `PermitTransfer`: what the owner of a GasFree account authorizes, and all of it. */
export interface GasFreePermit {
  readonly token: TronAddress;
  readonly serviceProvider: TronAddress;
  /** The account's owner — the HD key's address, not the GasFree account. */
  readonly user: TronAddress;
  readonly receiver: TronAddress;
  readonly value: bigint;
  /** The most the provider may take, activation included: the send's fixed cap. */
  readonly maxFee: bigint;
  /** Unix seconds; the controller refuses it after (`ExpiredSignature`). */
  readonly deadline: bigint;
  readonly version: bigint;
  readonly nonce: bigint;
}

export const GASFREE_PERMIT_VERSION = 1n;

const DOMAIN_TYPEHASH = keccakText('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const PERMIT_TYPEHASH = keccakText('PermitTransfer(address token,address serviceProvider,address user,address receiver,uint256 value,uint256 maxFee,uint256 deadline,uint256 version,uint256 nonce)');

/** The 32-byte TIP-712 digest the owner signs: `GasFreeController.getMessageHashForTransfer(...)`. */
export function permitDigest(p: GasFreePermit, chain: GasFreeChain): string {
  const domain = keccakHex(`${DOMAIN_TYPEHASH}${keccakText('GasFreeController')}${keccakText('V1.0.0')}${word(chain.chainId)}${evm(chain.controller).padStart(64, '0')}`);
  const struct = keccakHex([
    PERMIT_TYPEHASH, evm(p.token).padStart(64, '0'), evm(p.serviceProvider).padStart(64, '0'), evm(p.user).padStart(64, '0'), evm(p.receiver).padStart(64, '0'),
    word(p.value), word(p.maxFee), word(p.deadline), word(p.version), word(p.nonce),
  ].join(''));
  return keccakHex(`1901${domain}${struct}`);
}

/** Signs a permit's digest: secp256k1 over the digest itself, low-s, r ‖ s ‖ v with v = recovery id + 27 (hex, no 0x). */
export function signPermitDigest(digestHex: string, privateKey: Uint8Array): string {
  const digest = hexToBytes(digestHex);
  if (digest.length !== 32) throw new DomainError('INVALID_ARGUMENT', 'a permit digest is 32 bytes');
  const recovered = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, format: 'recovered' });
  return `${toHex(recovered.subarray(1, 65))}${(recovered[0]! + 27).toString(16).padStart(2, '0')}`;
}

/** The owner that signed a permit digest. */
export function recoverPermitSigner(digestHex: string, signatureHex: string): TronAddress {
  const sig = hexToBytes(signatureHex);
  if (sig.length !== 65) throw new DomainError('INVALID_ARGUMENT', 'a permit signature is 65 bytes');
  const recovery = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
  if (recovery !== 0 && recovery !== 1) throw new DomainError('INVALID_ARGUMENT', 'bad recovery id');
  const pub = secp256k1.recoverPublicKey(Uint8Array.from([recovery, ...sig.subarray(0, 64)]), hexToBytes(digestHex), { prehash: false });
  const point = secp256k1.Point.fromBytes(pub).toBytes(false);
  return encodeTronAddress(keccak_256(point.subarray(1)).subarray(12));
}

// ---- the provider's API ---------------------------------------------------------------------------------------

/** What the controller charges a token now (its smallest unit). */
export interface GasFreeFees {
  readonly transferFee: bigint;
  readonly activateFee: bigint;
}

export interface GasFreeAccount {
  readonly gasFreeAddress: TronAddress;
  readonly active: boolean;
  /** The nonce the next permit must carry. */
  readonly nonce: bigint;
  /** False while a permit of the account is still pending at the provider (one at a time). */
  readonly allowSubmit: boolean;
}

export type GasFreeTraceState = 'WAITING' | 'INPROGRESS' | 'CONFIRMING' | 'SUCCEED' | 'FAILED';

export interface GasFreeTrace {
  readonly id: string;
  readonly state: GasFreeTraceState;
  /** The transaction that carries it, once there is one. */
  readonly txid: string | null;
}

/** A submit the provider refused before anything reached the chain: nothing moved, nothing was charged. */
export interface GasFreeRefusal {
  readonly refused: true;
  readonly reason: string;
  readonly message: string;
}

export interface GasFreeService {
  readonly chain: GasFreeChain;
  /** The service provider every permit names (its on-chain address). */
  serviceProvider(): Promise<TronAddress>;
  account(user: TronAddress): Promise<GasFreeAccount>;
  submit(permit: GasFreePermit, signature: string, requestId: string): Promise<GasFreeTrace | GasFreeRefusal>;
  trace(id: string): Promise<GasFreeTrace>;
}

/** Refusals the API documents for a permit that never reached the chain. Anything else is not known to be final. */
const DEFINITE_REFUSALS = new Set([
  'ProviderAddressNotMatchException', 'DeadlineExceededException', 'InvalidSignatureException', 'UnsupportedTokenException',
  'TooManyPendingTransferException', 'VersionNotSupportedException', 'NonceNotMatchException', 'MaxFeeExceededException', 'InsufficientBalanceException',
]);

const TRACE_STATES: readonly GasFreeTraceState[] = ['WAITING', 'INPROGRESS', 'CONFIRMING', 'SUCCEED', 'FAILED'];

/**
 * GasFree's open API (`open.gasfree.io`, docs.gasfree.io): requests signed with the exchange's API key —
 * `Authorization: ApiKey {key}:{base64(HMAC-SHA256(secret, method ‖ path ‖ timestamp))}`, the path including the network
 * prefix (`/tron/api/v1/...`). Read-only but for `submit`, which carries a permit the signer already signed.
 */
export class GasFreeApi implements GasFreeService {
  readonly chain: GasFreeChain;
  readonly #key: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #provider: TronAddress | null = null;

  constructor(opts: { chain: GasFreeChain; apiKey: string; apiSecret: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!opts.apiKey || !opts.apiSecret) throw new DomainError('INVALID_ARGUMENT', 'GasFree needs its API key and secret');
    this.chain = opts.chain;
    this.#key = opts.apiKey;
    this.#secret = opts.apiSecret;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ code: number; reason: string | undefined; message: string | undefined; data: unknown }> {
    const url = new URL(`${this.chain.apiBase}${path}`);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', this.#secret).update(`${method}${url.pathname}${timestamp}`).digest('base64');
    let res: Response;
    try {
      res = await this.#fetch(url.toString(), {
        method, signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { 'Content-Type': 'application/json', Timestamp: timestamp, Authorization: `ApiKey ${this.#key}:${signature}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new DomainError('GASFREE_UNAVAILABLE', `GasFree did not answer ${method} ${path}: ${(e as Error).message}`, { transient: true });
    }
    let json: { code?: unknown; reason?: unknown; message?: unknown; data?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new DomainError('GASFREE_UNAVAILABLE', `GasFree answered ${method} ${path} with HTTP ${res.status} and no JSON`, { transient: true });
    }
    const code = typeof json.code === 'number' ? json.code : res.status;
    return { code, reason: typeof json.reason === 'string' ? json.reason : undefined, message: typeof json.message === 'string' ? json.message : undefined, data: json.data };
  }

  async #data(method: 'GET' | 'POST', path: string): Promise<Record<string, unknown>> {
    const r = await this.#call(method, path);
    if (r.code !== 200 || typeof r.data !== 'object' || r.data === null) {
      throw new DomainError('GASFREE_UNAVAILABLE', `GasFree ${path}: ${r.reason ?? r.code} ${r.message ?? ''}`.trim(), { transient: true });
    }
    return r.data as Record<string, unknown>;
  }

  async serviceProvider(): Promise<TronAddress> {
    if (this.#provider) return this.#provider;
    const data = await this.#data('GET', '/api/v1/config/provider/all');
    const first = Array.isArray(data.providers) ? (data.providers[0] as { address?: unknown } | undefined) : undefined;
    if (!first || typeof first.address !== 'string') throw new DomainError('GASFREE_UNAVAILABLE', 'GasFree lists no service provider', { transient: true });
    this.#provider = normalizeTronAddress(first.address);
    return this.#provider;
  }

  async account(user: TronAddress): Promise<GasFreeAccount> {
    const d = await this.#data('GET', `/api/v1/address/${user}`);
    const gasFreeAddress = normalizeTronAddress(d.gasFreeAddress);
    // The account the provider names must be the one the exchange computed: anything else is not where its USDT is.
    if (gasFreeAddress !== gasFreeAddressOf(user, this.chain)) throw new DomainError('GASFREE_MISMATCH', `GasFree names ${gasFreeAddress} for ${user}; the controller derives ${gasFreeAddressOf(user, this.chain)}`);
    return { gasFreeAddress, active: d.active === true, nonce: BigInt(String(d.nonce)), allowSubmit: d.allowSubmit !== false };
  }

  async submit(p: GasFreePermit, signature: string, requestId: string): Promise<GasFreeTrace | GasFreeRefusal> {
    const r = await this.#call('POST', '/api/v1/gasfree/submit', {
      requestId, token: p.token, serviceProvider: p.serviceProvider, user: p.user, receiver: p.receiver,
      value: p.value.toString(), maxFee: p.maxFee.toString(), deadline: Number(p.deadline), version: Number(p.version), nonce: Number(p.nonce), sig: signature,
    });
    if (r.code === 200 && typeof r.data === 'object' && r.data !== null) return traceOf(r.data as Record<string, unknown>);
    if (r.reason && DEFINITE_REFUSALS.has(r.reason)) return { refused: true, reason: r.reason, message: (r.message ?? '').slice(0, 300) };
    throw new DomainError('GASFREE_UNAVAILABLE', `GasFree submit: ${r.reason ?? r.code} ${r.message ?? ''}`.trim(), { transient: true });
  }

  async trace(id: string): Promise<GasFreeTrace> {
    return traceOf(await this.#data('GET', `/api/v1/gasfree/${encodeURIComponent(id)}`));
  }
}

function traceOf(d: Record<string, unknown>): GasFreeTrace {
  const state = String(d.state) as GasFreeTraceState;
  if (typeof d.id !== 'string' || !TRACE_STATES.includes(state)) throw new DomainError('GASFREE_UNAVAILABLE', 'GasFree answered without a trace id or state', { transient: true });
  const txid = typeof d.txnHash === 'string' && /^(0x)?[0-9a-fA-F]{64}$/.test(d.txnHash) ? d.txnHash.replace(/^0x/, '').toLowerCase() : null;
  return { id: d.id, state, txid };
}

/** The GasFree the worker is configured with: `GASFREE_API_KEY`, `GASFREE_API_SECRET`, `GASFREE_NETWORK` (mainnet|nile). */
export function gasFreeFromEnv(env: NodeJS.ProcessEnv): GasFreeApi | null {
  const key = env.GASFREE_API_KEY?.trim();
  const secret = env.GASFREE_API_SECRET?.trim();
  if (!key && !secret) return null;
  if (!key || !secret) throw new Error('GasFree needs both GASFREE_API_KEY and GASFREE_API_SECRET');
  const network = (env.GASFREE_NETWORK ?? 'mainnet').trim().toLowerCase();
  if (network !== 'mainnet' && network !== 'nile') throw new Error(`GASFREE_NETWORK is mainnet or nile, not ${network}`);
  return new GasFreeApi({ chain: network === 'nile' ? GASFREE_NILE : GASFREE_MAINNET, apiKey: key, apiSecret: secret });
}
