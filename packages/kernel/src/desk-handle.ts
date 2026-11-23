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

/**
 * The public guides published after migration 0040 set the database's list: refused here, by every command that names a
 * desk, and folded into `inrp2p_desk_handle_reserved` by the next migration that touches desks — a release must not wait
 * on a migration only to reserve a few words no desk has asked for.
 */
export const RESERVED_GUIDE_HANDLES: ReadonlySet<string> = new Set([
  'is-inrp2p-safe', 'p2p-bank-account-freeze', 'p2p-merchant-india', 'usdt-p2p-scams', 'usdt-premium-india',
  'usdt-kaise-beche', 'usdt-kaise-kharide',
]);

/** Whether a handle is one of the site's or the app's own paths, and so never a desk's. */
export const isReservedHandle = (value: string): boolean => RESERVED_DESK_HANDLES.has(value) || RESERVED_GUIDE_HANDLES.has(value);

/** A string that could be a desk's handle: the right shape, and not one of the reserved paths. */
export const isDeskHandle = (value: string): boolean => DESK_HANDLE_SHAPE.test(value) && !isReservedHandle(value);
