import { isDeskHandle } from '@inrp2p/kernel';
import { SITE_PATHS } from '../content/site.ts';
import { ACQUISITION_EVENT_PATH } from './acquisition.ts';

export { ACQUISITION_EVENT_PATH };

/**
 * Request classification for the proxy. Pure and exhaustively unit-tested: on the desk host every
 * path except Better Auth's own endpoints requires a fully MFA-verified operator session.
 */
export type Surface = 'OPERATOR' | 'CLIENT' | 'PUBLIC';
export type Gate = 'AUTH_ENDPOINT' | 'OPERATOR_SESSION' | 'CLIENT_SESSION' | 'PUBLIC' | 'OPERATOR_SIGN_IN' | 'CLIENT_SIGN_IN' | 'MONITORING';

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

/** Where a new trader starts, on the client app's host: email, code, application. */
export const TRADER_ENTRY_PATH = '/become-a-trader';

/**
 * The workspace's own sections, which live on the client app's host. Someone who types one on the public domain —
 * `inrp2p.com/traders` — is a person looking for the workspace, not a request to refuse: the proxy sends a page
 * request for one of these to the same path on the app's host, where the session (or the sign-in) is. Exact
 * sections and what is under them; anything else on the public host is still refused.
 */
const WORKSPACE_SECTIONS: readonly string[] = [
  '/sign-in',
  TRADER_ENTRY_PATH,
  '/exchange',
  '/history',
  '/destinations',
  '/accounts',
  '/account',
  '/notifications',
  '/open-account',
  '/traders',
  '/trades',
  '/desk',
  '/desks',
];

export const isWorkspacePath = (pathname: string): boolean => {
  const path = pathname.replace(/\/+$/, '') || '/';
  return WORKSPACE_SECTIONS.some((s) => path === s || path.startsWith(`${s}/`));
};

/** The shareable quote link (D-01): opening it authorizes nothing, so it is reachable without a session. */
export const isQuoteLinkPath = (path: string): boolean => path === '/q' || path.startsWith('/q/');

/** Where Telegram delivers the bot's updates, on the public host; the route checks Telegram's secret itself. */
export const TELEGRAM_WEBHOOK_PATH = '/api/telegram/webhook';

/** The market's USDT/INR rate the home page's converter estimates with (ADR 0025's reference), cached at the edge. */
export const MARKET_RATE_PATH = '/api/market-rate';

/**
 * India's USDT premium day by day, as the premium page shows it, for anyone to cite: the market's reference against the
 * ECB's dollar. Public host only; the route answers 404 anywhere else.
 */
export const PREMIUM_CSV_PATH = '/usdt-premium-india.csv';

/**
 * The premium page itself, which the masthead's ticker links to from every public page. Its own constant because the
 * ticker is shipped to the browser and the site's content is not; a test holds it to the page `content/site.ts` publishes.
 */
export const PREMIUM_PAGE_PATH = '/usdt-premium-india';

/**
 * The trader acquisition page (migration 0053): `inrp2p.com/traders` is its one address — the one every trader campaign
 * links to. It is rendered from `TRADERS_PAGE_PATH` by a rewrite in the proxy, as the home page is from `/home`, because
 * `/traders` in this build is the workspace's Traders screen; on the public host only that exact path is the page, and
 * everything under it (`/traders/orders`, …) still goes to the workspace. Two segments, so never a desk's handle.
 */
export const TRADERS_PATH = '/traders';
export const TRADERS_PAGE_PATH = '/lp/traders';

/**
 * Where the public host draws its page-not-found for an address it does not publish (`app/not-found.tsx`): a browser's
 * page request for one is rewritten here, so a person who types `inrp2p.com/about` gets the site's own page with a 404,
 * not a JSON refusal meant for an API call. Nothing is served at this path; arriving at it from outside draws the same.
 */
export const PUBLIC_MISSING_PATH = '/lp/missing';

/**
 * The home-screen icon (`app/apple-icon.png`), answered on every host: a phone asks for it when a page is saved, shared or
 * added to the home screen. Older phones and some crawlers ask for it by its old names without reading the page's link,
 * and those are served the same file.
 */
export const APPLE_ICON_PATH = '/apple-icon.png';
export const LEGACY_APPLE_ICON_PATHS: ReadonlySet<string> = new Set(['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']);

/** A desk's deal link (ADR 0020 §2.9): like the quote link, opening it authorizes nothing. */
export const isDealLinkPath = (path: string): boolean => path === '/d' || path.startsWith('/d/');

/**
 * A desk's own page, `inrp2p.com/<handle>` (ADR 0020 §2.10). One path segment in the shape of a handle — 3 to 30 lower-case
 * letters, digits and inner hyphens — that is not one of the site's, the app's or the desk's own paths (the kernel's
 * reserved list, which the database holds too). Those keep the gate they always had. Served from `DESK_PAGE_PREFIX/<handle>` by an internal rewrite, like `/home`.
 */
const HANDLE_PATH = /^\/([a-z0-9][a-z0-9-]{1,28}[a-z0-9])$/;
export const DESK_PAGE_PREFIX = '/public-desk';

export function deskHandleOfPath(path: string): string | null {
  const m = HANDLE_PATH.exec(path);
  if (!m || isPublicSitePath(path) || !isDeskHandle(m[1]!)) return null;
  return m[1]!;
}

