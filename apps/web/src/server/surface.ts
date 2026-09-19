/**
 * Request classification for the proxy. Pure and exhaustively unit-tested: on the desk host every
 * path except Better Auth's own endpoints requires a fully MFA-verified operator session.
 */
export type Surface = 'OPERATOR' | 'CLIENT' | 'PUBLIC';
export type Gate = 'AUTH_ENDPOINT' | 'OPERATOR_SESSION' | 'CLIENT_SESSION' | 'PUBLIC' | 'OPERATOR_SIGN_IN' | 'CLIENT_SIGN_IN';

export interface HostConfig {
  deskHost: string;
  appHost: string;
  publicHost: string;
}

/**
 * Does this `Host` header name that surface?
 *
 * A configured host without a port matches the name whatever port the request came in on, which is what a
 * deployment behind a load balancer needs. A configured host **with** a port must match both, which is what lets
 * the three surfaces be told apart when they are all served from one address on different ports — the shape a
 * test harness has, and the only shape in which `127.0.0.1` can be three different surfaces at once.
 */
function matchesHost(host: string, configured: string): boolean {
  const c = configured.trim().toLowerCase();
  if (c === '') return false;
  return c.includes(':') ? host === c : (host.split(':')[0] ?? '') === c;
}

export function surfaceForHost(host: string | null, cfg: HostConfig): Surface {
  const h = (host ?? '').toLowerCase();
  if (matchesHost(h, cfg.deskHost)) return 'OPERATOR';
  if (matchesHost(h, cfg.appHost)) return 'CLIENT';
  return 'PUBLIC';
}

/** The shareable quote link (D-01): opening it authorizes nothing, so it is reachable without a session. */
export const isQuoteLinkPath = (path: string): boolean => path === '/q' || path.startsWith('/q/');

export function gateFor(surface: Surface, pathname: string): Gate {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (surface === 'OPERATOR') {
    if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'AUTH_ENDPOINT';
    // The sign-in page itself must be reachable without a session, or an operator can never get one. It is the
    // only unauthenticated page on the desk host, and it renders nothing about the business.
    if (path === '/sign-in') return 'OPERATOR_SIGN_IN';
    return 'OPERATOR_SESSION';
  }
  if (surface === 'CLIENT') {
    if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'AUTH_ENDPOINT';
    // Same reasoning as the desk: without an unauthenticated sign-in page nobody can ever get a session.
    if (path === '/sign-in') return 'CLIENT_SIGN_IN';
    return 'CLIENT_SESSION';
  }
  // Public host: the shareable quote link is the one thing published here. Auth endpoints are not served at all,
  // and anything else is refused rather than rendered — a page that needs a session has no business on a host
  // that never receives one.
  return isQuoteLinkPath(path) ? 'PUBLIC' : 'CLIENT_SESSION';
}
