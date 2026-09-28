import type { RobotCue, RobotFocus, RobotMood, TradeStage } from '../src/app/(public)/_landing/robot/cues.ts';

/**
 * "Three Arcs": the flagship film's whole score, in seconds from its first frame.
 *
 * One trade, in the product's own interface, beside the robot that watches it. The robot's chest carries the brand's
 * three arcs, dark; each lights only when its stage of the trade is true — the quote accepted, the client's USDT final
 * on chain, the INR paid in full — and when the third lights the film cuts to the logo: the mark is what a settled
 * trade looks like. The last shot is the home page's first screen, where the viewer arrives.
 *
 * Everything here is data. The page (`Film.tsx`) draws the frame for a moment from it, the robot hears its cues from
 * it, and the soundtrack (`sound.ts`) is scored from it — so picture, body and sound cannot drift apart. The one rule
 * the film keeps, and `film.unit.test.ts` holds it to: the robot moves second. Every cue it hears answers something
 * the interface has just shown.
 */

/** The frame: the page is laid out at 1600 × 900 and rendered at 1.2 × for 1920 × 1080. */
export const FRAME = { width: 1600, height: 900, scale: 1.2 } as const;
export const DURATION = 30;
export const FPS = 30;

/** The beats. Every other time in the film is one of these, or measured from one. */
export const AT = {
  /** The desk's firm quote replaces the request. */
  quote: 3.0,
  /** The client's pointer comes in, reaches "Accept quote", and presses it. */
  cursorIn: 6.9,
  cursorOn: 7.75,
  press: 8.1,
  /** The acceptance returns: the trade is open at the quoted rate. */
  accepted: 8.9,
  /** The workspace moves to the trade. */
  trade: 10.9,
  /** The client's USDT is seen on chain, then final. */
  seen: 12.9,
  final: 14.3,
  /** The INR payout begins; each payment is confirmed with its bank reference; nothing remains. */
  payout: 15.8,
  legs: [16.3, 17.2, 18.1, 19.0, 19.95],
  complete: 20.35,
  /** The cut to the mark, then the home page. */
  logo: 25.0,
  hero: 26.0,
  /** The robot's only line, and its look to the call to action. */
  ready: 26.7,
  lookCta: 28.4,
} as const;

/** The trade, as the product would show it. The design brief's own specimen; the film labels it illustrative. */
export const TRADE = {
  requestRef: 'RQ-260916-0412',
  quoteRef: 'QT-260916-0006',
  tradeRef: 'IX-260916-1842',
  direction: 'SELL_USDT',
  usdt: '100000',
  inr: '10200000',
  rate: '102.00',
  destination: 'HDFC Bank •••• 8219',
  /** The request left at 16:09 IST; the quote is held three minutes from 16:11. */
  requestedAt: '2026-09-16T10:39:00Z',
  quotedAt: '2026-09-16T10:41:00Z',
  heldForMs: 180_000,
  acceptedAt: '2026-09-16T10:41:48Z',
  txHash: '7c1e5f0a9b3d2e4c6a8b0d1f3e5a7c9b2d4f6a8c0e1b3d5f7a9c1e3b5d7fa90b',
  finalAt: '2026-09-16T10:54:00Z',
  /** The payout, as the receipt specimen has it: five transfers over three hours, each with its reference. */
  legs: [
    { amount: '2000000', utr: 'HDFCR52026091617118', at: '2026-09-16T11:01:00Z' },
    { amount: '2500000', utr: 'ICICR52026091614412', at: '2026-09-16T11:06:00Z' },
    { amount: '2500000', utr: 'AXISR52026091609921', at: '2026-09-16T11:51:00Z' },
    { amount: '2000000', utr: 'HDFCR52026091618830', at: '2026-09-16T12:51:00Z' },
    { amount: '1200000', utr: 'ICICR52026091620417', at: '2026-09-16T13:53:00Z' },
  ],
} as const;

