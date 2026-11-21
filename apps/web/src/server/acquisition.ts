/**
 * Where a trader came from (migration 0053): the touch a visitor arrives at `inrp2p.com/traders` with, carried to the
 * trader sign-in on the app's host and, once they sign in, tied to who they are — so a campaign can be followed from a
 * Telegram post to a verified, collateralized, active trader.
 *
 * Pure and edge-safe: the proxy uses it before any page renders, and the database writes are elsewhere
 * (`acquisition-record.ts`). Everything that arrives here — a URL's parameters, a `Referer`, a cookie, a token in a link —
 * is somebody's input: each value is cut to a small alphabet and a length, and anything else is no value at all. What is
 * kept is a campaign's own words, a referral code, which ad network a click came from, and a referring host. Never an
 * address, an email, a name or an amount.
 */

/** The first-party cookie that carries a visitor's id and touches, on whichever host it was set. */
export const TOUCH_COOKIE = 'inrp2p_touch';
/** How the proxy hands the current attribution to the page it rewrites to (the cookie is only on the response yet). */
export const TOUCH_HEADER = 'x-inrp2p-touch';
/** The parameter the page's calls to action carry the attribution in, from the public host to the app's. */
export const TOUCH_PARAM = 't';
/** The side of the business a visitor came for: `?for=usdt|inr|otc` — campaigns may link straight to one. */
export const SEGMENT_PARAM = 'for';
/** Where the acquisition page's browser tells the server what a visitor did — on the public host, with its own cookie. */
export const ACQUISITION_EVENT_PATH = '/api/acquisition';
/** Long enough for a trader who reads now and applies next month. */
export const TOUCH_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export const SEGMENTS = ['usdt', 'inr', 'otc'] as const;
export type Segment = (typeof SEGMENTS)[number];

export const segmentOf = (value: unknown): Segment | null => {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (SEGMENTS as readonly string[]).includes(v) ? (v as Segment) : null;
};

/** The application's word for a segment, as the database stores it. */
export const segmentCode = (s: Segment | null): 'USDT' | 'INR' | 'OTC' | null => (s ? (s.toUpperCase() as 'USDT' | 'INR' | 'OTC') : null);

export const CLICK_KINDS = ['GOOGLE', 'META', 'LINKEDIN', 'MICROSOFT', 'TIKTOK', 'X'] as const;
export type ClickKind = (typeof CLICK_KINDS)[number];

/** Each ad network's click parameter, and whose it is. The first one present wins. */
const CLICK_PARAMS: readonly (readonly [string, ClickKind])[] = [
  ['gclid', 'GOOGLE'],
  ['gbraid', 'GOOGLE'],
  ['wbraid', 'GOOGLE'],
  ['fbclid', 'META'],
  ['li_fat_id', 'LINKEDIN'],
  ['msclkid', 'MICROSOFT'],
  ['ttclid', 'TIKTOK'],
  ['twclid', 'X'],
];

export interface Touch {
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
  readonly content: string | null;
  readonly term: string | null;
  /** A partner's or a trader's referral code: `?ref=`. */
  readonly ref: string | null;
  readonly click: ClickKind | null;
  readonly clickId: string | null;
  /** The referring page's host, outside INRP2P's own. */
  readonly referrer: string | null;
  /** Seconds since the epoch. */
  readonly at: number;
}

export interface Attribution {
  /** A random id for this browser; it names nobody. */
  readonly visitor: string;
  readonly first: Touch;
  readonly last: Touch;
  readonly segment: Segment | null;
}

const WORD = /^[a-z0-9._~+-]{1,64}$/;
const REF = /^[a-z0-9_-]{1,40}$/;
const CLICK_ID = /^[A-Za-z0-9._~-]{1,200}$/;
const HOST = /^[a-z0-9.-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** No touch is older than the product's public site. */
const EARLIEST = Date.UTC(2026, 0, 1) / 1000;

/** A campaign's word: lower-cased, spaces as hyphens, and only if what is left is in the alphabet. */
export function word(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase().replace(/\s+/g, '-');
  return WORD.test(v) ? v : null;
}

export function refCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return REF.test(v) ? v : null;
}

const clickId = (value: unknown): string | null => (typeof value === 'string' && CLICK_ID.test(value.trim()) ? value.trim() : null);
const clickKind = (value: unknown): ClickKind | null => ((CLICK_KINDS as readonly unknown[]).includes(value) ? (value as ClickKind) : null);
const host = (value: unknown): string | null => (typeof value === 'string' && HOST.test(value) ? value : null);

/** A `Referer` as a host, unless it is one of INRP2P's own (moving between its pages is not a touch). */
export function referrerHost(referer: string | null | undefined, ownHosts: readonly string[]): string | null {
  if (!referer) return null;
  let h: string;
  try {
    h = new URL(referer).hostname.toLowerCase();
  } catch {
    return null;
  }
  h = h.replace(/^www\./, '');
  const own = ownHosts.map((o) => o.toLowerCase().split(':')[0]!.replace(/^www\./, '')).filter(Boolean);
  if (own.some((o) => h === o || h.endsWith(`.${o}`))) return null;
  return host(h);
}

