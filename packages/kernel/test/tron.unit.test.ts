import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeTronAddress, isTronAddress, parseTronAddress } from '../src/index.ts';

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
