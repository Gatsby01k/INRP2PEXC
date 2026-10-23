/**
 * The address of a desk's page, `inrp2p.com/<handle>` (ADR 0020): 3 to 30 lower-case letters, digits and inner hyphens,
 * and never a path the site, the app or the desk already uses. Pure, so the request router can apply the same rule the
 * desk commands do; the database keeps the same list (migration 0040, `inrp2p_desk_handle_reserved`).
 */
export const DESK_HANDLE_SHAPE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export const RESERVED_DESK_HANDLES: ReadonlySet<string> = new Set([
  'about', 'account', 'accounts', 'admin', 'api', 'app', 'assets', 'become-a-trader', 'buy-usdt-in-india', 'clients', 'contact',
  'deal', 'deals', 'desk', 'desk-ops', 'desks', 'destinations', 'docs', 'escrow', 'exceptions', 'exchange', 'faq', 'health', 'help', 'history',
  'home', 'inr', 'inr-to-usdt', 'inrp2p', 'legal', 'link', 'links', 'login', 'logout', 'metrics', 'network', 'notifications',
  'official', 'open', 'open-account', 'orders', 'p2p', 'pnl', 'privacy', 'public-desk', 'quote', 'quotes', 'rates', 'register',
  'revenue', 'robots', 'root', 'sell-usdt-in-india', 'settings', 'sign-in', 'sign-up', 'signin', 'signup', 'sitemap', 'static', 'status',
  'support', 'system', 'team', 'terms', 'trader', 'trader-desk', 'traders', 'trades', 'usdt', 'usdt-otc-india', 'usdt-to-inr', 'www',
]);

/** A string that could be a desk's handle: the right shape, and not one of the reserved paths. */
export const isDeskHandle = (value: string): boolean => DESK_HANDLE_SHAPE.test(value) && !RESERVED_DESK_HANDLES.has(value);
