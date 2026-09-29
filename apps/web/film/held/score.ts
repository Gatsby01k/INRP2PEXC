import { Vector3 } from 'three';
import { seeded } from '../../src/app/(public)/_landing/robot/motion.ts';

/**
 * HELD — the film's score: every beat, shot, and state, in seconds from the first frame.
 *
 * The market is a storm of the chat and prices traders live in. The INRP2P robot is the one thing in it that does
 * not move. It lifts the three arcs off its chest, closes them round the price, and the storm stops dead: held.
 * Then the market moves again — and the price inside the ring does not. The film ends in silence on its line.
 *
 * Everything the page draws, the robot hears and the soundtrack plays is read from here, so picture, body and
 * sound cannot drift apart.
 */

export const DURATION = 30;
export const FPS = 24;
export const FRAME = { width: 1920, height: 1080 } as const;

export const AT = {
  /** The hook: the chat, piling up on black, until the cut to silence. */
  hookEnd: 4.8,
  /** Black glass; the robot's eyes open. */
  eyesOpen: 5.25,
  /** One pull back, through the storm, to the robot in the eye of it. */
  reveal: 5.9,
  /** The storm condenses into a price; the robot looks up at it and reads it. */
  price: 9.0,
  lookUp: 9.35,
  /** The chest's arcs light, one by one; the robot is ready. */
  charge: [10.2, 10.45, 10.7] as const,
  /** The arcs leave the chest, rise and grow — and snap shut round the price. The peak. */
  launch: 10.95,
  snap: 11.85,
  /** The world stopped: the camera moves through it. */
  frozen: 12.35,
  calm: 13.1,
  /** HELD. */
  held: 14.1,
  ringClose: 15.2,
  /** The promise, in the product: the quote, locked; accepted. */
  phone: 15.7,
  tap: 17.0,
  accepted: 17.2,
  /** The market moves again. The price in the ring does not. */
  resume: 18.2,
  restart: 18.4,
  /** The money arrives: one clean ping. */
  sms: 21.2,
  ping: 21.75,
  /** The robot, pleased; the evening; the mark made whole; the logo. */
  pleased: 23.5,
  ending: 24.4,
  mark: [24.95, 25.2, 25.45] as const,
  hub: 25.7,
  toChest: 25.55,
  logo: 26.8,
  lockup: 27.05,
  card: 27.55,
} as const;

/** Where the price hangs, and the ring round it: above the robot and in front of it, facing us. */
export const RING = { centre: new Vector3(0, 4.3, 4.0), radius: 1.9 } as const;

/** The freezing wave's speed, in units a second: the storm stops outward from the ring in under a second. */
export const WAVE_SPEED = 52;

/** The rate the ring holds, and the trade the film shows (labelled illustrative wherever a figure is on screen). */
export const HELD_RATE = '102.00';
export const TRADE = { usdt: '100000', inr: '10200000', credited: '1,02,00,000.00', account: 'XX8219', utr: '7118' } as const;

/** When the 3D world is on screen (everything else is drawn by the page over it). */
export function worldShown(t: number): boolean {
  return (t >= AT.hookEnd && t < AT.held) || (t >= AT.ringClose && t < AT.phone) || (t >= AT.resume && t < AT.sms) || (t >= AT.pleased && t < AT.logo);
}

/** Figures on screen are illustrative: from the price in the sky to the bank's message. */
export function illustrative(t: number): boolean {
  return t >= AT.price && t < AT.pleased && !(t >= AT.held && t < AT.ringClose);
}

// ——— the hook ——————————————————————————————————————————————————————————————————————————————————————————

export interface HookMessage {
  readonly at: number;
  readonly text: string;
  readonly mine: boolean;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly tilt: number;
  readonly time: string;
  /** A price that will not sit still. */
  readonly price: boolean;
}

const HOOK_CHAT = [
  'rate changed',
  'bhai 5 min',
  'send first',
  'new rate?',
  'payment pending',
  'screenshot bhejo',
  'rate update ho gaya',
  'wait',
  'price moved',
  'final rate?',
  'UTR?',
  'call me',
  'rate valid?',
  'still pending',
  'check again',
  'kitna?',
  'recheck',
  'rate gone',
  'market down',
  'refresh',
  'ok wait',
  'sent?',
  'confirm?',
  '???',
] as const;