/**
 * What the interface shows at each moment, as the events the robot answers. `ui` is when the interface changes; the
 * robot's cue is at or after it — never before (`film.unit.test.ts`).
 */
export interface Beat {
  readonly ui: number;
  readonly at: number;
  readonly cue: RobotCue;
  /** What happened, for the test's failure messages and for anyone reading the score. */
  readonly what: string;
}

const mood = (m: RobotMood): RobotCue => ({ kind: 'mood', mood: m });
const stage = (s: TradeStage): RobotCue => ({ kind: 'stage', stage: s });

export const BEATS: readonly Beat[] = [
  // The request leaves first; the quote is on screen a moment after AT.quote, and the robot answers it there.
  { ui: AT.quote, at: AT.quote + 0.2, cue: mood('focused'), what: 'a firm quote is live' },
  { ui: AT.quote, at: AT.quote + 0.25, cue: { kind: 'rate' }, what: 'the rate arrives, and is read' },
  { ui: AT.press, at: AT.press, cue: { kind: 'wait', on: true }, what: 'accept pressed: the button waits' },
  { ui: AT.accepted, at: AT.accepted, cue: { kind: 'wait', on: false }, what: 'the acceptance returns' },
  { ui: AT.accepted, at: AT.accepted + 0.02, cue: stage(1), what: 'the quote is accepted: the first arc' },
  { ui: AT.trade, at: AT.trade + 0.3, cue: mood('waiting'), what: 'the trade waits for the client’s USDT' },
  { ui: AT.seen, at: AT.seen + 0.1, cue: mood('verifying'), what: 'the USDT is seen on chain' },
  { ui: AT.final, at: AT.final + 0.05, cue: stage(2), what: 'the USDT is final: the second arc' },
  ...AT.legs.map((t, i) => ({ ui: t, at: t + 0.06, cue: { kind: 'tally' } as const, what: `payment ${i + 1} confirmed` })),
  { ui: AT.complete, at: AT.complete + 0.05, cue: stage(3), what: 'nothing remains: the third arc, the mark whole' },
  { ui: AT.complete, at: AT.complete + 0.06, cue: mood('success'), what: 'the trade is completed' },
  { ui: AT.logo, at: AT.logo, cue: stage(0), what: 'the page no longer shows a trade' },
  { ui: AT.logo, at: AT.logo + 0.01, cue: mood('none'), what: 'the home page, which has no state of record' },
  { ui: AT.ready, at: AT.ready, cue: { kind: 'speak', line: 'ready', lead: 0 }, what: '“Ready when you are.”' },
];

/** The robot's cues in the order it hears them. */
export const CUES = [...BEATS].sort((a, b) => a.at - b.at);

/** The mood the robot is in on the film's first frame: the desk is pricing the request. */
export const OPENING_MOOD: RobotMood = 'waiting';

/** What the visitor is on — only at the very end, when the robot hands them to the call to action. */
export const focusAt = (t: number): RobotFocus => (t >= AT.lookCta ? 'cta' : 'none');

/**
 * The robot starts this long before the first frame, so the first frame finds it already waiting — the dots formed,
 * the body settled — rather than arriving.
 */
export const PREROLL = 3;

/** Words over the picture: the site's own, from `content/site.ts`, in the hero's headline slot. */
export interface Super {
  readonly from: number;
  readonly to: number;
  readonly eyebrow: string;
  readonly text: string;
}

/** Shots, as named framings of the page (`camera.ts`). A move eases from one framing to the next. */
export type Framing = 'eyes' | 'face' | 'bust' | 'chest' | 'chestMacro' | 'rate' | 'two' | 'wide' | 'hero';

export interface Shot {
  readonly from: number;
  readonly to: number;
  readonly framing: Framing;
  /** A move to another framing across the shot (`ease` in-out), or a slow push by this factor. */
  readonly moveTo?: Framing;
  readonly moveFrom?: number;
  readonly push?: number;
}

