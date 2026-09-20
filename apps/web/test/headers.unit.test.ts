import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, isHttps, securityHeaders } from '../src/server/headers.ts';
import type { Surface } from '../src/server/surface.ts';

/**
 * The headers are a control, so they are tested like one: not "does it contain the word", but "is every way of
 * getting code onto this page closed, on every surface, and is the one header that must never be sent over
 * plain http actually withheld".
 */
const SURFACES: readonly Surface[] = ['OPERATOR', 'CLIENT', 'PUBLIC'];
const ctx = (surface: Surface, https = true) => ({ surface, nonce: 'TESTNONCE', https });

const directives = (csp: string): Map<string, string> =>
  new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0]!, d]));

describe('the content security policy', () => {
  it.each(SURFACES)('%s: executes only scripts this page vouched for', (surface) => {
    const script = directives(contentSecurityPolicy(ctx(surface))).get('script-src')!;
    expect(script).toContain("'nonce-TESTNONCE'");
    expect(script).toContain("'strict-dynamic'");
    // The two that would make the nonce pointless.
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain('*');
  });

  it.each(SURFACES)('%s: closes the directives an injected page would reach for', (surface) => {
    const d = directives(contentSecurityPolicy(ctx(surface)));
    expect(d.get('default-src')).toBe("default-src 'self'");
    expect(d.get('object-src')).toBe("object-src 'none'");
    expect(d.get('base-uri')).toBe("base-uri 'none'");
    expect(d.get('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(d.get('frame-src')).toBe("frame-src 'none'");
    expect(d.get('form-action')).toBe("form-action 'self'");
    expect(d.get('connect-src')).toBe("connect-src 'self'");
  });

  it('is the same policy on every surface, so the marketing host is not the weak one', () => {
    const [operator, client, publicSite] = SURFACES.map((s) => contentSecurityPolicy(ctx(s)));
    expect(client).toBe(operator);
    expect(publicSite).toBe(operator);
  });

  it('upgrades insecure requests only where there is a secure request to upgrade to', () => {
    expect(contentSecurityPolicy(ctx('PUBLIC', true))).toContain('upgrade-insecure-requests');
    expect(contentSecurityPolicy(ctx('PUBLIC', false))).not.toContain('upgrade-insecure-requests');
  });

  it('gives every request its own nonce value', () => {
    expect(contentSecurityPolicy({ surface: 'OPERATOR', nonce: 'A', https: true })).toContain("'nonce-A'");
    expect(contentSecurityPolicy({ surface: 'OPERATOR', nonce: 'B', https: true })).toContain("'nonce-B'");
  });
});

describe('the rest of the headers', () => {
  it.each(SURFACES)('%s: refuses framing, sniffing and referrers', (surface) => {
    const h = securityHeaders(ctx(surface));
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('denies every browser capability this product does not use', () => {
    const policy = securityHeaders(ctx('CLIENT'))['permissions-policy']!;
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'publickey-credentials-get']) {
      expect(policy, feature).toContain(`${feature}=()`);
    }
    // Every entry is an empty allow-list; one with an origin in it would be a capability someone granted.
    for (const entry of policy.split(',')) expect(entry.trim()).toMatch(/^[a-z-]+=\(\)$/);
  });

  it('sends HSTS over https and never over plain http', () => {
    expect(securityHeaders(ctx('PUBLIC', true))['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');
    // On a local harness this header would be remembered by the developer's own browser for two years.
    expect(securityHeaders(ctx('PUBLIC', false))['strict-transport-security']).toBeUndefined();
  });
});

describe('deciding whether a request arrived over TLS', () => {
  it('believes the deployment’s own forwarded header first', () => {
    expect(isHttps({ proto: 'https', url: 'http://internal:3000/x' })).toBe(true);
    expect(isHttps({ proto: 'http', url: 'https://internal:3000/x' })).toBe(false);
    // A chain of proxies: the first entry is the one that faced the client.
    expect(isHttps({ proto: 'https, http', url: 'http://internal/x' })).toBe(true);
    expect(isHttps({ proto: 'HTTPS', url: 'http://internal/x' })).toBe(true);
  });

  it('falls back to the URL when nothing forwarded a protocol', () => {
    expect(isHttps({ proto: null, url: 'https://inrp2p.com/' })).toBe(true);
    expect(isHttps({ proto: '', url: 'http://127.0.0.1:3242/' })).toBe(false);
  });
});