/** The inside of that rewrite: one handle under the prefix, and nothing else. */
export const isDeskPagePath = (path: string): boolean => /^\/public-desk\/[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(path);

/**
 * The public site's own paths (PRODUCT §7.4), plus the two files a crawler asks for.
 *
 * This is an allow-list of exact paths, not a prefix: everything else on the public host is refused rather than
 * rendered, which is the rule Phase 7 established for that origin and the reason a page needing a session can
 * never appear on a host that never receives one.
 *
 * `/home` is in the list because it has to be: the home page is served at `/` by an internal rewrite, and Next
 * runs the proxy again on the rewritten path. It is not a second published URL — a request that arrives at
 * `/home` from outside is redirected to `/` (see the proxy), so the page keeps exactly one address. The trader
 * acquisition page's inside (`TRADERS_PAGE_PATH`, served at `/traders`) is listed for the same reason.
 */
const PUBLIC_SITE_PATHS: ReadonlySet<string> = new Set([...SITE_PATHS, '/home', TRADERS_PAGE_PATH]);

export const isPublicSitePath = (path: string): boolean => PUBLIC_SITE_PATHS.has(path);

/** Where `/` is served from on the public host. One-way: this path is not itself reachable. */
export const PUBLIC_HOME_PATH = '/home';

/**
 * The files a crawler asks for before anything else, and `llms.txt`, the same for an assistant. They are answered on
 * every host without a session, because a private app that replies `401` to `robots.txt` has told the crawler nothing —
 * and "nothing" is not "do not index me". Every handler decides what to say from the host: the private surfaces disallow
 * everything and publish no sitemap and no `llms.txt`, and none of the responses there contains a fact about the business.
 */
const CRAWLER_PATHS: ReadonlySet<string> = new Set(['/robots.txt', '/sitemap.xml', '/llms.txt']);

/**
 * Liveness and readiness, answered on every host without a session.
 *
 * A probe that needs a session cannot be used by the thing that decides whether this process is alive. These
 * two say yes or no and nothing else — no version, no error text, no business fact. `/api/health/status`, which
 * does carry figures, is deliberately **not** here: it authenticates itself with a token or an operator
 * session inside the route.
 */
const PROBE_PATHS: ReadonlySet<string> = new Set(['/api/health/live', '/api/health/ready']);

/**
 * The full health picture and its metrics, on the desk host only. They carry figures, so they are never public; they
 * authenticate inside the route — the monitoring token, or an operator session with `economics:view` — which is why the
 * proxy must let them through to it. Gating them on an operator session here made the token impossible to use: a
 * monitoring system has a token, not a session.
 */
const MONITORING_PATHS: ReadonlySet<string> = new Set(['/api/health/status', '/api/health/metrics']);

export function gateFor(surface: Surface, pathname: string): Gate {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (CRAWLER_PATHS.has(path) || PROBE_PATHS.has(path) || path === APPLE_ICON_PATH) return 'PUBLIC';
  if (surface === 'OPERATOR') {
    if (MONITORING_PATHS.has(path)) return 'MONITORING';
    if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'AUTH_ENDPOINT';
    // The sign-in page itself must be reachable without a session, or an operator can never get one. It is the
    // only unauthenticated page on the desk host, and it renders nothing about the business.
    if (path === '/sign-in') return 'OPERATOR_SIGN_IN';
    return 'OPERATOR_SESSION';
  }
  if (surface === 'CLIENT') {
    if (path === '/api/auth' || path.startsWith('/api/auth/')) return 'AUTH_ENDPOINT';
    // Same reasoning as the desk: without an unauthenticated sign-in page nobody can ever get a session. "Become a
    // trader" is the other way in: the same email code, for someone who has no workspace yet (docs/TRADERS.md §3).
    if (path === '/sign-in' || path === TRADER_ENTRY_PATH) return 'CLIENT_SIGN_IN';
    return 'CLIENT_SESSION';
  }
  // Public host: the site's own pages, the shareable quote link, a desk's page and its deal links, and nothing else.
  // Auth endpoints are not served here at all, and any other path is refused rather than rendered — a page that
  // needs a session has no business on a host that never receives one.
  // The Telegram bot's webhook authenticates itself with the secret Telegram sends (ADR 0020 §2.14).
  if (path === TELEGRAM_WEBHOOK_PATH || path === MARKET_RATE_PATH || path === ACQUISITION_EVENT_PATH || path === PREMIUM_CSV_PATH || path === PUBLIC_MISSING_PATH) return 'PUBLIC';
  return isQuoteLinkPath(path) || isDealLinkPath(path) || isPublicSitePath(path) || deskHandleOfPath(path) !== null || isDeskPagePath(path) ? 'PUBLIC' : 'CLIENT_SESSION';
}

/**
 * The request header the proxy writes on the client host with the path a person asked for, so that a page which finds
 * the session ended can send them to sign in and back. The proxy always overwrites it — a value a browser sent is never
 * passed on — and whoever reads it passes it through `safeReturnPath` again.
 */
export const RETURN_PATH_HEADER = 'x-inrp2p-return';

/**
 * Where to go back to after signing in (or opening an account) on the client host: the page the person was on when the
 * proxy sent them to sign in — a desk's page, a deal link. Only a path on this same host: one leading slash, never two,
 * no backslash or control character, not the sign-in itself or an API route, and short. Anything else is no path at all,
 * so this can never be used to send someone elsewhere.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > 512) return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  const path = value.split(/[?#]/)[0]!;
  if (path === '/sign-in' || path.startsWith('/sign-in/') || path === '/api' || path.startsWith('/api/')) return null;
  return value;
}
