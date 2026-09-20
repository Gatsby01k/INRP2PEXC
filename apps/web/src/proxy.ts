import { NextResponse, type NextRequest } from 'next/server';
import { requireClientSession, requireOperatorSession } from '@inrp2p/identity';
import { getRuntime } from './server/runtime.ts';
import { type Surface, PUBLIC_HOME_PATH, gateFor, surfaceForHost } from './server/surface.ts';
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
 * Runs before every route. Desk host: every non-auth path requires a valid, MFA-verified,
 * non-idle operator session. Route handlers re-check (defense in depth) and commands authorize.
 */
export async function proxy(request: NextRequest) {
  const rt = getRuntime();
  const surface = surfaceForHost(request.headers.get('host'), rt.hosts);
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
  try {
    if (gate === 'OPERATOR_SESSION') await requireOperatorSession(rt.operatorAuth, rt.appDb, request.headers);
    else if (gate === 'CLIENT_SESSION') await requireClientSession(rt.clientAuth, rt.appDb, request.headers);
  } catch (err) {
    if ((gate === 'OPERATOR_SESSION' || gate === 'CLIENT_SESSION') && surface !== 'PUBLIC' && wantsHtml(request)) {
      const to = request.nextUrl.clone();
      to.pathname = '/sign-in';
      to.search = '';
      return withHeaders(NextResponse.redirect(to), headers);
    }
    return withHeaders(authErrorResponse(err), headers);
  }
  return withHeaders(NextResponse.next({ request: { headers: forwarded(request, surface, nonce, https) } }), headers);
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
  return headers;
}

function withHeaders(response: NextResponse, headers: Record<string, string>): NextResponse {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
