import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { DomainError, type TronAddress, encodeTronAddress, normalizeTronAddress, tronAddressToHex } from '@inrp2p/kernel';

/**
 * TRON transactions, built and read locally (ADR 0017 §4).
 *
 * The signer never asks a node to build what it signs: a node that builds the transaction decides what is signed.
 * Every byte here is laid out from the protocol's own messages (`core/Tron.proto`: `Transaction.raw`, `Contract`,
 * `TransferContract`, `TriggerSmartContract`), its txid is `sha256(raw_data)`, and the tests hold the bytes, the
 * txid and the signature to vectors produced by TronWeb itself. Knowing the txid before anything is broadcast is what
 * makes a retry safe: the same signed bytes are sent again, never a second transaction.
 *
 * Only the two transactions the exchange ever sends exist here: a TRX transfer (a top-up of a deal address, a
 * withdrawal of a trader's network deposit) and a TRC20 `transfer(address,uint256)` call (USDT).
 */

const TRANSFER_CONTRACT = 1;
const TRIGGER_SMART_CONTRACT = 31;
const TYPE_URL = {
  [TRANSFER_CONTRACT]: 'type.googleapis.com/protocol.TransferContract',
  [TRIGGER_SMART_CONTRACT]: 'type.googleapis.com/protocol.TriggerSmartContract',
} as const;
/** `transfer(address,uint256)` — the TRC20 selector, a public constant of the standard. */
const TRC20_TRANSFER_SELECTOR = 'a9059cbb';
const MAX_INT64 = (1n << 63n) - 1n;

// ---- a minimal protobuf writer and reader: varints, 64-bit integers and length-delimited fields only -------------

function varint(value: bigint): number[] {
  if (value < 0n) throw new DomainError('INVALID_ARGUMENT', 'protobuf varints here are never negative');
  const out: number[] = [];
  let v = value;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

class ProtoWriter {
  readonly #bytes: number[] = [];
  int(field: number, value: bigint): this {
    this.#bytes.push(...varint(BigInt(field << 3)), ...varint(value));
    return this;
  }
  bytes(field: number, value: Uint8Array): this {
    this.#bytes.push(...varint(BigInt((field << 3) | 2)), ...varint(BigInt(value.length)), ...value);
    return this;
  }
  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }
  finish(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

type ProtoValue = { wire: 0; value: bigint } | { wire: 2; value: Uint8Array };

function readProto(bytes: Uint8Array): Map<number, ProtoValue[]> {
  const fields = new Map<number, ProtoValue[]>();
  let i = 0;
  const readVarint = (): bigint => {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      if (i >= bytes.length) throw new DomainError('INVALID_ARGUMENT', 'truncated protobuf varint');
      const b = bytes[i++]!;
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new DomainError('INVALID_ARGUMENT', 'protobuf varint too long');
    }
  };
  while (i < bytes.length) {
    const key = readVarint();
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    let entry: ProtoValue;
    if (wire === 0) entry = { wire: 0, value: readVarint() };
    else if (wire === 2) {
      const len = Number(readVarint());
      if (i + len > bytes.length) throw new DomainError('INVALID_ARGUMENT', 'truncated protobuf field');
      entry = { wire: 2, value: bytes.subarray(i, i + len) };
      i += len;
    } else throw new DomainError('INVALID_ARGUMENT', `unsupported protobuf wire type ${wire}`);
    const list = fields.get(field) ?? [];
    list.push(entry);
    fields.set(field, list);
  }
  return fields;
}

const one = (fields: Map<number, ProtoValue[]>, field: number): ProtoValue | undefined => {
  const list = fields.get(field);
  if (list && list.length > 1) throw new DomainError('INVALID_ARGUMENT', `protobuf field ${field} repeated where one is expected`);
  return list?.[0];
};
const bytesOf = (fields: Map<number, ProtoValue[]>, field: number): Uint8Array | null => {
  const v = one(fields, field);
  if (!v) return null;
  if (v.wire !== 2) throw new DomainError('INVALID_ARGUMENT', `protobuf field ${field} is not bytes`);
  return v.value;
};
const intOf = (fields: Map<number, ProtoValue[]>, field: number): bigint => {
  const v = one(fields, field);
  if (!v) return 0n;
  if (v.wire !== 0) throw new DomainError('INVALID_ARGUMENT', `protobuf field ${field} is not an integer`);
  return v.value;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string, field: string): Uint8Array => {
  const s = h.toLowerCase().replace(/^0x/, '');
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new DomainError('INVALID_ARGUMENT', `${field} must be hex`);
  return Uint8Array.from(Buffer.from(s, 'hex'));
};
const address21 = (address: string): Uint8Array => fromHex(tronAddressToHex(normalizeTronAddress(address)), 'address');
const addressFrom21 = (b: Uint8Array): TronAddress => {
  if (b.length !== 21 || b[0] !== 0x41) throw new DomainError('INVALID_ARGUMENT', 'a TRON address in a transaction is 21 bytes starting 0x41');
  return encodeTronAddress(b.subarray(1));
};

// ---- the transactions ------------------------------------------------------------------------------------------

/** The block a transaction is anchored to (TAPOS): it is valid only on a chain that contains this block. */
export interface TronReferenceBlock {
  readonly number: bigint;
  /** The block id, 32 bytes hex. */
  readonly id: string;
  /** Block time, ms. */
  readonly timestamp: number;
}

export type TronTxContract =
  | { readonly kind: 'TRX'; readonly from: TronAddress; readonly to: TronAddress; readonly amountSun: bigint }
  | { readonly kind: 'TRC20'; readonly from: TronAddress; readonly contract: TronAddress; readonly to: TronAddress; readonly amountMinor: bigint };

export interface UnsignedTronTx {
  readonly rawDataHex: string;
  /** sha256(raw_data), hex — the transaction id the chain will know it by. */
  readonly txid: string;
  readonly contract: TronTxContract;
  readonly refBlockNum: bigint;
  /** ms since epoch: after this block time the transaction can never be included. */
  readonly expiration: number;
  readonly timestamp: number;
  readonly feeLimitSun: bigint | null;
}

function positive(value: bigint, field: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > MAX_INT64) throw new DomainError('INVALID_AMOUNT', `${field} must be a positive int64`);
  return value;
}

