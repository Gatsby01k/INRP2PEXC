import { describe, expect, it } from 'vitest';
import { PUBLIC_HOME_PATH, gateFor, surfaceForHost } from '../src/server/surface.ts';
import { SITE_PATHS } from '../src/content/site.ts';

const hosts = { deskHost: 'desk.inrp2p.com', appHost: 'app.inrp2p.com', publicHost: 'inrp2p.com' };

describe('proxy gating', () => {
  it('maps hosts to surfaces (case-insensitive, port ignored)', () => {
    expect(surfaceForHost('DESK.inrp2p.com:443', hosts)).toBe('OPERATOR');
    expect(surfaceForHost('app.inrp2p.com', hosts)).toBe('CLIENT');
    expect(surfaceForHost('inrp2p.com', hosts)).toBe('PUBLIC');
    expect(surfaceForHost(null, hosts)).toBe('PUBLIC');
  });

  it.each(['/', '/desk', '/orders', '/api/operator/me', '/api/operator/x/y', '/api/authx', '/api/auth-bypass', '/API/AUTH/x', '/rates/'])(
    'desk path %s requires an MFA-verified operator session',
    (path) => {
      expect(gateFor('OPERATOR', path)).toBe('OPERATOR_SESSION');
    },
  );

  it.each(['/api/auth', '/api/auth/sign-in/email', '/api/auth/two-factor/verify-totp'])('desk auth endpoint %s is served by Better Auth', (path) => {
    expect(gateFor('OPERATOR', path)).toBe('AUTH_ENDPOINT');
  });

  it('serves only the sign-in page itself without a session, and nothing that looks like it', () => {
    expect(gateFor('OPERATOR', '/sign-in')).toBe('OPERATOR_SIGN_IN');
    expect(gateFor('OPERATOR', '/sign-in/')).toBe('OPERATOR_SIGN_IN');
    for (const path of ['/sign-in/x', '/sign-inx', '/x/sign-in', '/desk?next=/sign-in']) {
      expect(gateFor('OPERATOR', path)).toBe('OPERATOR_SESSION');
    }
  });

  it('client host APIs require a client session; the public host never serves auth', () => {
    expect(gateFor('CLIENT', '/api/client/me')).toBe('CLIENT_SESSION');
    expect(gateFor('CLIENT', '/api/auth/sign-in/email-otp')).toBe('AUTH_ENDPOINT');
    expect(gateFor('PUBLIC', '/api/auth/sign-in/email')).toBe('CLIENT_SESSION');
  });

  it('serves the client sign-in page without a session, and every other client page with one', () => {
    expect(gateFor('CLIENT', '/sign-in')).toBe('CLIENT_SIGN_IN');
    expect(gateFor('CLIENT', '/sign-in/')).toBe('CLIENT_SIGN_IN');
    for (const path of ['/', '/exchange', '/history', '/trades/IX-260916-1842', '/sign-in/x', '/sign-inx']) {
      expect(gateFor('CLIENT', path)).toBe('CLIENT_SESSION');
    }
  });

  it('publishes the quote link on the public host (D-01)', () => {
    expect(gateFor('PUBLIC', '/q/AbCdEfGhIjKlMnOpQrStUv')).toBe('PUBLIC');
    expect(gateFor('PUBLIC', '/q')).toBe('PUBLIC');
  });

  it('publishes the six site routes and nothing else (PRODUCT §7.4)', () => {
    for (const path of SITE_PATHS) {
      expect(gateFor('PUBLIC', path), `${path} must be published`).toBe('PUBLIC');
    }
    expect(SITE_PATHS).toHaveLength(6);
    // `/home` is the inside of the rewrite that serves `/`, and the proxy runs again on it, so it passes the
    // gate. It is not a second address: the proxy redirects a request that arrives there from outside.
    expect(gateFor('PUBLIC', PUBLIC_HOME_PATH)).toBe('PUBLIC');
    // Everything else on this host is refused rather than rendered — including anything that merely looks like
    // a published path.
    for (const path of ['/exchange', '/sign-in', '/qx', '/x/q/token', '/usdt-to-inr/x', '/usdt-to-inrx', '/api/auth', '/pnl', '/sitemap.xml.bak']) {
      expect(gateFor('PUBLIC', path), `${path} must not be published`).toBe('CLIENT_SESSION');
    }
  });

  it('answers liveness and readiness on every host, and guards the one that carries figures', () => {
    for (const surface of ['OPERATOR', 'CLIENT', 'PUBLIC'] as const) {
      expect(gateFor(surface, '/api/health/live'), surface).toBe('PUBLIC');
      expect(gateFor(surface, '/api/health/ready'), surface).toBe('PUBLIC');
      // `status` carries capacity, holds and scanner lag. It authenticates inside the route, and the proxy
      // does not wave it through on any host.
      expect(gateFor(surface, '/api/health/status'), surface).not.toBe('PUBLIC');
    }
  });

  it('answers the crawler files on every host without a session', () => {
    // A private app that replies 401 to robots.txt has told the crawler nothing, and nothing is not "do not
    // index me". Each handler decides what to say from the host; neither answer contains a business fact.
    for (const surface of ['OPERATOR', 'CLIENT', 'PUBLIC'] as const) {
      expect(gateFor(surface, '/robots.txt'), surface).toBe('PUBLIC');
      expect(gateFor(surface, '/sitemap.xml'), surface).toBe('PUBLIC');
    }
  });

  it('tells three surfaces apart on one address when the configured hosts carry ports', () => {
    // One machine, three ports: the shape a harness has, and the reason a configured port is compared.
    const local = { deskHost: '127.0.0.1:3220', appHost: '127.0.0.1:3221', publicHost: '127.0.0.1:3222' };
    expect(surfaceForHost('127.0.0.1:3220', local)).toBe('OPERATOR');
    expect(surfaceForHost('127.0.0.1:3221', local)).toBe('CLIENT');
    expect(surfaceForHost('127.0.0.1:3222', local)).toBe('PUBLIC');
    // An unknown port is not the desk, and must not inherit the desk's surface.
    expect(surfaceForHost('127.0.0.1:3999', local)).toBe('PUBLIC');
    expect(surfaceForHost('127.0.0.1', local)).toBe('PUBLIC');
  });

  it('keeps a port-less configured host matching every port, as a deployment behind a load balancer needs', () => {
    expect(surfaceForHost('desk.inrp2p.com', hosts)).toBe('OPERATOR');
    expect(surfaceForHost('desk.inrp2p.com:8443', hosts)).toBe('OPERATOR');
    expect(surfaceForHost('', hosts)).toBe('PUBLIC');
  });
});
