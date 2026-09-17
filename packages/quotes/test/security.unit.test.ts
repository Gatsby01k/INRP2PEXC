import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_QUOTE_POLICY, FORBIDDEN_CLIENT_KEY, assertClientSafe, hashesEqual, linkTokenHash, maskEmailAddress, newLinkToken, newOtpCode, policyOf } from '../src/index.ts';

describe('link tokens (SECURITY §2.3)', () => {
  it('are 128-bit base62 and never stored in the clear', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const token = newLinkToken();
      expect(token).toMatch(/^[0-9A-Za-z]{22}$/);
      tokens.add(token);
      expect(linkTokenHash(token)).toBe(createHash('sha256').update(token).digest('hex'));
    }
    expect(tokens.size).toBe(500);
  });

  it('hash every input the same way, so a lookup cannot be steered by the shape of a guess', () => {
    for (const bad of ['', 'x', 'not-a-token', '../../etc/passwd', null, undefined, 42, {}]) {
      expect(linkTokenHash(bad)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(linkTokenHash(undefined)).toBe(linkTokenHash(''));
  });

  it('compare hashes in constant time and reject anything that is not a sha-256 hex digest', () => {
    const a = linkTokenHash('a');
    expect(hashesEqual(a, a)).toBe(true);
    expect(hashesEqual(a, linkTokenHash('b'))).toBe(false);
    expect(hashesEqual(a, '')).toBe(false);
    expect(hashesEqual(a, a.slice(0, 62))).toBe(false);
  });
});

describe('acceptance codes', () => {
  it('are six digits, uniformly generated and zero-padded', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = newOtpCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(1900);
  });

  it('mask the destination to one leading character and the domain', () => {
    expect(maskEmailAddress('priya@acmepay.test')).toBe('p•••@acmepay.test');
    expect(maskEmailAddress('a@b.test')).toBe('a•••@b.test');
  });
});

describe('client projections (S5)', () => {
  it('reject any internal key, at any depth', () => {
    expect(() => assertClientSafe({ ref: 'QT-1', nested: [{ route_id: 'x' }] })).toThrow(/leaks key/);
    expect(() => assertClientSafe({ grossMarginInr: '1' })).toThrow(/leaks key/);
    expect(() => assertClientSafe({ providerMessageId: 'x' })).toThrow(/leaks key/);
    expect(() => assertClientSafe({ ref: 'QT-1', base: { amount: '1', currency: 'USDT' }, destination: 'HDFC •••• 8219' })).not.toThrow();
    for (const key of ['route_id', 'routeRate', 'margin', 'snapshotId', 'custodyProvider', 'dealerId', 'obligationRef', 'executionMode', 'referenceRate', 'created_by', 'account_number_enc', 'code_hash']) {
      expect(FORBIDDEN_CLIENT_KEY.test(key)).toBe(true);
    }
  });
});

describe('quote policy', () => {
  it('defaults match the approved decisions and are overridable per deployment', () => {
    expect(DEFAULT_QUOTE_POLICY).toMatchObject({ linkDefaultValiditySeconds: 180, linkMinValiditySeconds: 120, otpTtlSeconds: 300, otpMaxSendsPerQuoteWindow: 3, otpSendWindowSeconds: 600, linkOpensPerIpPerMinute: 30, otpSendsPerIpPerHour: 10, decisionsPerTokenPerMinute: 5 });
    expect(policyOf({ policy: { linkMinValiditySeconds: 150 } })).toMatchObject({ linkMinValiditySeconds: 150, linkDefaultValiditySeconds: 180 });
    expect(policyOf({})).toEqual(DEFAULT_QUOTE_POLICY);
  });
});