function anchor(ref: TronReferenceBlock): { refBlockBytes: Uint8Array; refBlockHash: Uint8Array } {
  if (ref.number <= 0n || ref.number > MAX_INT64) throw new DomainError('INVALID_ARGUMENT', 'reference block number out of range');
  const id = fromHex(ref.id, 'reference block id');
  if (id.length !== 32) throw new DomainError('INVALID_ARGUMENT', 'reference block id must be 32 bytes');
  const num = new Uint8Array(8);
  new DataView(num.buffer).setBigUint64(0, ref.number);
  return { refBlockBytes: num.subarray(6, 8), refBlockHash: id.subarray(8, 16) };
}

function rawData(input: { contract: Uint8Array; ref: TronReferenceBlock; expiration: number; timestamp: number; feeLimitSun: bigint | null }): Uint8Array {
  if (!Number.isSafeInteger(input.expiration) || !Number.isSafeInteger(input.timestamp) || input.expiration <= input.timestamp) {
    throw new DomainError('INVALID_ARGUMENT', 'expiration must be a later instant than the timestamp');
  }
  const { refBlockBytes, refBlockHash } = anchor(input.ref);
  const w = new ProtoWriter()
    .bytes(1, refBlockBytes)
    .bytes(4, refBlockHash)
    .int(8, BigInt(input.expiration))
    .bytes(11, input.contract)
    .int(14, BigInt(input.timestamp));
  if (input.feeLimitSun !== null) w.int(18, positive(input.feeLimitSun, 'fee limit'));
  return w.finish();
}

function contractMessage(type: typeof TRANSFER_CONTRACT | typeof TRIGGER_SMART_CONTRACT, parameter: Uint8Array): Uint8Array {
  const any = new ProtoWriter().string(1, TYPE_URL[type]).bytes(2, parameter).finish();
  return new ProtoWriter().int(1, BigInt(type)).bytes(2, any).finish();
}

/** The ABI call data of `transfer(to, amount)`. */
export function trc20TransferData(to: string, amountMinor: bigint): string {
  const account = tronAddressToHex(normalizeTronAddress(to)).slice(2);
  return `${TRC20_TRANSFER_SELECTOR}${account.padStart(64, '0')}${positive(amountMinor, 'amount').toString(16).padStart(64, '0')}`;
}

function finish(raw: Uint8Array, contract: TronTxContract, ref: TronReferenceBlock, expiration: number, timestamp: number, feeLimitSun: bigint | null): UnsignedTronTx {
  return Object.freeze({ rawDataHex: hex(raw), txid: hex(sha256(raw)), contract, refBlockNum: ref.number, expiration, timestamp, feeLimitSun });
}

