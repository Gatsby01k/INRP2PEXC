import { describe, expect, it } from 'vitest';
import { type LookAngles, type LookTarget, type Pose, type Presence, type RobotState, RobotBehaviour } from '../src/app/(public)/_landing/robot/behaviour.ts';
import type { RobotCue, RobotFocus } from '../src/app/(public)/_landing/robot/cues.ts';
import { amountFaceMs, compactUsdt } from '../src/app/(public)/_landing/robot/director.ts';
import { DURATION, STATES } from '../src/app/(public)/_landing/robot/states.ts';

/**
 * The home page's robot as a character (docs/ROBOT_BEHAVIOUR.md): what it does about the visitor on the page as a
 * whole, on top of what it does about the quote. Every moment has a trigger the visitor caused and an end; none of it
 * reaches a robot that holds a state of record (the workspace's moods), and none of it happens without a page that is
 * watched for it (`presence` absent).
 */

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ANGLES: Record<LookTarget, LookAngles> = {
  viewer: { yaw: 0, pitch: -0.05 },
  panel: { yaw: 0.45, pitch: -0.1 },
  amount: { yaw: 0.42, pitch: -0.02 },
  toggle: { yaw: 0.4, pitch: 0.06 },
  rate: { yaw: 0.46, pitch: -0.14 },
  cta: { yaw: 0.44, pitch: -0.3 },
  entry: { yaw: 0.5, pitch: 0.32 },
  pointer: { yaw: 0.05, pitch: 0.2 },
  title: { yaw: -0.5, pitch: 0.12 },
  reading: { yaw: 0.05, pitch: -0.32 },
  exit: { yaw: 0.1, pitch: 0.34 },
};

const FRAME = 1 / 60;
const AT_REST: Presence = { quiet: 0, scrolling: 0, below: false, over: 0, leaving: false };

interface Frame {
  readonly pose: Pose;
  readonly state: RobotState;
  readonly time: number;
}

/** A home-page robot: no mood, its presence given by `presence` (quiet counts up on its own unless reset). */
function home(options: { playful?: boolean } = {}) {
  const behaviour = new RobotBehaviour({ direction: 'SELL_USDT', random: seeded(11), playful: options.playful ?? false });
  let time = 0;
  let presence: Presence = AT_REST;
  let quietFrom = 0;
  const run = {
    behaviour,
    get time() {
      return time;
    },
    /** The visitor does something: quiet starts again. */
    active() {
      quietFrom = time;
    },
    set(next: Partial<Presence>) {
      presence = { ...presence, ...next };
    },
    cue(cue: RobotCue) {
      behaviour.cue(cue, time);
    },
    step(seconds: number, opts: { focus?: RobotFocus; withPresence?: boolean } = {}, each?: (f: Frame) => void): Frame {
      let frame: Frame | null = null;
      for (let i = 0; i < Math.round(seconds / FRAME); i++) {
        time += FRAME;
        const watched = opts.withPresence ?? true;
        const pose = behaviour.update({
          time,
          dt: FRAME,
          focus: opts.focus ?? 'none',
          angles: (t) => ANGLES[t],
          ...(watched ? { presence: { ...presence, quiet: time - quietFrom } } : {}),
        });
        frame = { pose, state: behaviour.current, time };
        each?.(frame);
      }
      if (!frame) throw new Error('step at least one frame');
      return frame;
    },
  };
  run.step(3);
  run.active();
  return run;
}

/** Rising edges of a series above `level`. */
const peaks = (xs: readonly number[], level: number) => xs.filter((x, i) => x > level && (xs[i - 1] ?? 0) <= level).length;

