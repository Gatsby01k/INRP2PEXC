import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { decodeAttribution } from '../src/server/acquisition.ts';

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

  it('sends a person who types a workspace section on the public domain to the same page on the app host', async () => {
    for (const path of ['/traders/orders/TO-260919-0006', '/traders/apply', '/become-a-trader', '/exchange', '/sign-in', '/desk/deals?tab=links']) {
      const r = await proxy(req(ENV.PUBLIC_HOST, path, { html: true }));
      expect(r.status, path).toBe(307);
      expect(r.headers.get('location'), path).toBe(`https://${ENV.APP_HOST}${path}`);
    }
    // Only a browser's page request, and only the workspace's own sections: anything else is still refused.
    expect((await proxy(req(ENV.PUBLIC_HOST, '/traders/orders'))).status).toBe(401);
    expect((await proxy(req(ENV.PUBLIC_HOST, '/api/client/me', { html: true }))).status).toBe(401);
    expect((await proxy(req(ENV.PUBLIC_HOST, '/orders/TO-1', { html: true }))).status).toBe(401);
    expect((await proxy(req(ENV.PUBLIC_HOST, '/settings/team', { html: true }))).status).toBe(401);
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

describe('the trader acquisition page (migration 0053)', () => {
  const rewrite = (r: Response) => r.headers.get('x-middleware-rewrite');
  const touchCookie = (r: Response) => /inrp2p_touch=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1] ?? null;

  it('serves `inrp2p.com/traders` itself — not the workspace — and remembers where the visitor came from', async () => {
    const r = await proxy(req(ENV.PUBLIC_HOST, '/traders?utm_source=Telegram&utm_medium=post&utm_campaign=Launch%20Day&ref=ABC&for=otc', { html: true }));
    expect(new URL(rewrite(r)!).pathname).toBe('/lp/traders');
    const cookie = touchCookie(r);
    expect(cookie).not.toBeNull();
    const a = decodeAttribution(cookie);
    expect(a?.first).toMatchObject({ source: 'telegram', medium: 'post', campaign: 'launch-day', ref: 'abc', click: null });
    expect(a?.segment).toBe('otc');
    // The page gets the same attribution in a header: on a first visit the cookie exists only on this response.
    expect(forwarded(r, 'x-inrp2p-touch')).toBe(cookie);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(r.headers.get('set-cookie')).toMatch(/SameSite=lax/i);
  });

  it('keeps the first touch and the visitor, and takes a new last touch only from a visit that says where it came from', async () => {
    const first = touchCookie(await proxy(req(ENV.PUBLIC_HOST, '/traders?utm_source=telegram', { html: true })))!;
    const direct = await proxy(req(ENV.PUBLIC_HOST, '/traders', { html: true, cookie: `inrp2p_touch=${first}` }));
    expect(touchCookie(direct)).toBeNull();
    expect(forwarded(direct, 'x-inrp2p-touch')).toBe(first);
    const again = await proxy(req(ENV.PUBLIC_HOST, '/traders?utm_source=linkedin&li_fat_id=abc-123', { html: true, cookie: `inrp2p_touch=${first}` }));
    const a = decodeAttribution(touchCookie(again))!;
    expect(a.visitor).toBe(decodeAttribution(first)!.visitor);
    expect(a.first.source).toBe('telegram');
    expect(a.last).toMatchObject({ source: 'linkedin', click: 'LINKEDIN', clickId: 'abc-123' });
  });

  it('reads a referring host, never its path, and not one of INRP2P’s own', async () => {
    const out = await proxy(req(ENV.PUBLIC_HOST, '/traders', { html: true, headers: { referer: 'https://www.linkedin.com/feed/update/urn:li:activity:1?x=secret' } }));
    expect(decodeAttribution(touchCookie(out))!.first.referrer).toBe('linkedin.com');
    const own = await proxy(req(ENV.PUBLIC_HOST, '/traders', { html: true, headers: { referer: `https://${ENV.PUBLIC_HOST}/usdt-to-inr` } }));
    expect(decodeAttribution(touchCookie(own))!.first.referrer).toBeNull();
  });

  it('has one address: the inside of the rewrite is sent back to it, and a forged attribution header never reaches a page', async () => {
    const inside = await proxy(req(ENV.PUBLIC_HOST, '/lp/traders?for=inr', { html: true }));
    expect(inside.status).toBe(308);
    expect(new URL(inside.headers.get('location')!).pathname).toBe('/traders');
    const forged = await proxy(req(ENV.PUBLIC_HOST, '/usdt-to-inr', { html: true, headers: { 'x-inrp2p-touch': 'forged' } }));
    expect(passes(forged)).toBe(true);
    expect(forwarded(forged, 'x-inrp2p-touch')).toBeNull();
  });

  it('carries the attribution into the app host’s own cookie at the trader sign-in, and cleans the address', async () => {
    const token = touchCookie(await proxy(req(ENV.PUBLIC_HOST, '/traders?utm_source=telegram&ref=partner-1', { html: true })))!;
    const r = await proxy(req(ENV.APP_HOST, `/become-a-trader?t=${token}&for=inr`, { html: true }));
    expect(r.status).toBe(307);
    const to = new URL(r.headers.get('location')!);
    expect(to.pathname).toBe('/become-a-trader');
    expect(to.searchParams.get('t')).toBeNull();
    expect(to.searchParams.get('for')).toBe('inr');
    const carried = decodeAttribution(touchCookie(r))!;
    expect(carried).toMatchObject({ visitor: decodeAttribution(token)!.visitor, segment: 'inr' });
    expect(carried.first).toMatchObject({ source: 'telegram', ref: 'partner-1' });
    // A token that is not an attribution is dropped: the address is still cleaned, and nothing is remembered.
    const bad = await proxy(req(ENV.APP_HOST, '/become-a-trader?t=not-a-token', { html: true }));
    expect(bad.status).toBe(307);
    expect(touchCookie(bad)).toBeNull();
  });
});
