import { describe, expect, it } from 'vitest';
import { gateFor, surfaceForHost } from '../src/server/surface.ts';

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

  it('publishes the quote link on the public host, and nothing else (D-01)', () => {
    expect(gateFor('PUBLIC', '/q/AbCdEfGhIjKlMnOpQrStUv')).toBe('PUBLIC');
    expect(gateFor('PUBLIC', '/q')).toBe('PUBLIC');
    // Opening the link authorizes nothing, so it needs no session — but it is the only page published here.
    for (const path of ['/', '/exchange', '/sign-in', '/qx', '/x/q/token']) {
      expect(gateFor('PUBLIC', path)).toBe('CLIENT_SESSION');
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
