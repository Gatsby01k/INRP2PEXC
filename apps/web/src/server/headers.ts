import type { Surface } from './surface.ts';

/**
 * The response headers every request gets, and the policy behind them (SECURITY §7).
 *
 * Pure and unit-tested, because a security header is only as good as the one case nobody checked. The policy is
 * the same on all three surfaces, deliberately: a desk, a client app and a marketing page have different
 * contents but the same attack surface, and a weaker policy on the "just marketing" host is how an attacker
 * gets a foothold on a domain that shares a registrable domain with the rest.
 *
 * The one thing that varies by request rather than by surface is **HSTS**, which is only ever sent over https.
 * Sent over plain http it is ignored by browsers; sent from a local harness on `localhost` it would be
 * remembered by the developer's own browser and break every other plain-http thing they run for two years.
 */
export interface HeaderContext {
  readonly surface: Surface;
  /** Per-request CSP nonce, base64. The proxy generates one for every request that can render HTML. */
  readonly nonce: string;
  /** Whether this request arrived over https, as the deployment reports it. */
  readonly https: boolean;
}

/** Two years, subdomains included, preload-eligible — the values the preload list requires. */
const HSTS = 'max-age=63072000; includeSubDomains; preload';

/**
 * Capabilities this product never uses. Naming them explicitly is what makes the header worth sending: an
 * empty allow-list for a feature means no document on this origin — including one an attacker managed to
 * inject — can ask for it.
 */
const PERMISSIONS = [
  'accelerometer=()',
  'autoplay=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

export function contentSecurityPolicy(ctx: HeaderContext): string {
  const directives: string[] = [
    // Everything this product loads, it serves. There is no CDN, no analytics script and no embedded widget.
    "default-src 'self'",
    // `strict-dynamic` means the allow-list stops mattering once a nonced script runs: only scripts this page
    // vouched for, and the ones they load, execute. `'self'` stays for browsers that do not implement it.
    `script-src 'self' 'nonce-${ctx.nonce}' 'strict-dynamic'`,
    // Styles are the one place `unsafe-inline` remains, and only because components that draw a proportion — a
    // capacity meter, a settlement progress bar — set a width as a style attribute. A style cannot execute; the
    // reason to remove it eventually is defence in depth, not a live hole.
    "style-src 'self' 'unsafe-inline'",
    // `data:` is for the images the product generates itself (a QR code for a deposit address).
    "img-src 'self' data:",
    "font-src 'self'",
    // The desk and the client app call their own server actions and API routes; the public site calls nothing
    // at all — its only scripts are the home page hero's, which load their own code and the robot's recorded voice
    // clips, and fetch no data. One origin covers all three.
    "connect-src 'self'",
    "form-action 'self'",
    // Nothing here may be framed, and nothing here frames anything.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "media-src 'none'",
  ];
  if (ctx.https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function securityHeaders(ctx: HeaderContext): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': contentSecurityPolicy(ctx),
    // Superseded by `frame-ancestors` in modern browsers and still read by old ones. Both say the same thing.
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    // A quote link carries a token in its path, so no referrer may ever leave this origin — and since that is
    // the right answer for one surface, it is the answer for all of them.
    'referrer-policy': 'no-referrer',
    'permissions-policy': PERMISSIONS,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-dns-prefetch-control': 'off',
  };
  if (ctx.https) headers['strict-transport-security'] = HSTS;
  return headers;
}

/** True when the deployment says this request arrived over TLS. A proxy header is how a load balancer says so. */
export function isHttps(input: { proto: string | null; url: string }): boolean {
  const forwarded = (input.proto ?? '').split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  return input.url.startsWith('https:');
}
