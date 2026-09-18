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
    expect(gateFor('PUBLIC', '/')).toBe('PUBLIC');
  });
});
