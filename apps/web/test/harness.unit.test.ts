import { describe, expect, it } from 'vitest';
import { LOOPBACK_HOST, describeFetchFailure, deskBaseUrl, deskServerEnv, formatReadinessFailure, surfacePorts } from '../harness/desk-server.ts';
import { gateFor, surfaceForHost } from '../src/server/surface.ts';

/**
 * The harness that starts the built desk for the end-to-end and page-visual suites.
 *
 * These are not assertions about taste. The canonical visual job failed because the desk was told it was
 * `localhost` and the suite connected to whatever `localhost` resolved to in that container: the server reported
 * ready and nothing could reach it. The address the desk is told it is, the origin its auth trusts and the
 * address a suite browses have to be one literal address, and that is what is checked here.
 */
const ENV = deskServerEnv({ port: 3210, databaseUrl: 'postgres://postgres@127.0.0.1:5432/inrp2p_test', operatorAuthSecret: 'op', clientAuthSecret: 'cl' });

const hosts = { deskHost: ENV.DESK_HOST!, appHost: ENV.APP_HOST!, publicHost: ENV.PUBLIC_HOST! };

describe('desk harness configuration', () => {
  it('addresses every surface by a literal IPv4 loopback address, never a name to resolve', () => {
    expect(LOOPBACK_HOST).toMatch(/^127(\.\d{1,3}){3}$/);
    expect(deskBaseUrl(3210)).toBe('http://127.0.0.1:3210');
    for (const host of [ENV.DESK_HOST!, ENV.APP_HOST!, ENV.PUBLIC_HOST!]) {
      expect(host.split(':')[0]).toBe(LOOPBACK_HOST);
    }
  });

  it('gives each surface one origin: the host it is told it is, and the address a suite browses', () => {
    const ports = surfacePorts(3210);
    const pairs = [
      ['OPERATOR_BASE_URL', ENV.DESK_HOST!, ports.desk],
      ['CLIENT_BASE_URL', ENV.APP_HOST!, ports.app],
      ['CLIENT_LINK_BASE', ENV.PUBLIC_HOST!, ports.public],
    ] as const;
    for (const [key, host, port] of pairs) {
      const url = new URL(ENV[key]!);
      expect(url.protocol, key).toBe('http:');
      expect(url.host, key).toBe(host);
      expect(url.port, key).toBe(String(port));
      expect(deskBaseUrl(port)).toBe(url.origin);
    }
  });

  it('routes a request to the desk address as the operator surface, so /sign-in is reachable and the rest is guarded', () => {
    const browsed = new URL(ENV.OPERATOR_BASE_URL!).host;
    expect(surfaceForHost(browsed, hosts)).toBe('OPERATOR');
    expect(gateFor(surfaceForHost(browsed, hosts), '/sign-in')).toBe('OPERATOR_SIGN_IN');
    expect(gateFor(surfaceForHost(browsed, hosts), '/')).toBe('OPERATOR_SESSION');
    expect(gateFor(surfaceForHost(browsed, hosts), '/api/auth/sign-in/email')).toBe('AUTH_ENDPOINT');
  });

  it('keeps the three surfaces distinguishable, on one address and three ports', () => {
    expect(new Set([ENV.DESK_HOST, ENV.APP_HOST, ENV.PUBLIC_HOST]).size).toBe(3);
    expect(surfaceForHost(new URL(ENV.CLIENT_BASE_URL!).host, hosts)).toBe('CLIENT');
    expect(surfaceForHost(new URL(ENV.CLIENT_LINK_BASE!).host, hosts)).toBe('PUBLIC');
    // The public host publishes the quote link and refuses everything else, even though it is the same build.
    expect(gateFor('PUBLIC', '/q/AbCdEfGhIjKlMnOpQrStUv')).toBe('PUBLIC');
    expect(gateFor('PUBLIC', '/exchange')).toBe('CLIENT_SESSION');
  });

  it('passes the custody provider and field keys a client decision needs, and only when given', () => {
    expect(ENV.INRP2P_CUSTODY_PROVIDER).toBeUndefined();
    const configured = deskServerEnv({
      port: 3210,
      databaseUrl: ENV.DATABASE_URL!,
      operatorAuthSecret: 'op',
      clientAuthSecret: 'cl',
      custodyProvider: 'fake-custody',
      fieldKeys: { keyId: 'k', kekBase64: 'a', hmacBase64: 'b' },
      clientOtpSinkFile: '/tmp/otp.jsonl',
    });
    expect(configured.INRP2P_CUSTODY_PROVIDER).toBe('fake-custody');
    expect(configured.INRP2P_CUSTODY_CAPABILITY).toBe('POOL');
    expect(configured.INRP2P_KEK_ID).toBe('k');
    expect(configured.INRP2P_CLIENT_OTP_SINK_FILE).toBe('/tmp/otp.jsonl');
    // The sink is test-only, and the runtime refuses it in production; the harness never claims production.
    expect(configured.INRP2P_ENV?.toLowerCase()).not.toBe('production');
  });

  it('only ever allows insecure cookies outside production, which the runtime enforces', () => {
    expect(ENV.INRP2P_ALLOW_INSECURE_COOKIES).toBe('true');
    expect(ENV.INRP2P_ENV?.toLowerCase()).not.toBe('production');
  });

  it('passes the database and secrets through unchanged', () => {
    expect(ENV.DATABASE_URL).toBe('postgres://postgres@127.0.0.1:5432/inrp2p_test');
    expect(ENV.OPERATOR_AUTH_SECRET).toBe('op');
    expect(ENV.CLIENT_AUTH_SECRET).toBe('cl');
  });
});

describe('readiness diagnostics', () => {
  it('says where it was looking, for how long, and what the last answer was', () => {
    const message = formatReadinessFailure({
      label: 'desk:visual',
      url: 'http://127.0.0.1:3220/sign-in',
      elapsedMs: 60_000,
      attempts: 42,
      last: 'ECONNREFUSED: connect ECONNREFUSED ::1:3220',
      recent: ['▲ Next.js 16.3.5', '✓ Ready in 133ms'],
    });
    expect(message).toContain('http://127.0.0.1:3220/sign-in');
    expect(message).toContain('after 60s and 42 attempts');
    expect(message).toContain('last attempt: ECONNREFUSED: connect ECONNREFUSED ::1:3220');
    expect(message).toContain('✓ Ready in 133ms');
  });

  it('still reports something useful when the server said nothing', () => {
    const message = formatReadinessFailure({ label: 'desk', url: 'http://127.0.0.1:3210/sign-in', elapsedMs: 1_000, attempts: 1, last: 'HTTP 307 → /sign-in', recent: [] });
    expect(message).toContain('HTTP 307 → /sign-in');
    expect(message).toContain('server output: (nothing)');
  });

  it('names the transport failure rather than repeating "fetch failed"', async () => {
    // A high, unused port on loopback: refused immediately, no network and no waiting.
    const failure = await fetch('http://127.0.0.1:59437/', { signal: AbortSignal.timeout(2_000) }).catch((e: unknown) => describeFetchFailure(e));
    expect(failure).toMatch(/^(ECONNREFUSED|TimeoutError):/);
    expect(describeFetchFailure(new Error('plain'))).toBe('plain');
  });
});