export const SHOTS: readonly Shot[] = [
  // The dots, close; then one continuous pull back to the robot beside the request.
  { from: 0, to: 2.9, framing: 'eyes', moveTo: 'two', moveFrom: 0.8 },
  { from: 2.9, to: 5.0, framing: 'two' },
  { from: 5.0, to: 6.2, framing: 'rate', push: 1.05 },
  { from: 6.2, to: 7.1, framing: 'face', push: 1.04 },
  { from: 7.1, to: 9.3, framing: 'two' },
  { from: 9.3, to: 10.3, framing: 'bust', push: 1.03 },
  { from: 10.3, to: 12.8, framing: 'wide' },
  { from: 12.8, to: 14.9, framing: 'two' },
  { from: 14.9, to: 15.7, framing: 'chest', push: 1.05 },
  { from: 15.7, to: 18.0, framing: 'two' },
  { from: 18.0, to: 19.8, framing: 'wide' },
  { from: 19.8, to: 21.3, framing: 'two' },
  { from: 21.3, to: 23.0, framing: 'bust', push: 1.02 },
  { from: 23.0, to: AT.logo, framing: 'bust', moveTo: 'chestMacro', moveFrom: 23.0 },
  { from: AT.hero, to: DURATION, framing: 'hero', push: 1.02 },
];

export const SUPERS: readonly Super[] = [
  { from: 10.45, to: 12.7, eyebrow: 'Execution flow', text: 'The price is fixed before any money moves.' },
  { from: 18.1, to: 19.72, eyebrow: 'Operational controls', text: 'Built to be checked, not taken on trust.' },
];

/** The shot on screen at `t`, or null for the logo card. */
export function shotAt(t: number): Shot | null {
  return SHOTS.find((s) => t >= s.from && t < s.to) ?? (t >= DURATION ? SHOTS.at(-1)! : null);
}

/** How far a stretch of time has got: 0 before `from`, 1 after `to`, eased in between. */
export function progress(t: number, from: number, to: number, ease: (x: number) => number = inOut): number {
  if (t <= from) return 0;
  if (t >= to) return 1;
  return ease((t - from) / (to - from));
}

/** The product's own curve (`--ease`, cubic-bezier(0.2, 0, 0, 1)), for anything the interface itself moves. */
export function productEase(x: number): number {
  // Control points (0.2, 0) and (0, 1): x(s) = 0.6(1−s)²s + s³ and y(s) = 3(1−s)s² + s³. Solve x(s) = x by Newton.
  let s = x;
  for (let i = 0; i < 8; i++) {
    const bx = 0.6 * (1 - s) ** 2 * s + s ** 3;
    const dx = 0.6 * (1 - s) ** 2 - 1.2 * (1 - s) * s + 3 * s * s;
    if (Math.abs(dx) < 1e-6) break;
    s = Math.min(1, Math.max(0, s - (bx - x) / dx));
  }
  return 3 * (1 - s) * s * s + s ** 3;
}

/** A camera's in-out: slow to leave, slow to arrive. */
export function inOut(x: number): number {
  return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2;
}

/** The light of the day on the set: the key lowers and warms across the payout, which takes the afternoon. */
export function eveningAt(t: number): number {
  if (t >= AT.logo) return 0;
  return progress(t, AT.payout + 0.4, AT.complete + 0.4, (x) => x * x * (3 - 2 * x));
}

/** The product's orange falling on the robot: the live quote's rate and its button, and the home page's call to action. */
export function spillAt(t: number): number {
  if (t >= AT.hero) return 0.3;
  if (t >= AT.logo) return 0;
  const live = progress(t, AT.quote, AT.quote + 0.4) * (1 - progress(t, AT.trade, AT.trade + 0.4));
  const pressed = progress(t, AT.cursorOn, AT.press) * (1 - progress(t, AT.accepted, AT.accepted + 0.3));
  return 0.35 * live + 0.25 * pressed;
}

/** The illustrative tag shows for as long as the trade's figures are on screen, and never on the home page. */
export const ILLUSTRATIVE = { from: 0.9, to: AT.logo } as const;
