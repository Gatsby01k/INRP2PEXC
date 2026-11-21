import { NextResponse, type NextRequest } from 'next/server';
import { DomainError } from '@inrp2p/kernel';
import { carriesSessionCookie } from '@inrp2p/identity/session-cookie';
import { hostConfig } from './server/hosts.ts';
import {
  type Surface, DESK_PAGE_PREFIX, PUBLIC_HOME_PATH, RETURN_PATH_HEADER, TRADERS_PAGE_PATH, TRADERS_PATH, TRADER_ENTRY_PATH, deskHandleOfPath, gateFor, isDeskPagePath, isWorkspacePath,
  safeReturnPath, surfaceForHost,
} from './server/surface.ts';
import {
  SEGMENT_PARAM, TOUCH_COOKIE, TOUCH_HEADER, TOUCH_PARAM, arrive, carry, decodeAttribution, encodeAttribution, referrerHost, segmentOf, touchCookieOptions, touchOf,
} from './server/acquisition.ts';
import { contentSecurityPolicy, isHttps, securityHeaders } from './server/headers.ts';
import { authErrorResponse } from './server/http.ts';

/**
 * A fresh nonce per request. `crypto.randomUUID` is a CSPRNG and is available in the edge runtime; base64 is
 * what the CSP grammar expects. A reused nonce is the same as no nonce at all, so it is generated here — once
 * per request — and never cached, stored or derived from anything about the request.
 */
function newNonce(): string {
  return btoa(crypto.randomUUID().replaceAll('-', ''));
}

/** A page request (as opposed to an API call or a fetch for data) wants a sign-in screen, not a JSON error. */
function wantsHtml(request: NextRequest): boolean {
  return request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html') && !request.nextUrl.pathname.startsWith('/api/');
}

/**
 * Runs before every route — at the edge, in the region nearest the person, which is not where the database is. So it
 * reads no database. It classifies the host, sets the security headers and the CSP nonce, and on a host that needs a
 * session it turns away a request that carries no session cookie for that surface (to sign in, or a 401 for an API
 * call). That is a filter, not the control: every page, route handler and server action reads the session itself, next
 * to the database (`operatorContext` / `clientContext` → `requireOperatorSession` / `requireClientSession`: a live,
 * MFA-verified, non-idle session on this surface), and every command authorizes again inside its own transaction.
 *
 * It used to run that whole check here as well: five round trips to the database — one of them a write — on every
 * navigation, prefetch, refresh and action, across an ocean, before the page began.
 */
