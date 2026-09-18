/**
 * Request classification for the proxy. Pure and exhaustively unit-tested: on the desk host every
 * path except Better Auth's own endpoints requires a fully MFA-verified operator session.
 */
export type Surface = 'OPERATOR' | 'CLIENT' | 'PUBLIC';
export type Gate = 'AUTH_ENDPOINT' | 'OPERATOR_SESSION' | 'CLIENT_SESSION' | 'PUBLIC' | 'OPERATOR_SIGN_IN';

export interface HostConfig {
  deskHost: string;
  appHost: string;
  publicHost: string;
}

export function surfaceForHost(host: string | null, cfg: HostConfig): Surface {
  const h = (host ?? '').toLowerCase().split(':')[0];
  if (h === cfg.deskHost) return 'OPERATOR';
  if (h === cfg.appHost) return 'CLIENT';
  return 'PUBLIC';
}

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
    // Phase 1 exposes only API routes on the client host; client pages arrive in Phase 7.
    return 'CLIENT_SESSION';
  }
  // Public host: auth endpoints are not served here at all.
  return path.startsWith('/api/') ? 'CLIENT_SESSION' : 'PUBLIC';
}
