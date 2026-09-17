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
