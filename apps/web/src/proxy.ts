import { NextResponse, type NextRequest } from 'next/server';
import { requireClientSession, requireOperatorSession } from '@inrp2p/identity';
import { getRuntime } from './server/runtime.ts';
import { gateFor, surfaceForHost } from './server/surface.ts';
import { authErrorResponse } from './server/http.ts';

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
  // `/` is the desk's own page; on the client host it means the one screen a client came for. The two products
  // share a path space because they share a build, so the host decides what the root is.
  if (surface === 'CLIENT' && request.nextUrl.pathname === '/') {
    const to = request.nextUrl.clone();
    to.pathname = '/exchange';
    return NextResponse.redirect(to);
  }
  const gate = gateFor(surface, request.nextUrl.pathname);
  try {
    if (gate === 'OPERATOR_SESSION') await requireOperatorSession(rt.operatorAuth, rt.appDb, request.headers);
    else if (gate === 'CLIENT_SESSION') await requireClientSession(rt.clientAuth, rt.appDb, request.headers);
  } catch (err) {
    if ((gate === 'OPERATOR_SESSION' || gate === 'CLIENT_SESSION') && surface !== 'PUBLIC' && wantsHtml(request)) {
      const to = request.nextUrl.clone();
      to.pathname = '/sign-in';
      to.search = '';
      return NextResponse.redirect(to);
    }
    return authErrorResponse(err);
  }
  const res = NextResponse.next();
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('referrer-policy', 'no-referrer');
  res.headers.set('x-content-type-options', 'nosniff');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