export function proxy(request: NextRequest) {
  const hosts = hostConfig();
  const surface = surfaceForHost(request.headers.get('host'), hosts);
  const nonce = newNonce();
  const https = isHttps({ proto: request.headers.get('x-forwarded-proto'), url: request.url });
  const headers = securityHeaders({ surface, nonce, https });
  // `/` is the desk's own page; on the client host it means the one screen a client came for. The two products
  // share a path space because they share a build, so the host decides what the root is.
  if (surface === 'CLIENT' && request.nextUrl.pathname === '/') {
    const to = request.nextUrl.clone();
    to.pathname = '/exchange';
    return withHeaders(NextResponse.redirect(to), headers);
  }
  const gate = gateFor(surface, request.nextUrl.pathname);
  // The public home page is rendered from `/home` because `/` in this build is the operator desk, and two route
  // groups cannot own one path. The rewrite keeps the URL at `/`, and `/home` itself is not in the public gate's
  // allow-list, so the page has exactly one address.
  if (surface === 'PUBLIC' && request.nextUrl.pathname === '/') {
    const to = request.nextUrl.clone();
    to.pathname = PUBLIC_HOME_PATH;
    return withHeaders(NextResponse.rewrite(to, { request: { headers: forwarded(request, surface, nonce, https) } }), headers);
  }
  // Next runs this proxy again on the rewritten path, so `/home` has to pass the gate — but only as the inside
  // of that rewrite. A request that arrives there from outside carries none of the headers the first pass set,
  // and is sent to the one address this page has. The header decides nothing about authority: `/home` is public
  // either way, so the worst a forged one achieves is the page the redirect would have delivered.
  if (surface === 'PUBLIC' && request.nextUrl.pathname === PUBLIC_HOME_PATH && !request.headers.get('x-inrp2p-nonce')) {
    const to = request.nextUrl.clone();
    to.pathname = '/';
    return withHeaders(NextResponse.redirect(to, 308), headers);
  }
  // The trader acquisition page (migration 0053): `inrp2p.com/traders` — the one address every trader campaign links to —
  // is rendered from TRADERS_PAGE_PATH, as `/` is from `/home`. Only that exact path: everything under it is still the
  // workspace's (below). The visitor's attribution — a random id, the campaign they arrived with first and last, the side
  // they came for — is read and remembered here in a first-party cookie, before the page renders; the page gets it in a
  // header, because on a first visit the cookie exists only on this response.
  if (surface === 'PUBLIC' && (request.nextUrl.pathname.replace(/\/+$/, '') || '/') === TRADERS_PATH) {
    const params = request.nextUrl.searchParams;
    const touch = touchOf(params, referrerHost(request.headers.get('referer'), [hosts.publicHost, hosts.appHost, hosts.deskHost]), Date.now());
    const { attribution, changed } = arrive(decodeAttribution(request.cookies.get(TOUCH_COOKIE)?.value), touch, segmentOf(params.get(SEGMENT_PARAM)), () => crypto.randomUUID());
    const encoded = encodeAttribution(attribution);
    const to = request.nextUrl.clone();
    to.pathname = TRADERS_PAGE_PATH;
    const inner = forwarded(request, surface, nonce, https);
    inner.set(TOUCH_HEADER, encoded);
    const response = NextResponse.rewrite(to, { request: { headers: inner } });
    if (changed) response.cookies.set(TOUCH_COOKIE, encoded, touchCookieOptions(https));
    return withHeaders(response, headers);
  }
  // As with `/home`, the inside of that rewrite is not a second address.
  if (surface === 'PUBLIC' && request.nextUrl.pathname === TRADERS_PAGE_PATH && !request.headers.get('x-inrp2p-nonce')) {
    const to = request.nextUrl.clone();
    to.pathname = TRADERS_PATH;
    return withHeaders(NextResponse.redirect(to, 308), headers);
  }
  // The page's calls to action bring the attribution to the trader sign-in on the app's host in its address (`?t=`): it
  // is remembered in this host's own cookie — the earlier first touch wins — and the address is cleaned of it, so what the
  // person sees, bookmarks or shares is the plain sign-in. A token that does not read as an attribution is dropped.
  if (surface === 'CLIENT' && request.method === 'GET' && request.nextUrl.pathname === TRADER_ENTRY_PATH && request.nextUrl.searchParams.has(TOUCH_PARAM)) {
    const carried = decodeAttribution(request.nextUrl.searchParams.get(TOUCH_PARAM));
    const to = request.nextUrl.clone();
    to.searchParams.delete(TOUCH_PARAM);
    const response = NextResponse.redirect(to, 307);
    if (carried) {
      const segment = segmentOf(request.nextUrl.searchParams.get(SEGMENT_PARAM)) ?? carried.segment;
      const merged = carry(decodeAttribution(request.cookies.get(TOUCH_COOKIE)?.value), { ...carried, segment });
      response.cookies.set(TOUCH_COOKIE, encodeAttribution(merged), touchCookieOptions(https));
    }
    return withHeaders(response, headers);
  }
  // A desk's page: `inrp2p.com/<handle>` is rendered from `/public-desk/<handle>` (ADR 0020), and — as with `/home` — the
  // inside of the rewrite is not a second address: arriving there from outside is sent to the one address it has.
  if (surface === 'PUBLIC') {
    const handle = deskHandleOfPath(request.nextUrl.pathname);
    if (handle) {
      const to = request.nextUrl.clone();
      to.pathname = `${DESK_PAGE_PREFIX}/${handle}`;
      return withHeaders(NextResponse.rewrite(to, { request: { headers: forwarded(request, surface, nonce, https) } }), headers);
    }
    if (isDeskPagePath(request.nextUrl.pathname) && !request.headers.get('x-inrp2p-nonce')) {
      const to = request.nextUrl.clone();
      to.pathname = request.nextUrl.pathname.slice(DESK_PAGE_PREFIX.length);
      return withHeaders(NextResponse.redirect(to, 308), headers);
    }
  }
  const needs: Surface | null = gate === 'OPERATOR_SESSION' ? 'OPERATOR' : gate === 'CLIENT_SESSION' ? 'CLIENT' : null;
  // A person who types a workspace section on the public domain (`inrp2p.com/traders`) is looking for the workspace:
  // a page request is sent to the same path on the app's host, where their session — or the sign-in — is. Only a
  // browser's page request, only the workspace's own sections, and only to the configured app host, so it can never
  // send anyone anywhere else. API calls and any other path are still refused below.
  if (surface === 'PUBLIC' && needs && wantsHtml(request) && hosts.appHost && isWorkspacePath(request.nextUrl.pathname)) {
    const to = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, `${https ? 'https' : 'http'}://${hosts.appHost}`);
    return withHeaders(NextResponse.redirect(to, 307), headers);
  }
  // The public host never receives a session cookie (they are host-only), so a path there that would need one is
  // refused whatever the request carries.
  if (needs && (surface === 'PUBLIC' || !carriesSessionCookie(request.headers, needs))) {
    if (surface !== 'PUBLIC' && wantsHtml(request)) {
      const to = request.nextUrl.clone();
      to.pathname = '/sign-in';
      to.search = '';
      const back = surface === 'CLIENT' ? returnPath(request) : null;
      if (back) to.searchParams.set('next', back);
      return withHeaders(NextResponse.redirect(to), headers);
    }
    return withHeaders(authErrorResponse(new DomainError('UNAUTHENTICATED')), headers);
  }
  return withHeaders(NextResponse.next({ request: { headers: forwarded(request, surface, nonce, https) } }), headers);
}

