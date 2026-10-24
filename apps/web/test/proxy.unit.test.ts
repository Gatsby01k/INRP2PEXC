import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

/**
 * The proxy runs at the edge, in the region nearest the person — not where the database is. These run it with no
 * database configured at all: had it opened one, `DATABASE_URL is required` would fail every case. It only turns away
 * a request that carries no session cookie for its surface; whether a session is worth anything is the page's check.
 */
const ENV = { DESK_HOST: 'desk.inrp2p.test', APP_HOST: 'app.inrp2p.test', PUBLIC_HOST: 'inrp2p.test' } as const;
const saved: Record<string, string | undefined> = {};
let proxy: (request: NextRequest) => Response | Promise<Response>;

beforeAll(async () => {
  for (const k of [...Object.keys(ENV), 'DATABASE_URL']) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  delete process.env.DATABASE_URL;
  ({ proxy } = await import('../src/proxy.ts'));
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const DESK_COOKIE = `__Secure-inrp2p-desk.session_token=${'t'.repeat(32)}.${'s'.repeat(43)}=`;
const APP_COOKIE = `__Secure-inrp2p-app.session_token=${'t'.repeat(32)}.${'s'.repeat(43)}=`;

function req(host: string, path: string, opts: { cookie?: string; html?: boolean; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest(`https://${host}${path}`, {
    headers: {
      host,
      accept: opts.html ? 'text/html,application/xhtml+xml' : '*/*',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...opts.headers,
    },
  });
}

const passes = (r: Response) => r.headers.get('x-middleware-next') === '1';
/** A request header the proxy hands to the page (`NextResponse.next({ request: { headers } })`). */
const forwarded = (r: Response, name: string) => r.headers.get(`x-middleware-request-${name}`);

describe('the proxy reads no database', () => {
  it('sends a desk page request without a desk cookie to sign in, and refuses an API call with 401', async () => {
    const page = await proxy(req(ENV.DESK_HOST, '/rates', { html: true }));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get('location')!).pathname).toBe('/sign-in');

    const api = await proxy(req(ENV.DESK_HOST, '/api/operator/me'));
    expect(api.status).toBe(401);
    expect(await api.json()).toEqual({ error: 'UNAUTHENTICATED' });

    // A router fetch for a page (not HTML) gets the same refusal an API call does.
    expect((await proxy(req(ENV.DESK_HOST, '/orders?_rsc=abc', { headers: { rsc: '1' } }))).status).toBe(401);
  });

  it('lets a request with the desk cookie through to the page, whose own check decides', async () => {
    const r = await proxy(req(ENV.DESK_HOST, '/orders', { html: true, cookie: DESK_COOKIE }));
    expect(passes(r)).toBe(true);
    expect(r.headers.get('content-security-policy')).toContain('nonce-');
  });

  it('does not take the client cookie on the desk host, nor the desk cookie on the client host', async () => {
    expect((await proxy(req(ENV.DESK_HOST, '/api/operator/me', { cookie: APP_COOKIE }))).status).toBe(401);
    expect((await proxy(req(ENV.APP_HOST, '/api/client/me', { cookie: DESK_COOKIE }))).status).toBe(401);
  });

  it('refuses a session-only path on the public host whatever cookie it carries', async () => {
    expect((await proxy(req(ENV.PUBLIC_HOST, '/exchange', { cookie: APP_COOKIE }))).status).toBe(401);
  });

  it('keeps sign-in, the auth endpoints and the probes open', async () => {
    expect(passes(await proxy(req(ENV.DESK_HOST, '/sign-in', { html: true })))).toBe(true);
    expect(passes(await proxy(req(ENV.DESK_HOST, '/api/auth/sign-in/email')))).toBe(true);
    expect(passes(await proxy(req(ENV.DESK_HOST, '/api/health/live')))).toBe(true);
  });
});

describe('back to where a client was going (SECURITY §2.3a)', () => {
  it('a deep link without a session goes to sign in with it, as before', async () => {
    const r = await proxy(req(ENV.APP_HOST, '/desks/acme-otc?amount=500', { html: true }));
    const to = new URL(r.headers.get('location')!);
    expect(to.pathname).toBe('/sign-in');
    expect(to.searchParams.get('next')).toBe('/desks/acme-otc?amount=500');
  });

  it('hands the page the path, so a session that turns out to be over still comes back to it', async () => {
    const r = await proxy(req(ENV.APP_HOST, '/desks/acme-otc?amount=500&_rsc=xyz', { cookie: APP_COOKIE, headers: { rsc: '1' } }));
    expect(passes(r)).toBe(true);
    expect(forwarded(r, 'x-inrp2p-return')).toBe('/desks/acme-otc?amount=500');
  });

  it('never passes on a value the browser sent, and gives none for the Exchange itself', async () => {
    const forged = await proxy(req(ENV.APP_HOST, '/exchange', { cookie: APP_COOKIE, headers: { 'x-inrp2p-return': '//evil.example' } }));
    expect(passes(forged)).toBe(true);
    expect(forwarded(forged, 'x-inrp2p-return')).toBeNull();
    // The headers the page will see are exactly the listed ones: the browser's value is dropped, not merely unset.
    expect(forged.headers.get('x-middleware-override-headers')!.split(',')).not.toContain('x-inrp2p-return');
  });
});