/** A TRX `TransferContract`: `amountSun` from `from` to `to`. A new account is created (activated) by it. */
export function buildTrxTransfer(input: { from: string; to: string; amountSun: bigint; ref: TronReferenceBlock; expiration: number; timestamp: number }): UnsignedTronTx {
  const from = normalizeTronAddress(input.from);
  const to = normalizeTronAddress(input.to);
  if (from === to) throw new DomainError('INVALID_ARGUMENT', 'a transfer needs two different accounts');
  const amount = positive(input.amountSun, 'amount');
  const parameter = new ProtoWriter().bytes(1, address21(from)).bytes(2, address21(to)).int(3, amount).finish();
  const raw = rawData({ contract: contractMessage(TRANSFER_CONTRACT, parameter), ref: input.ref, expiration: input.expiration, timestamp: input.timestamp, feeLimitSun: null });
  return finish(raw, { kind: 'TRX', from, to, amountSun: amount }, input.ref, input.expiration, input.timestamp, null);
}

/** A TRC20 `transfer(to, amountMinor)` on `contract`, paid by `from`, burning at most `feeLimitSun` TRX for energy. */
export function buildTrc20Transfer(input: {
  from: string; contract: string; to: string; amountMinor: bigint; feeLimitSun: bigint; ref: TronReferenceBlock; expiration: number; timestamp: number;
}): UnsignedTronTx {
  const from = normalizeTronAddress(input.from);
  const contract = normalizeTronAddress(input.contract);
  const to = normalizeTronAddress(input.to);
  if (from === to) throw new DomainError('INVALID_ARGUMENT', 'a transfer needs two different accounts');
  const amount = positive(input.amountMinor, 'amount');
  const data = fromHex(trc20TransferData(to, amount), 'call data');
  const parameter = new ProtoWriter().bytes(1, address21(from)).bytes(2, address21(contract)).bytes(4, data).finish();
  const raw = rawData({ contract: contractMessage(TRIGGER_SMART_CONTRACT, parameter), ref: input.ref, expiration: input.expiration, timestamp: input.timestamp, feeLimitSun: input.feeLimitSun });
  return finish(raw, { kind: 'TRC20', from, contract, to, amountMinor: amount }, input.ref, input.expiration, input.timestamp, input.feeLimitSun);
}

/** The full signed `Transaction` message, hex — what `/wallet/broadcasthex` takes. */
export function signedTransactionHex(rawDataHex: string, signatureHex: string): string {
  const signature = fromHex(signatureHex, 'signature');
  if (signature.length !== 65) throw new DomainError('INVALID_ARGUMENT', 'a TRON signature is 65 bytes');
  return hex(new ProtoWriter().bytes(1, fromHex(rawDataHex, 'raw data')).bytes(2, signature).finish());
}

export interface DecodedTronTx extends UnsignedTronTx {
  readonly signatures: readonly string[];
}

/**
 * Reads a transaction back — a raw_data hex, or a signed `Transaction`. Only the two shapes this exchange sends are
 * understood; anything else (another contract type, several contracts, a call that is not `transfer`) is refused.
 */