/**
 * On the client host the person comes back where they were going — a desk's page, a deal link — once signed in
 * (SECURITY §2.3a). The Exchange itself is where sign-in lands anyway. `_rsc` is the router's own cache-busting
 * parameter, never part of the address a person went to.
 */
function returnPath(request: NextRequest): string | null {
  const { pathname } = request.nextUrl;
  if (pathname === '/' || pathname === '/exchange') return null;
  const search = new URLSearchParams(request.nextUrl.search);
  search.delete('_rsc');
  const query = search.toString();
  return safeReturnPath(`${pathname}${query ? `?${query}` : ''}`);
}

/**
 * The request headers the rendered page sees.
 *
 * `x-inrp2p-nonce` is how a server component reaches the nonce for the one inline script this product serves
 * (the public site's structured data). `content-security-policy` on the **request** is how Next finds the same
 * nonce and puts it on its own bootstrap scripts — without it, `strict-dynamic` would block the framework and
 * every page would render as dead HTML.
 */
function forwarded(request: NextRequest, surface: Surface, nonce: string, https: boolean): Headers {
  const headers = new Headers(request.headers);
  headers.set('x-inrp2p-nonce', nonce);
  headers.set('content-security-policy', contentSecurityPolicy({ surface, nonce, https }));
  // Only ever the proxy's own value: one a browser sent is dropped before the page can read it.
  headers.delete(RETURN_PATH_HEADER);
  // The attribution the trader page reads is the proxy's too: dropped from anything but the inside of its own rewrite.
  if (!request.headers.get('x-inrp2p-nonce')) headers.delete(TOUCH_HEADER);
  const back = surface === 'CLIENT' ? returnPath(request) : null;
  if (back) headers.set(RETURN_PATH_HEADER, back);
  return headers;
}

function withHeaders(response: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
