import { describe, expect, it } from 'vitest';
import { RESERVED_DESK_HANDLES } from '@inrp2p/kernel';
import { DESK_PAGE_PREFIX, PUBLIC_HOME_PATH, deskHandleOfPath, gateFor, isDeskPagePath, safeReturnPath, surfaceForHost } from '../src/server/surface.ts';
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

  it('serves "Become a trader" without a session on the client host only, and nothing beneath it', () => {
    expect(gateFor('CLIENT', '/become-a-trader')).toBe('CLIENT_SIGN_IN');
    expect(gateFor('CLIENT', '/become-a-trader/')).toBe('CLIENT_SIGN_IN');
    for (const path of ['/become-a-trader/x', '/become-a-traderx', '/traders', '/traders/apply']) {
      expect(gateFor('CLIENT', path), path).toBe('CLIENT_SESSION');
    }
    expect(gateFor('PUBLIC', '/become-a-trader')).toBe('CLIENT_SESSION');
    expect(gateFor('OPERATOR', '/become-a-trader')).toBe('OPERATOR_SESSION');
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
    for (const path of ['/exchange', '/sign-in', '/qx', '/x/q/token', '/usdt-to-inr/x', '/api/auth', '/pnl', '/sitemap.xml.bak', '/Konkan', '/konkan/x', '/public-desk', '/public-desk/a/b']) {
      expect(gateFor('PUBLIC', path), `${path} must not be published`).toBe('CLIENT_SESSION');
    }
  });

  it('publishes a desk’s page at one segment in a handle’s shape, and its deal links (ADR 0020)', () => {
    expect(deskHandleOfPath('/konkan')).toBe('konkan');
    expect(gateFor('PUBLIC', '/konkan')).toBe('PUBLIC');
    expect(gateFor('PUBLIC', '/d/0ajAqF56tH9u3ObWXeE5gt')).toBe('PUBLIC');
    // The inside of its rewrite passes the gate; the proxy sends an outside request there back to `/<handle>`.
    expect(isDeskPagePath(`${DESK_PAGE_PREFIX}/konkan`)).toBe(true);
    expect(gateFor('PUBLIC', `${DESK_PAGE_PREFIX}/konkan`)).toBe('PUBLIC');
    // Never a site page, nor any path the site, the app or the desk keeps for itself; never on the other hosts.
    for (const path of SITE_PATHS) expect(deskHandleOfPath(path), path).toBeNull();
    for (const name of RESERVED_DESK_HANDLES) expect(deskHandleOfPath(`/${name}`), name).toBeNull();
    for (const path of ['/ab', '/-konkan', '/konkan-', '/KONKAN', '/konkan.html', '/konkan/', '/a'.repeat(1) + 'b'.repeat(30)]) expect(deskHandleOfPath(path), path).toBeNull();
    expect(gateFor('CLIENT', '/konkan')).toBe('CLIENT_SESSION');
    expect(gateFor('OPERATOR', '/konkan')).toBe('OPERATOR_SESSION');
  });

  it('goes back after signing in only to a path on the same host', () => {
    for (const ok of ['/desks/konkan?direction=SELL_USDT&amount=1000', '/d/0ajAqF56tH9u3ObWXeE5gt', '/trades/IX-260919-0011']) expect(safeReturnPath(ok), ok).toBe(ok);
    for (const bad of ['', '/', 'desks/konkan', '//evil.example/x', '/\\evil.example', 'https://evil.example', '/sign-in', '/sign-in?next=/x', '/api/auth/x', '/a\nb', '/'.padEnd(600, 'x'), 42, null]) {
      expect(safeReturnPath(bad), String(bad)).toBeNull();
    }
  });

  it('lets Telegram reach the bot’s webhook on the public host only', () => {
    expect(gateFor('PUBLIC', '/api/telegram/webhook')).toBe('PUBLIC');
    expect(gateFor('PUBLIC', '/api/telegram/webhook/x')).toBe('CLIENT_SESSION');
    expect(gateFor('CLIENT', '/api/telegram/webhook')).toBe('CLIENT_SESSION');
    expect(gateFor('OPERATOR', '/api/telegram/webhook')).toBe('OPERATOR_SESSION');
  });

  it('keeps every site page’s name out of the desks’ reach', () => {
    for (const path of SITE_PATHS.filter((p) => p !== '/')) expect(RESERVED_DESK_HANDLES.has(path.slice(1)), path).toBe(true);
  });

  it('answers liveness and readiness on every host, and guards the one that carries figures', () => {
    for (const surface of ['OPERATOR', 'CLIENT', 'PUBLIC'] as const) {
      expect(gateFor(surface, '/api/health/live'), surface).toBe('PUBLIC');
      expect(gateFor(surface, '/api/health/ready'), surface).toBe('PUBLIC');
      // `status` carries capacity, holds and scanner lag. It is never public; on the desk host the route
      // authenticates itself (token or operator session), and on the others it is behind a client session.
      expect(gateFor(surface, '/api/health/status'), surface).not.toBe('PUBLIC');
      expect(gateFor(surface, '/api/health/metrics'), surface).not.toBe('PUBLIC');
    }
    expect(gateFor('OPERATOR', '/api/health/status')).toBe('MONITORING');
    expect(gateFor('OPERATOR', '/api/health/metrics')).toBe('MONITORING');
    expect(gateFor('CLIENT', '/api/health/status')).toBe('CLIENT_SESSION');
    expect(gateFor('PUBLIC', '/api/health/metrics')).toBe('CLIENT_SESSION');
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