describe('the home page’s robot as a character', () => {
  it('is star-struck by a very large amount: star eyes, two hops, the antenna blazing — then back to rest', () => {
    const run = home();
    run.cue({ kind: 'value', settled: true, amount: 2_500_000 });
    const frames: Frame[] = [];
    run.step(2.4, {}, (f) => frames.push(f));
    expect(frames.some((f) => f.state === 'starstruck')).toBe(true);
    expect(Math.max(...frames.map((f) => f.pose.star))).toBeGreaterThan(0.9);
    expect(Math.max(...frames.map((f) => f.pose.beacon))).toBeGreaterThan(0.8);
    expect(peaks(frames.map((f) => f.pose.hop), 0.03), 'a bounce').toBe(2);
    expect(Math.max(...frames.map((f) => f.pose.beat)), 'the stars beat').toBeGreaterThan(0.5);
    const after = run.step(3);
    expect(after.state).toBe('idle');
    expect(after.pose.star).toBeLessThan(0.01);
  });

  it('keeps the wide eyes for a large amount that is not a whale', () => {
    const run = home();
    run.cue({ kind: 'value', settled: true, amount: 500_000 });
    const frames: Frame[] = [];
    run.step(1.2, {}, (f) => frames.push(f));
    expect(frames.some((f) => f.state === 'wow')).toBe(true);
    expect(Math.max(...frames.map((f) => f.pose.star))).toBe(0);
  });

  it('grows fond of a call to action the visitor stays on — hearts and a little hop — and lets go when they leave it', () => {
    const run = home();
    const early = run.step(1.2, { focus: 'cta' });
    expect(early.state).toBe('intent');
    expect(early.pose.heart).toBeLessThan(0.01);
    const frames: Frame[] = [];
    run.step(1.5, { focus: 'cta' }, (f) => frames.push(f));
    const fond = frames.at(-1)!;
    expect(fond.state).toBe('smitten');
    expect(fond.pose.heart).toBeGreaterThan(0.9);
    expect(fond.pose.blush).toBeGreaterThan(0.3);
    expect(fond.pose.gazeX, 'eyes still on the button').toBeGreaterThan(0.01);
    expect(Math.max(...frames.map((f) => f.pose.hop))).toBeGreaterThan(0.03);
    const off = run.step(2.5);
    expect(off.state).toBe('idle');
    expect(off.pose.heart).toBeLessThan(0.01);
  });

  it('celebrates the press of the call to action: hearts beating, both arms up and pumping, a bounce — once a press', () => {
    const run = home();
    run.cue({ kind: 'commit' });
    run.cue({ kind: 'commit' });
    const frames: Frame[] = [];
    run.step(2.8, {}, (f) => frames.push(f));
    expect(frames[10]!.state).toBe('delight');
    expect(Math.max(...frames.map((f) => f.pose.heart))).toBeGreaterThan(0.9);
    expect(Math.max(...frames.map((f) => f.pose.cheer))).toBeGreaterThan(0.95);
    expect(Math.max(...frames.map((f) => Math.abs(f.pose.cheerPump))), 'the arms pump').toBeGreaterThan(0.08);
    expect(peaks(frames.map((f) => f.pose.hop), 0.03), 'one bounce for the two presses').toBe(2);
    expect(frames.at(-1)!.pose.cheer).toBe(0);
    expect(run.step(2).state).toBe('idle');
  });

  it('watches the visitor scroll on: looks down after them, and once they are below it, at what they read', () => {
    const run = home();
    const before = run.step(0.5).pose;
    run.set({ scrolling: 1 });
    const watching = run.step(0.8);
    expect(watching.state).toBe('watching');
    expect(watching.pose.headPitch, 'down after them').toBeLessThan(before.headPitch - 0.1);
    expect(watching.pose.lidTilt, 'interested: the inner lids lifted').toBeLessThan(-0.15);
    run.set({ scrolling: 0, below: true });
    const reading = run.step(2);
    expect(reading.state).toBe('idle');
    expect(reading.pose.headPitch, 'still on what they read').toBeLessThan(before.headPitch - 0.1);
    run.set({ below: false });
    expect(run.step(2.5).pose.headPitch).toBeGreaterThan(before.headPitch - 0.02);
  });

  it('welcomes the visitor back to the top, then turns to the converter: the next step', () => {
    const run = home();
    run.cue({ kind: 'back', via: 'scroll' });
    const first = run.step(0.5);
    expect(first.state).toBe('welcome');
    expect(first.pose.smile).toBeGreaterThan(0.6);
    const next = run.step(1);
    expect(next.state).toBe('invite');
    expect(next.pose.gazeX, 'eyes on the amount').toBeGreaterThan(0.01);
    expect(next.pose.torsoPitch, 'leaning in').toBeGreaterThan(0.015);
    expect(run.step(3).state).toBe('idle');
  });

  it('refocuses on a tab the visitor comes back to — two quick blinks — and then smiles, without a wave', () => {
    const run = home();
    run.cue({ kind: 'back', via: 'tab' });
    const opens: number[] = [];
    const lifts: number[] = [];
    let smile = 0;
    run.step(2, {}, (f) => {
      opens.push(f.pose.eyeOpen);
      lifts.push(f.pose.waveLift);
      smile = Math.max(smile, f.pose.smile);
    });
    expect(peaks(opens.map((o) => 1 - o), 0.8), 'two blinks').toBe(2);
    expect(smile).toBeGreaterThan(0.9);
    expect(Math.max(...lifts)).toBe(0);
  });

  it('dozes off when left alone, catches itself once, falls asleep with Z’s rising — and wakes with a start', () => {
    const run = home();
    const drowsy: Frame[] = [];
    run.step(DURATION.drowsy + 0.2);
    run.step(5, {}, (f) => drowsy.push(f));
    expect(drowsy.every((f) => f.state === 'drowsy')).toBe(true);
    expect(drowsy.at(-1)!.pose.lid, 'heavy lids').toBeGreaterThan(0.35);
    expect(Math.max(...drowsy.map((f) => f.pose.wide)), 'the catch opens the eyes').toBeGreaterThan(0.3);
    const asleep = run.step(6);
    expect(asleep.state).toBe('asleep');
    expect(asleep.pose.sleep).toBeGreaterThan(0.9);
    expect(asleep.pose.eyeOpen).toBeLessThan(0.2);
    expect(asleep.pose.accentGlow).toBeLessThan(0.12);
    expect(asleep.pose.headPitch, 'head down').toBeLessThan(-0.08);
    const z = asleep.pose.zPhase;
    expect(run.step(1).pose.zPhase, 'the Z’s rise').toBeGreaterThan(z + 0.2);

    run.active();
    const woken: Frame[] = [];
    run.step(2.5, {}, (f) => woken.push(f));
    expect(woken[3]!.state).toBe('startled');
    expect(Math.max(...woken.slice(0, 20).map((f) => f.pose.wide))).toBeGreaterThan(0.9);
    expect(Math.max(...woken.map((f) => f.pose.hop))).toBeGreaterThan(0.03);
    expect(woken.some((f) => f.state === 'welcome'), 'then greets').toBe(true);
    expect(Math.max(...woken.map((f) => f.pose.smile)), 'with a smile').toBeGreaterThan(0.9);
    expect(Math.max(...woken.map((f) => f.pose.waveLift)), 'not a wave').toBe(0);
    expect(woken.at(-1)!.pose.sleep).toBeLessThan(0.01);
  });

  it('giggles when poked — happy arcs, a blush, a jiggle — and gives hearts for the third poke in a run', () => {
    const run = home();
    run.cue({ kind: 'poke' });
    const rolls: number[] = [];
    const giggle = run.step(0.5, {}, (f) => rolls.push(f.pose.headRoll));
    expect(giggle.state).toBe('giggle');
    expect(giggle.pose.smile).toBeGreaterThan(0.8);
    expect(giggle.pose.blush).toBeGreaterThan(0.6);
    let reversals = 0;
    for (let i = 2; i < rolls.length; i++) if (Math.sign(rolls[i]! - rolls[i - 1]!) !== Math.sign(rolls[i - 1]! - rolls[i - 2]!)) reversals += 1;
    expect(reversals, 'a jiggle').toBeGreaterThanOrEqual(4);
    run.cue({ kind: 'poke' });
    run.step(0.3);
    run.cue({ kind: 'poke' });
    const third = run.step(0.6);
    expect(third.state).toBe('delight');
    expect(third.pose.heart).toBeGreaterThan(0.8);
    expect(run.step(3).state).toBe('idle');
  });

  it('leans into a pat: the pointer resting on its head', () => {
    const run = home();
    run.set({ over: 0.4 });
    expect(run.step(0.3).state).toBe('idle');
    run.set({ over: 1.2 });
    const pat = run.step(1);
    expect(pat.state).toBe('content');
    expect(pat.pose.smile).toBeGreaterThan(0.8);
    expect(pat.pose.blush).toBeGreaterThan(0.4);
    run.set({ over: 0 });
    expect(run.step(1.5).state).toBe('idle');
  });

  it('makes puppy eyes when the pointer heads for the tabs, and is relieved when it comes back', () => {
    const run = home();
    run.set({ leaving: true });
    const pleading = run.step(1);
    expect(pleading.state).toBe('pleading');
    expect(pleading.pose.wide).toBeGreaterThan(0.4);
    expect(pleading.pose.lidTilt, 'inner lids raised').toBeLessThan(-0.4);
    expect(pleading.pose.headPitch + pleading.pose.gazeY, 'looking up after it').toBeGreaterThan(0.05);
    run.set({ leaving: false });
    const relief = run.step(0.5);
    expect(relief.state).toBe('pleased');
    expect(relief.pose.smile).toBeGreaterThan(0.3);
  });

  it('sways its antenna after a hop, within reach, and comes to rest', () => {
    const run = home();
    run.cue({ kind: 'direction', direction: 'BUY_USDT' });
    const sway: number[] = [];
    run.step(1, {}, (f) => sway.push(f.pose.antennaPitch));
    expect(Math.max(...sway.map(Math.abs))).toBeGreaterThan(0.02);
    expect(Math.max(...sway.map(Math.abs))).toBeLessThanOrEqual(0.3);
    const rest = run.step(2.5);
    expect(Math.abs(rest.pose.antennaPitch) + Math.abs(rest.pose.antennaRoll)).toBeLessThan(1e-3);
  });

  it('never acts on the page where it is not watched, nor over a state of record', () => {
    const unwatched = home();
    unwatched.set({ leaving: true, quiet: 100, over: 5, scrolling: 1 });
    unwatched.step(60, { withPresence: false }, (f) => expect(f.state).toBe('idle'));

    const workspace = home();
    workspace.cue({ kind: 'mood', mood: 'waiting' });
    workspace.cue({ kind: 'poke' });
    workspace.cue({ kind: 'back', via: 'scroll' });
    workspace.cue({ kind: 'commit' });
    workspace.set({ leaving: true, over: 5, scrolling: 1 });
    workspace.step(60, {}, (f) => expect(f.state).toBe('waiting'));

    const ready = home();
    ready.cue({ kind: 'mood', mood: 'ready' });
    ready.cue({ kind: 'poke' });
    ready.set({ leaving: true, over: 5 });
    ready.step(60, {}, (f) => expect(['ready', 'curious', 'pleased']).toContain(f.state));
  });

  it('ends every moment: after any of them, it is back at rest with its face and arms at rest', () => {
    const run = home();
    run.cue({ kind: 'value', settled: true, amount: 3_000_000 });
    run.step(0.5);
    run.cue({ kind: 'commit' });
    run.step(0.4);
    run.cue({ kind: 'poke' });
    run.step(0.3);
    run.cue({ kind: 'back', via: 'scroll' });
    run.step(0.3);
    run.set({ leaving: true });
    run.step(0.5);
    run.set({ leaving: false, scrolling: 1 });
    run.step(0.5);
    run.set({ scrolling: 0 });
    run.step(8);
    run.active();
    run.step(10, {}, (f) => {
      expect(f.state).toBe('idle');
      expect(f.pose.heart + f.pose.star + f.pose.blush + f.pose.sleep + f.pose.cheer + f.pose.hop + f.pose.beat).toBeLessThan(1e-3);
      expect(Math.abs(f.pose.antennaPitch) + Math.abs(f.pose.antennaRoll)).toBeLessThan(1e-3);
      expect(f.pose.accentGlow).toBeCloseTo(STATES.idle.accent, 3);
    });
  });
});

describe('the visor gives the face its turn', () => {
  it('waits for the face’s reaction to an amount before the rupees run across it — longer the bigger the reaction', () => {
    expect(amountFaceMs(25_000)).toBeLessThan(amountFaceMs(500_000));
    expect(amountFaceMs(500_000)).toBeLessThan(amountFaceMs(2_000_000));
    expect(amountFaceMs(2_000_000)).toBeGreaterThanOrEqual(DURATION.starstruck * 1000 - 200);
  });

  it('says an amount the way a person does', () => {
    expect(compactUsdt(2_500_000)).toBe('2.5M');
    expect(compactUsdt(25_000)).toBe('25K');
    expect(compactUsdt(950)).toBe('950');
  });
});