/** Whether a touch says anything about where the visitor came from: a direct visit does not replace the last real one. */
export const hasSignal = (t: Touch): boolean =>
  Boolean(t.source || t.medium || t.campaign || t.content || t.term || t.ref || t.click || t.referrer);

/** The touch a request arrives with: its `utm_*`, `ref` and click parameters, and where it was referred from. */
export function touchOf(params: URLSearchParams, referrer: string | null, now: number): Touch {
  let click: ClickKind | null = null;
  let id: string | null = null;
  for (const [name, kind] of CLICK_PARAMS) {
    const v = clickId(params.get(name));
    if (v) {
      click = kind;
      id = v;
      break;
    }
  }
  return {
    source: word(params.get('utm_source')),
    medium: word(params.get('utm_medium')),
    campaign: word(params.get('utm_campaign')),
    content: word(params.get('utm_content')),
    term: word(params.get('utm_term')),
    ref: refCode(params.get('ref')),
    click,
    clickId: id,
    referrer,
    at: Math.floor(now / 1000),
  };
}

/**
 * The attribution after this arrival. A visitor seen for the first time gets a new id and this touch as both first and
 * last; one seen before keeps its id and first touch, and this touch becomes its last only when it says where they came
 * from. A segment named in the address replaces the one remembered. `changed` says whether the cookie needs writing.
 */
export function arrive(
  existing: Attribution | null,
  touch: Touch,
  segment: Segment | null,
  newVisitor: () => string,
): { readonly attribution: Attribution; readonly changed: boolean } {
  if (!existing) return { attribution: { visitor: newVisitor(), first: touch, last: touch, segment }, changed: true };
  const last = hasSignal(touch) ? touch : existing.last;
  const seg = segment ?? existing.segment;
  const changed = last !== existing.last || seg !== existing.segment;
  return { attribution: { ...existing, last, segment: seg }, changed };
}

/**
 * The attribution a link carried from the public host, set beside what the app's host already remembers. The earlier
 * first touch wins — with its visitor id — and the carried last touch is the latest one.
 */
export function carry(existing: Attribution | null, carried: Attribution): Attribution {
  if (!existing || existing.visitor === carried.visitor || carried.first.at <= existing.first.at) return carried;
  return { ...existing, last: hasSignal(carried.last) ? carried.last : existing.last, segment: carried.segment ?? existing.segment };
}

// Encoding ------------------------------------------------------------------------------------------------------------

type Packed = readonly [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, number];

const pack = (t: Touch): Packed => [t.source, t.medium, t.campaign, t.content, t.term, t.ref, t.click, t.clickId, t.referrer, t.at];

function unpack(value: unknown, now: number): Touch | null {
  if (!Array.isArray(value) || value.length !== 10) return null;
  const at = value[9];
  if (typeof at !== 'number' || !Number.isInteger(at) || at < EARLIEST || at > Math.floor(now / 1000) + 86_400) return null;
  const click = clickKind(value[6]);
  return {
    source: word(value[0]),
    medium: word(value[1]),
    campaign: word(value[2]),
    content: word(value[3]),
    term: word(value[4]),
    ref: refCode(value[5]),
    click,
    clickId: click ? clickId(value[7]) : null,
    referrer: host(value[8]),
    at,
  };
}

const toBase64Url = (s: string): string => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function fromBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,3000}$/.test(s)) return null;
  try {
    return atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return null;
  }
}

/** The attribution as a cookie value or a link's parameter: compact, URL-safe, ASCII only (every value already is). */
export function encodeAttribution(a: Attribution): string {
  return toBase64Url(JSON.stringify({ v: a.visitor, s: a.segment, f: pack(a.first), l: pack(a.last) }));
}

/** Whatever a cookie or a link says, read as an attribution — or nothing, if any part of it is not one. */
export function decodeAttribution(value: string | null | undefined, now: number = Date.now()): Attribution | null {
  if (!value) return null;
  const json = fromBase64Url(value);
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const visitor = typeof r.v === 'string' && UUID.test(r.v) ? r.v : null;
  const first = unpack(r.f, now);
  const last = unpack(r.l, now);
  if (!visitor || !first || !last) return null;
  return { visitor, first, last, segment: segmentOf(r.s) };
}

/** The cookie's attributes: first-party, never readable by script, sent on top-level navigations. */
export function touchCookieOptions(https: boolean) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: https, path: '/', maxAge: TOUCH_MAX_AGE_SECONDS };
}

/** The kind of device a user agent describes — the agent itself is never kept. */
export function deviceOf(userAgent: string | null | undefined): 'MOBILE' | 'TABLET' | 'DESKTOP' | null {
  if (!userAgent) return null;
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(userAgent)) return 'TABLET';
  if (/Mobi|iPhone|iPod|Android|Opera Mini|IEMobile|Windows Phone/i.test(userAgent)) return 'MOBILE';
  return 'DESKTOP';
}

/** The trader sign-in's address with the attribution and the chosen side in it, for the page's calls to action. */
export function traderEntryHref(appOrigin: string, entryPath: string, attribution: string | null, segment: Segment | null): string {
  const params = new URLSearchParams();
  if (attribution) params.set(TOUCH_PARAM, attribution);
  if (segment) params.set(SEGMENT_PARAM, segment);
  const query = params.toString();
  return `${appOrigin}${entryPath}${query ? `?${query}` : ''}`;
}