/** Every message of the opening chat, in the order they land: slow, then faster, then all at once. */
export const HOOK_MESSAGES: readonly HookMessage[] = (() => {
  const random = seeded(2026);
  const n = 44;
  const list: HookMessage[] = [];
  for (let i = 0; i < n; i++) {
    const at = 0.12 + 3.45 * Math.sqrt(i / n);
    const early = i < 5;
    const price = !early && random() < 0.22;
    const text = price ? '' : HOOK_CHAT[i % HOOK_CHAT.length]!;
    // The first few read as one conversation, down the middle; after that they land anywhere, bigger, askew.
    const x = early ? (i % 2 === 0 ? 0.33 : 0.52) : 0.04 + random() * 0.72;
    const y = early ? 0.26 + i * 0.1 : 0.04 + random() * 0.84;
    const size = early ? 30 : 28 + (i / n) * 46 + random() * 14;
    list.push({ at, text, mine: i % 2 === 1, x, y, size, tilt: early ? 0 : (random() - 0.5) * 9, time: `16:0${Math.min(9, Math.floor(i / 5))}`, price });
  }
  return list;
})();

/** Near the end of the hook the words stop being messages and become the noise itself. */
export const HOOK_SHOUTS = [
  { at: 2.85, text: 'RATE CHANGED', y: 0.3 },
  { at: 3.35, text: 'SEND FIRST', y: 0.62 },
  { at: 3.8, text: 'WAIT', y: 0.45 },
] as const;

// ——— easing ——————————————————————————————————————————————————————————————————————————————————————

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const span = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
export const inOut = (x: number): number => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
export const out = (x: number): number => 1 - (1 - x) ** 3;
export const outExpo = (x: number): number => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));
export const smooth = (x: number): number => x * x * (3 - 2 * x);

/** The product's own curve, cubic-bezier(0.2, 0, 0, 1). */
export function productEase(x: number): number {
  let s = x;
  for (let i = 0; i < 8; i++) {
    const bx = 0.6 * (1 - s) ** 2 * s + s ** 3;
    const dx = 0.6 * (1 - s) ** 2 - 1.2 * (1 - s) * s + 3 * s * s;
    if (Math.abs(dx) < 1e-6) break;
    s = Math.min(1, Math.max(0, s - (bx - x) / dx));
  }
  return 3 * (1 - s) * s * s + s ** 3;
}

// ——— shots —————————————————————————————————————————————————————————————————————————————————————

export interface Lens {
  readonly pos: Vector3;
  readonly at: Vector3;
  readonly fov: number;
}

/** What the shots can be framed on: the chest mark, as the robot stands. */
export interface Anchors {
  readonly mark: Vector3;
}