export function decodeTronTransaction(input: { rawDataHex: string } | { signedHex: string }): DecodedTronTx {
  let raw: Uint8Array;
  let signatures: string[] = [];
  if ('signedHex' in input) {
    const tx = readProto(fromHex(input.signedHex, 'transaction'));
    raw = bytesOf(tx, 1) ?? new Uint8Array();
    signatures = (tx.get(2) ?? []).map((s) => {
      if (s.wire !== 2) throw new DomainError('INVALID_ARGUMENT', 'signature is not bytes');
      return hex(s.value);
    });
  } else {
    raw = fromHex(input.rawDataHex, 'raw data');
  }
  const r = readProto(raw);
  const refBlockBytes = bytesOf(r, 1);
  const refBlockHash = bytesOf(r, 4);
  if (!refBlockBytes || refBlockBytes.length !== 2 || !refBlockHash || refBlockHash.length !== 8) throw new DomainError('INVALID_ARGUMENT', 'transaction has no valid reference block');
  const contracts = r.get(11) ?? [];
  if (contracts.length !== 1 || contracts[0]!.wire !== 2) throw new DomainError('INVALID_ARGUMENT', 'a transaction carries exactly one contract');
  const c = readProto(contracts[0]!.value as Uint8Array);
  const type = Number(intOf(c, 1));
  const any = readProto(bytesOf(c, 2) ?? new Uint8Array());
  const typeUrl = new TextDecoder().decode(bytesOf(any, 1) ?? new Uint8Array());
  const p = readProto(bytesOf(any, 2) ?? new Uint8Array());
  let contract: TronTxContract;
  if (type === TRANSFER_CONTRACT && typeUrl === TYPE_URL[TRANSFER_CONTRACT]) {
    contract = { kind: 'TRX', from: addressFrom21(bytesOf(p, 1)!), to: addressFrom21(bytesOf(p, 2)!), amountSun: intOf(p, 3) };
  } else if (type === TRIGGER_SMART_CONTRACT && typeUrl === TYPE_URL[TRIGGER_SMART_CONTRACT]) {
    if (intOf(p, 3) !== 0n || intOf(p, 5) !== 0n || intOf(p, 6) !== 0n) throw new DomainError('INVALID_ARGUMENT', 'a TRC20 transfer carries no TRX or token value');
    const data = hex(bytesOf(p, 4) ?? new Uint8Array());
    if (data.length !== 8 + 128 || !data.startsWith(TRC20_TRANSFER_SELECTOR) || !/^0{24}$/.test(data.slice(8, 32))) {
      throw new DomainError('INVALID_ARGUMENT', 'the call is not transfer(address,uint256)');
    }
    contract = {
      kind: 'TRC20',
      from: addressFrom21(bytesOf(p, 1)!),
      contract: addressFrom21(bytesOf(p, 2)!),
      to: encodeTronAddress(fromHex(data.slice(32, 72), 'recipient')),
      amountMinor: BigInt(`0x${data.slice(72)}`),
    };
  } else {
    throw new DomainError('INVALID_ARGUMENT', `contract type ${type} (${typeUrl}) is not one this exchange sends`);
  }
  const feeLimit = intOf(r, 18);
  return Object.freeze({
    rawDataHex: hex(raw),
    txid: hex(sha256(raw)),
    contract,
    refBlockNum: BigInt(`0x${hex(refBlockBytes)}`),
    expiration: Number(intOf(r, 8)),
    timestamp: Number(intOf(r, 14)),
    feeLimitSun: feeLimit === 0n ? null : feeLimit,
    signatures,
  });
}

// ---- keys, addresses and signatures --------------------------------------------------------------------------

/** The TRON address of a secp256k1 public key (compressed or not): keccak256 of the 64-byte point, last 20 bytes. */
export function tronAddressOfPublicKey(publicKey: Uint8Array): TronAddress {
  const point = publicKey.length === 65 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  if (point.length !== 65 || point[0] !== 0x04) throw new DomainError('INVALID_ARGUMENT', 'not a secp256k1 public key');
  return encodeTronAddress(keccak_256(point.subarray(1)).subarray(12));
}

/**
 * Signs a txid the way TRON expects: deterministic (RFC 6979) secp256k1 over the 32-byte txid itself (no second hash),
 * low-s, encoded r ‖ s ‖ v with v = recovery id + 27.
 */
export function signTxid(txidHex: string, privateKey: Uint8Array): string {
  const digest = fromHex(txidHex, 'txid');
  if (digest.length !== 32) throw new DomainError('INVALID_ARGUMENT', 'a txid is 32 bytes');
  const recovered = secp256k1.sign(digest, privateKey, { prehash: false, lowS: true, format: 'recovered' });
  // noble's recovered format is recovery ‖ r ‖ s.
  return `${hex(recovered.subarray(1, 65))}${(recovered[0]! + 27).toString(16).padStart(2, '0')}`;
}

/** The address that signed a txid — what a node checks against the transaction's owner. */
export function recoverTxSigner(txidHex: string, signatureHex: string): TronAddress {
  const sig = fromHex(signatureHex, 'signature');
  if (sig.length !== 65) throw new DomainError('INVALID_ARGUMENT', 'a TRON signature is 65 bytes');
  const v = sig[64]!;
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new DomainError('INVALID_ARGUMENT', 'bad recovery id');
  const nobleSig = Uint8Array.from([recovery, ...sig.subarray(0, 64)]);
  const publicKey = secp256k1.recoverPublicKey(nobleSig, fromHex(txidHex, 'txid'), { prehash: false });
  return tronAddressOfPublicKey(publicKey);
}
