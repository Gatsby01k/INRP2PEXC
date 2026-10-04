import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeTronAddress, isTronAddress, normalizeTronAddress, parseTronAddress, tronAddressToHex } from '../src/index.ts';

describe('TRON addresses', () => {
  it('accepts a known mainnet address (USDT TRC20 contract)', () => {
    expect(isTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
  });

  it('round-trips generated addresses and rejects any single-character typo', () => {
    for (let i = 0; i < 50; i++) {
      const a = encodeTronAddress(randomBytes(20));
      expect(a).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
      expect(isTronAddress(a)).toBe(true);
      const pos = 5 + (i % 25);
      const swapped = a.slice(0, pos) + (a[pos] === 'a' ? 'b' : 'a') + a.slice(pos + 1);
      expect(isTronAddress(swapped)).toBe(false);
    }
  });

  it('rejects wrong length, alphabet and version', () => {
    for (const bad of ['', 'T', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6', '0R7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT']) {
      expect(isTronAddress(bad)).toBe(false);
    }
    expect(() => parseTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6x')).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }));
  });
});

describe('TRON address normalization (documented wire forms)', () => {
  // USDT on TRON mainnet, in the three forms TRON's APIs use for it.
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const USDT_HEX21 = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
  const USDT_HEX20 = USDT_HEX21.slice(2);

  it('maps base58, 21-byte hex and the 20-byte log form to one canonical address', () => {
    expect(tronAddressToHex(USDT)).toBe(USDT_HEX21);
    expect(normalizeTronAddress(USDT)).toBe(USDT);
    expect(normalizeTronAddress(USDT_HEX21)).toBe(USDT);
    expect(normalizeTronAddress(USDT_HEX21.toUpperCase())).toBe(USDT);
    expect(normalizeTronAddress(`0x${USDT_HEX21}`)).toBe(USDT);
    expect(normalizeTronAddress(USDT_HEX20)).toBe(USDT);
    expect(normalizeTronAddress(`0x${USDT_HEX20}`)).toBe(USDT);
  });

  it('round-trips random account ids through every form', () => {
    for (let i = 0; i < 25; i++) {
      const a = encodeTronAddress(randomBytes(20));
      const hex = tronAddressToHex(a);
      expect(hex).toMatch(/^41[0-9a-f]{40}$/);
      expect(normalizeTronAddress(hex)).toBe(a);
      expect(normalizeTronAddress(hex.slice(2))).toBe(a);
    }
  });

  it('refuses anything it would have to repair', () => {
    const bad = [
      '', '0x', 'T', `${USDT}x`, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6x', // bad checksum
      `42${USDT_HEX20}`, // wrong version byte
      USDT_HEX20.slice(1), `${USDT_HEX20}00`, // 39 and 42 without the version byte
      `${USDT_HEX21}00`, USDT_HEX21.slice(0, 41), // 44 and 41 characters
      `zz${USDT_HEX20}`, 'not an address', ` ${USDT}`, `${USDT_HEX20} `,
    ];
    for (const b of bad) expect(() => normalizeTronAddress(b), b).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }));
    for (const b of [undefined, null, 42, {}, ['T']]) expect(() => normalizeTronAddress(b)).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }));
    expect(() => tronAddressToHex(USDT_HEX21)).toThrow(expect.objectContaining({ code: 'INVALID_ADDRESS' }));
  });
});
