/**
 * TRON base58check addresses (mainnet version byte 0x41). Pure validation/encoding; no network access.
 * An address is valid only when its 4-byte double-SHA-256 checksum matches, so typos are rejected.
 */
import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));
const TRON_VERSION = 0x41;

declare const tronBrand: unique symbol;
export type TronAddress = string & { readonly [tronBrand]: 'TronAddress' };

function sha256d(buf: Uint8Array): Buffer {
  return createHash('sha256').update(createHash('sha256').update(buf).digest()).digest();
}

function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(parseInt((n % 256n).toString(), 10));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base58Encode(buf: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(buf).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[parseInt((n % 58n).toString(), 10)]! + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function isTronAddress(value: string): value is TronAddress {
  if (typeof value !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return false;
  const raw = base58Decode(value);
  if (!raw || raw.length !== 25 || raw[0] !== TRON_VERSION) return false;
  const checksum = sha256d(raw.subarray(0, 21)).subarray(0, 4);
  return Buffer.from(raw.subarray(21)).equals(checksum);
}

export function parseTronAddress(value: string): TronAddress {
  if (!isTronAddress(value)) throw new DomainError('INVALID_ADDRESS', 'not a valid TRON address');
  return value;
}

/** Encodes a 20-byte account id as a TRON address (used by fakes and fixtures). */
export function encodeTronAddress(accountId20: Uint8Array): TronAddress {
  if (accountId20.length !== 20) throw new DomainError('INVALID_ARGUMENT', 'TRON account id must be 20 bytes');
  const payload = Buffer.concat([Buffer.from([TRON_VERSION]), Buffer.from(accountId20)]);
  return base58Encode(Buffer.concat([payload, sha256d(payload).subarray(0, 4)])) as TronAddress;
}

/** The 21-byte hex form (`41` + 20-byte account id, lowercase, no `0x`) of a valid base58check address. */
export function tronAddressToHex(value: string): string {
  if (!isTronAddress(value)) throw new DomainError('INVALID_ADDRESS', 'not a valid TRON address');
  return Buffer.from(base58Decode(value)!.subarray(0, 21)).toString('hex');
}

/**
 * Normalizes the address forms TRON's own APIs document into the canonical base58check address — and nothing else:
 *
 * - base58check `T…` (34 characters), accepted only when its checksum verifies;
 * - the 21-byte hex form with the `41` version byte (42 hex characters, optionally `0x`-prefixed), as in a
 *   receipt's `contract_address` or a hex-mode API answer;
 * - the 20-byte hex form without the version byte (40 hex characters, optionally `0x`-prefixed), as in a receipt
 *   log's `address`, where TRON drops the `41` (developers.tron.network/docs/event).
 *
 * Any other length, alphabet or version byte is refused rather than trimmed or guessed: an address that has to be
 * repaired to fit is not evidence of where money went.
 */
export function normalizeTronAddress(value: unknown): TronAddress {
  if (typeof value !== 'string') throw new DomainError('INVALID_ADDRESS', 'a TRON address must be a string');
  if (value.startsWith('T')) return parseTronAddress(value);
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new DomainError('INVALID_ADDRESS', 'not a TRON address: neither base58check nor hex');
  if (hex.length === 42) {
    if (hex.slice(0, 2) !== '41') throw new DomainError('INVALID_ADDRESS', 'a 21-byte TRON address starts with the 41 version byte');
    return encodeTronAddress(Buffer.from(hex.slice(2), 'hex'));
  }
  if (hex.length === 40) return encodeTronAddress(Buffer.from(hex, 'hex'));
  throw new DomainError('INVALID_ADDRESS', `a hex TRON address has 40 or 42 hex characters, not ${hex.length}`);
}