export interface Shot {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  /** The camera at a moment of the shot, `p` running 0 → 1 across it. */
  readonly lens: (p: number, t: number, a: Anchors) => Lens;
  /** Sub-frames averaged per frame: more where things move fast. */
  readonly samples: number;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const lerpV = (a: Vector3, b: Vector3, k: number) => a.clone().lerp(b, k);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** A move from one lens to another, eased. */
const move = (a: Lens, b: Lens, ease: (x: number) => number = inOut) => (p: number): Lens => {
  const k = ease(p);
  return { pos: lerpV(a.pos, b.pos, k), at: lerpV(a.at, b.at, k), fov: lerp(a.fov, b.fov, k) };
};

const EYES: Lens = { pos: v(0, 0.01, 2.35), at: v(0, -0.03, 0), fov: 20 };
const EYES_CLOSE: Lens = { pos: v(0, 0.01, 2.15), at: v(0, -0.03, 0), fov: 20 };

export const SHOTS: readonly Shot[] = [
  {
    // Black glass, close: the eyes open.
    name: 'eyes',
    from: AT.hookEnd,
    to: AT.reveal,
    lens: move(EYES, EYES_CLOSE, (x) => x),
    samples: 3,
  },
  {
    // One pull back, fast off the mark and settling: through the storm, to the robot in the eye of it.
    name: 'reveal',
    from: AT.reveal,
    to: AT.price,
    lens: move(EYES_CLOSE, { pos: v(7.5, 4.6, 26), at: v(0, 0.2, 0), fov: 36 }, (x) => 1 - (1 - x) ** 4),
    samples: 9,
  },
  {
    // Low, to the side: the robot looks up at the price the storm has made.
    name: 'look',
    from: AT.price,
    to: AT.charge[0] - 0.1,
    lens: move({ pos: v(5.5, -2.4, 11), at: v(0, 2.1, 2.0), fov: 42 }, { pos: v(5.0, -2.3, 10.2), at: v(0, 2.2, 2.1), fov: 42 }, (x) => x),
    samples: 5,
  },
  {
    // The chest: the arcs light, one, two, three.
    name: 'charge',
    from: AT.charge[0] - 0.1,
    to: AT.launch,
    lens: (p, _t, a) => move({ pos: a.mark.clone().add(v(0.35, 0.55, 3.4)), at: a.mark.clone().add(v(0, 0.35, 0)), fov: 28 }, { pos: a.mark.clone().add(v(0.3, 0.45, 2.9)), at: a.mark.clone().add(v(0, 0.3, 0)), fov: 28 }, (x) => x)(p),
    samples: 4,
  },
  {
    // The peak: from low in front, the robot small beneath the sky; the arcs rise and close round the price.
    name: 'lock',
    from: AT.launch,
    to: AT.frozen,
    lens: move({ pos: v(1.2, -2.75, 16.5), at: v(0, 1.35, 2.0), fov: 44 }, { pos: v(1.0, -2.6, 14.6), at: v(0, 1.6, 2.1), fov: 44 }, out),
    samples: 9,
  },
  {
    // The world stopped: the camera travels through it, round the robot, the ring above.
    name: 'frozen',
    from: AT.frozen,
    to: AT.held,
    lens: (p) => {
      const k = inOut(p);
      const angle = lerp(-0.62, 0.42, k);
      const r = lerp(13.5, 12, k);
      return { pos: v(Math.sin(angle) * r, lerp(-1.9, -0.4, k), Math.cos(angle) * r + 1.6), at: v(0, lerp(2.1, 2.3, k), 1.8), fov: 48 };
    },
    samples: 6,
  },
  {
    // Back to the ring, square on: the frame the product's own ring takes over from.
    name: 'ring',
    from: AT.ringClose,
    to: AT.phone,
    lens: move({ pos: RING.centre.clone().add(v(0, -0.15, 7.6)), at: RING.centre.clone(), fov: 34 }, { pos: RING.centre.clone().add(v(0, -0.1, 7.0)), at: RING.centre.clone(), fov: 34 }, (x) => x),
    samples: 3,
  },
  {
    // The market moves again; the camera rises and closes on the one thing that does not.
    name: 'resume',
    from: AT.resume,
    to: AT.sms,
    lens: move({ pos: v(3.2, 7.2, 27), at: v(0, 2.1, 2.2), fov: 36 }, { pos: v(1.4, 5.6, 17.5), at: v(0, 2.9, 2.8), fov: 36 }, inOut),
    samples: 8,
  },
  {
    // Evening. The robot, close: pleased.
    name: 'pleased',
    from: AT.pleased,
    to: AT.ending,
    lens: move({ pos: v(0.45, 0.12, 3.35), at: v(0, -0.05, 0), fov: 26 }, { pos: v(0.4, 0.1, 3.1), at: v(0, -0.05, 0), fov: 26 }, (x) => x),
    samples: 3,
  },
  {
    // The storm lies on the plain. The robot turns to us; the camera closes on its chest as the mark is made whole.
    name: 'ending',
    from: AT.ending,
    to: AT.logo,
    lens: (p, t, a) => {
      const wide: Lens = { pos: v(5.2, 0.4, 13.5), at: v(0, -0.9, 0), fov: 32 };
      const mid: Lens = { pos: v(2.6, -0.3, 8.6), at: v(0, -0.9, 0.2), fov: 30 };
      const chest: Lens = { pos: a.mark.clone().add(v(0.02, 0.05, 1.3)), at: a.mark.clone(), fov: 24 };
      const k = span(t, AT.ending, AT.toChest);
      if (t < AT.toChest) return move(wide, mid, (x) => x)(k);
      return move(mid, chest, inOut)(span(t, AT.toChest, AT.logo));
    },
    samples: 4,
  },
];

export function shotAt(t: number): Shot | null {
  return SHOTS.find((s) => t >= s.from && t < s.to) ?? null;
}

/** The robot's direction: its mood and cues, in order. */
export const ROBOT_CUES = [
  { at: AT.lookUp, cue: { kind: 'mood', mood: 'focused' } },
  { at: AT.lookUp + 0.05, cue: { kind: 'rate' } },
  { at: AT.calm, cue: { kind: 'mood', mood: 'none' } },
  { at: AT.pleased + 0.15, cue: { kind: 'mood', mood: 'success' } },
] as const;

/** The wind the robot stands in, 0 to 1: the storm raging, stopped, raging again. */
export function wind(t: number): number {
  if (t < AT.reveal) return 0;
  if (t < AT.snap) return smooth(span(t, AT.reveal, AT.reveal + 0.8));
  if (t < AT.restart) return 0;
  if (t < AT.sms) return smooth(span(t, AT.restart, AT.restart + 0.6));
  return 0;
}
