import { SITE_PATHS } from '../content/site.ts';

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

/**
 * The public site's own paths (PRODUCT §7.4), plus the two files a crawler asks for.
 *
 * This is an allow-list of exact paths, not a prefix: everything else on the public host is refused rather than
 * rendered, which is the rule Phase 7 established for that origin and the reason a page needing a session can
 * never appear on a host that never receives one.
 *
 * `/home` is in the list because it has to be: the home page is served at `/` by an internal rewrite, and Next
 * runs the proxy again on the rewritten path. It is not a second published URL — a request that arrives at
 * `/home` from outside is redirected to `/` (see the proxy), so the page keeps exactly one address.
 */
const PUBLIC_SITE_PATHS: ReadonlySet<string> = new Set([...SITE_PATHS, '/home']);

export const isPublicSitePath = (path: string): boolean => PUBLIC_SITE_PATHS.has(path);

/** Where `/` is served from on the public host. One-way: this path is not itself reachable. */
export const PUBLIC_HOME_PATH = '/home';

/**
 * The two files a crawler asks for before anything else. They are answered on every host without a session,
 * because a private app that replies `401` to `robots.txt` has told the crawler nothing — and "nothing" is not
 * "do not index me". Both handlers decide what to say from the host: the private surfaces disallow everything
 * and publish no sitemap, and neither response contains a single fact about the business.
 */
const CRAWLER_PATHS: ReadonlySet<string> = new Set(['/robots.txt', '/sitemap.xml']);

/**
 * Liveness and readiness, answered on every host without a session.
 *
 * A probe that needs a session cannot be used by the thing that decides whether this process is alive. These
 * two say yes or no and nothing else — no version, no error text, no business fact. `/api/health/status`, which
 * does carry figures, is deliberately **not** here: it authenticates itself with a token or an operator
 * session inside the route.
 */
const PROBE_PATHS: ReadonlySet<string> = new Set(['/api/health/live', '/api/health/ready']);

export function gateFor(surface: Surface, pathname: string): Gate {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (CRAWLER_PATHS.has(path) || PROBE_PATHS.has(path)) return 'PUBLIC';
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
  // Public host: the site's own pages and the shareable quote link, and nothing else. Auth endpoints are not
  // served here at all, and any other path is refused rather than rendered — a page that needs a session has no
  // business on a host that never receives one.
  return isQuoteLinkPath(path) || isPublicSitePath(path) ? 'PUBLIC' : 'CLIENT_SESSION';
}
