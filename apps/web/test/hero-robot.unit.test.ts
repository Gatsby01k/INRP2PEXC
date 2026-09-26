import { describe, expect, it } from 'vitest';
import { type Mesh, type Object3D, Quaternion, Vector3 } from 'three';
import type { RobotFocus } from '../src/app/(public)/_landing/robot/cues.ts';
import { type LookAngles, type LookTarget, type Pose, REST_POSE, type RobotState, RobotBehaviour } from '../src/app/(public)/_landing/robot/behaviour.ts';
import { buildFigure } from '../src/app/(public)/_landing/robot/figure.ts';
import { STATES } from '../src/app/(public)/_landing/robot/states.ts';
import { blinkOpenness, envelope, follow, follower, loadCycle } from '../src/app/(public)/_landing/robot/motion.ts';
import { requestHref } from '../src/app/(public)/_landing/request.ts';

/**
 * The hero robot's behaviour, held to what it is for: a precise machine reporting on a quote, not a mascot.
 *
 * Each state is entered only by the event it describes and answered with the body it is specified to; the body
 * moves as one connected mechanism, link by link, and every link settles without swinging back. Rest is held
 * still, with corrections too small and too irregular to read as a cycle. Nothing loops. The frame loop is not
 * involved: the behaviour is a pure function of time and input, and the figure a pure function of a pose.
 */

/** A small seeded generator, so a run of the behaviour is the same run every time. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where things are, as seen from the robot's head: the module to its left (the visitor's right). */
const ANGLES: Record<LookTarget, LookAngles> = {
  viewer: { yaw: 0, pitch: -0.05 },
  panel: { yaw: 0.45, pitch: -0.1 },
  amount: { yaw: 0.42, pitch: -0.02 },
  toggle: { yaw: 0.4, pitch: 0.06 },
  rate: { yaw: 0.46, pitch: -0.14 },
  cta: { yaw: 0.44, pitch: -0.3 },
  entry: { yaw: 0.5, pitch: 0.32 },
};

const FRAME = 1 / 60;

interface Frame {
  readonly pose: Pose;
  readonly state: RobotState;
  readonly time: number;
}

interface Run {
  readonly behaviour: RobotBehaviour;
  time: number;
  step(seconds: number, options?: { focus?: RobotFocus; angles?: (t: LookTarget) => LookAngles | null }, each?: (frame: Frame) => void): Frame;
}

function start(options: { wakeAt?: number } = {}): Run {
  const behaviour = new RobotBehaviour({ direction: 'SELL_USDT', random: seeded(7), ...options });
  const run: Run = {
    behaviour,
    time: 0,
    step(seconds, opts = {}, each) {
      let frame: Frame = { pose: REST_POSE, state: behaviour.current, time: run.time };
      for (let i = 0; i < Math.round(seconds / FRAME); i++) {
        run.time += FRAME;
        const pose = behaviour.update({ time: run.time, dt: FRAME, focus: opts.focus ?? 'none', angles: opts.angles ?? ((t) => ANGLES[t]) });
        frame = { pose, state: behaviour.current, time: run.time };
        each?.(frame);
      }
      return frame;
    },
  };
  return run;
}

/** A run that has been left alone long enough to be fully at rest. */
function settled(): Run {
  const run = start();
  run.step(3);
  return run;
}

/** Types into the amount for `seconds`, a keystroke every fifth of a second, calling `each` on every frame. */
function typing(run: Run, seconds: number, each?: (frame: Frame) => void): Frame {
  let frame = run.step(0);
  for (let t = 0; t < seconds - 1e-9; t += 0.2) {
    run.behaviour.cue({ kind: 'value' }, run.time);
    frame = run.step(0.2, {}, each);
  }
  return frame;
}

const brightestArc = (pose: Pose) => Math.max(...pose.arcGlow);

/** True when the series never reverses by more than rounding: the value only ever moves one way. */
const oneWay = (series: readonly number[]) => {
  const rising = series[series.length - 1]! >= series[0]!;
  return series.every((v, i) => i === 0 || (rising ? v >= series[i - 1]! - 1e-9 : v <= series[i - 1]! + 1e-9));
};

describe('the motion curves', () => {
  it('arrive without overshooting, however far they had to go', () => {
    for (const distance of [0.01, 0.4, 3]) {
      const f = follower();
      let max = 0;
      for (let i = 0; i < 180; i++) max = Math.max(max, follow(f, distance, 0.3, FRAME));
      expect(max, `distance ${distance}`).toBeLessThanOrEqual(distance);
      expect(f.value).toBeCloseTo(distance, 3);
    }
  });

  it('pick up a target that moves mid-flight without a jolt', () => {
    const f = follower();
    let previous = 0;
    let largestStep = 0;
    for (let i = 0; i < 240; i++) {
      const value = follow(f, i < 30 ? 1 : -1, 0.3, FRAME);
      largestStep = Math.max(largestStep, Math.abs(value - previous));
      previous = value;
    }
    expect(largestStep).toBeLessThan(0.12);
    expect(f.value).toBeCloseTo(-1, 2);
  });

  it('shape a response that starts, holds and ends — and is nothing outside that', () => {
    expect(envelope(-0.1, 0.2, 0.1, 0.4)).toBe(0);
    expect(envelope(0.25, 0.2, 0.1, 0.4)).toBe(1);
    expect(envelope(0.7, 0.2, 0.1, 0.4)).toBe(0);
  });

  it('blink quickly and completely, and are open otherwise', () => {
    expect(blinkOpenness(-1)).toBe(1);
    expect(blinkOpenness(0.09)).toBeLessThan(0.1);
    expect(blinkOpenness(1)).toBe(1);
  });

  it('shape a load cycle that begins and ends at rest, rising quicker than it falls', () => {
    expect(loadCycle(0)).toBe(0);
    expect(loadCycle(1)).toBeCloseTo(0, 9);
    expect(loadCycle(0.4)).toBe(1);
    for (let p = 0; p <= 1; p += 0.01) {
      expect(loadCycle(p)).toBeGreaterThanOrEqual(0);
      expect(loadCycle(p)).toBeLessThanOrEqual(1);
    }
  });
});

describe('idle', () => {
  it('starts from exactly the pose the still image shows', () => {
    expect(REST_POSE.headYaw).toBe(0);
    expect(REST_POSE.chestYaw).toBe(0);
    expect(REST_POSE.eyeOpen).toBe(1);
    expect(REST_POSE.arcGlow).toEqual([0, 0, 0]);
    expect(REST_POSE.accentGlow).toBe(STATES.idle.accent);
  });

  it('comes online with one short sweep of the emblem, then goes quiet', () => {
    const run = start({ wakeAt: 0.5 });
    let brightest = 0;
    run.step(3, {}, ({ pose }) => {
      brightest = Math.max(brightest, brightestArc(pose));
    });
    expect(brightest).toBeGreaterThan(0.5);
    run.step(2, {}, ({ pose }) => expect(brightestArc(pose)).toBe(0));
  });

  it('holds on the visitor: no glances, no lights — only corrections too small to read as movement', () => {
    const run = settled();
    let blinks = 0;
    let shut = false;
    const chest = { min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
    run.step(90, {}, ({ pose, state }) => {
      expect(state).toBe('idle');
      expect(Math.abs(pose.headYaw)).toBeLessThan(0.01);
      expect(Math.abs(pose.gazeX)).toBeLessThan(0.002);
      expect(brightestArc(pose)).toBe(0);
      expect(pose.hubGlow).toBeLessThan(1e-3);
      expect(Math.abs(pose.torsoRoll)).toBeLessThanOrEqual(0.006);
      chest.min = Math.min(chest.min, pose.chestPitch);
      chest.max = Math.max(chest.max, pose.chestPitch);
      if (pose.eyeOpen < 0.2 && !shut) blinks += 1;
      shut = pose.eyeOpen < 0.2;
    });
    // The corrections: a few thousandths of a radian, all told.
    expect(chest.max - chest.min).toBeGreaterThan(0);
    expect(chest.max - chest.min).toBeLessThanOrEqual(0.0031);
    expect(blinks).toBeGreaterThanOrEqual(10);
    expect(blinks).toBeLessThanOrEqual(26);
  });

  it('never settles into a cycle an eye could learn', () => {
    const run = settled();
    // The load cycle: each one a different length and depth.
    const starts: number[] = [];
    const peaks: number[] = [];
    let previous = run.step(0).pose.load;
    let rising = true;
    run.step(120, {}, ({ pose, time }) => {
      if (rising && pose.load < previous) {
        peaks.push(previous);
        rising = false;
      } else if (!rising && pose.load > previous) {
        starts.push(time);
        rising = true;
      }
      previous = pose.load;
    });
    const lengths = starts.slice(1).map((t, i) => t - starts[i]!);
    expect(lengths.length).toBeGreaterThan(12);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(4.5);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(6.9);
    expect(Math.max(...lengths) - Math.min(...lengths), 'lengths vary').toBeGreaterThan(1);
    expect(Math.max(...peaks) - Math.min(...peaks), 'depths vary').toBeGreaterThan(0.1);

    // The posture corrections: at irregular intervals, never on a beat.
    const corrections: number[] = [];
    let last = run.step(0).pose.chestPitch;
    let moving = false;
    run.step(60, {}, ({ pose, time }) => {
      const now = Math.abs(pose.chestPitch - last) > 2e-6;
      if (now && !moving) corrections.push(time);
      moving = now;
      last = pose.chestPitch;
    });
    const gaps = corrections.slice(1).map((t, i) => t - corrections[i]!);
    expect(gaps.length).toBeGreaterThan(8);
    expect(Math.max(...gaps) - Math.min(...gaps), 'the gaps between corrections vary').toBeGreaterThan(1);
  });
});

describe('quote value changed', () => {
  it('watches the amount while it is typed, focusing once, briefly; then confirms and returns to rest', () => {
    const run = settled();
    let confirmedWhileTyping = false;
    let narrowest = 1;
    let last = 1;
    typing(run, 1.2, ({ pose, state }) => {
      expect(state).toBe('value');
      confirmedWhileTyping ||= brightestArc(pose) > 0.3;
      narrowest = Math.min(narrowest, pose.eyeOpen);
      last = pose.eyeOpen;
    });
    expect(confirmedWhileTyping, 'no confirmation mid-typing').toBe(false);
    expect(narrowest, 'a short focus').toBeLessThan(0.9);
    expect(last, 'then simply watching').toBeGreaterThan(0.92);
    expect(run.step(0.01).pose.headYaw, 'attention on the module').toBeGreaterThan(0.1);

    let confirmations = 0;
    let lit = false;
    run.step(3, {}, ({ pose }) => {
      const on = brightestArc(pose) > 0.3;
      if (on && !lit) confirmations += 1;
      lit = on;
    });
    expect(confirmations).toBe(1);
    const after = run.step(0.01);
    expect(after.state).toBe('idle');
    expect(Math.abs(after.pose.headYaw), 'back on the visitor').toBeLessThan(0.02);
  });

  it('confirms a value set in one step without waiting for more typing', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'value', settled: true }, run.time);
    let firstLight = Number.POSITIVE_INFINITY;
    const cueAt = run.time;
    run.step(1, {}, ({ pose, time }) => {
      if (brightestArc(pose) > 0.3) firstLight = Math.min(firstLight, time - cueAt);
    });
    expect(firstLight).toBeLessThan(0.45);
  });

  it('holds attention on the module a moment, then returns in one smooth movement', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'value', settled: true }, run.time);
    let away = 0;
    const yaws: number[] = [];
    run.step(5, {}, ({ pose }) => {
      if (pose.headYaw > 0.05) away += FRAME;
      yaws.push(pose.headYaw);
    });
    expect(away).toBeGreaterThan(0.8);
    expect(away).toBeLessThan(2.6);
    const peak = yaws.indexOf(Math.max(...yaws));
    expect(oneWay(yaws.slice(peak))).toBe(true);
  });
});

describe('direction changed', () => {
  const firstLit = (direction: 'BUY_USDT' | 'SELL_USDT') => {
    const run = settled();
    if (direction === 'SELL_USDT') {
      run.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, run.time);
      run.step(3);
    }
    run.behaviour.cue({ kind: 'direction', direction }, run.time);
    const peaks = [-1, -1, -1];
    run.step(1, {}, ({ pose, time }) => {
      pose.arcGlow.forEach((g, i) => {
        if (g > 0.5 && peaks[i] === -1) peaks[i] = time;
      });
    });
    return peaks.indexOf(Math.min(...peaks));
  };

  it('lights the emblem in the direction value flows: INR to USDT for a buy, back again for a sell', () => {
    // Arc slots: 0 is the mark's upper-right arc (USDT side), 2 its upper-left (INR side).
    expect(firstLit('BUY_USDT')).toBe(2);
    expect(firstLit('SELL_USDT')).toBe(0);
  });

  it('turns the torso a very little towards the side value moves to', () => {
    const buy = settled();
    buy.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, buy.time);
    const towards = buy.step(0.6).pose.torsoYaw;
    const sell = settled();
    sell.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, sell.time);
    sell.step(3);
    sell.behaviour.cue({ kind: 'direction', direction: 'SELL_USDT' }, sell.time);
    const back = sell.step(0.6).pose.torsoYaw;
    expect(towards).toBeGreaterThan(0.005);
    expect(back).toBeLessThan(-0.005);
    expect(Math.abs(towards)).toBeLessThan(0.025);
  });

  it('changes the optics state without a flourish: no widening, no snap', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, run.time);
    let widest = 0;
    let largestStep = 0;
    let last = run.step(0).pose.eyeOpen;
    run.step(1.5, {}, ({ pose }) => {
      // Blinks are their own thing; the state change is everything else.
      if (pose.eyeOpen > 0.5 && last > 0.5) {
        widest = Math.max(widest, pose.eyeOpen);
        largestStep = Math.max(largestStep, Math.abs(pose.eyeOpen - last));
      }
      last = pose.eyeOpen;
    });
    expect(widest).toBeLessThanOrEqual(1 + 1e-9);
    expect(largestStep, 'every change of aperture is gradual').toBeLessThan(0.01);
  });

  it('does not react to the direction it is already facing', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'direction', direction: 'SELL_USDT' }, run.time);
    run.step(1, {}, ({ pose, state }) => {
      expect(state).toBe('idle');
      expect(brightestArc(pose)).toBe(0);
    });
  });
});

describe('the body as one mechanism', () => {
  /** Seconds until each link has covered nine tenths of its share of a direction change. */
  const arrivals = () => {
    const run = settled();
    const cueAt = run.time;
    run.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, cueAt);
    const frames: Frame[] = [];
    run.step(1.4, {}, (f) => frames.push(f));
    const final = frames[frames.length - 1]!.pose;
    const at = (pick: (p: Pose) => number) => frames.find((f) => pick(f.pose) >= pick(final) * 0.9)!.time - cueAt;
    return { head: at((p) => p.headYaw), neck: at((p) => p.neckYaw), chest: at((p) => p.chestYaw), final };
  };

  it('moves link by link: the head first, then the neck, then the chest', () => {
    const { head, neck, chest } = arrivals();
    expect(neck).toBeGreaterThan(head);
    expect(chest).toBeGreaterThan(neck);
  });

  it('carries a fraction of the look down into the chest, and dips the shoulder on that side a hair', () => {
    const { final } = arrivals();
    expect(final.chestYaw / final.headYaw).toBeGreaterThan(0.07);
    expect(final.chestYaw / final.headYaw).toBeLessThan(0.14);
    expect(final.chestRoll).toBeLessThan(0);
    expect(Math.abs(final.chestRoll)).toBeLessThan(0.004);
  });

  it('never swings back: every link of a turn moves one way until it arrives', () => {
    for (const cue of [{ kind: 'direction', direction: 'BUY_USDT' } as const, { kind: 'value' } as const]) {
      const run = settled();
      run.behaviour.cue(cue, run.time);
      const series = { head: [] as number[], neck: [] as number[], chest: [] as number[] };
      run.step(0.7, {}, ({ pose }) => {
        series.head.push(pose.headYaw);
        series.neck.push(pose.neckYaw);
        series.chest.push(pose.chestYaw);
      });
      for (const [link, values] of Object.entries(series)) expect(oneWay(values), `${cue.kind} ${link}`).toBe(true);
    }
  });

  it('eases a deliberate look in softly and a decisive one crisply', () => {
    const profile = (cue: Parameters<RobotBehaviour['cue']>[0]) => {
      const run = settled();
      run.behaviour.cue(cue, run.time);
      const speeds: number[] = [];
      let last = run.step(0).pose.headYaw;
      run.step(1, {}, ({ pose }) => {
        speeds.push((pose.headYaw - last) / FRAME);
        last = pose.headYaw;
      });
      const peak = Math.max(...speeds);
      return { early: speeds[5]! / peak, peakAt: speeds.indexOf(peak) * FRAME };
    };
    const amount = profile({ kind: 'value' });
    const direction = profile({ kind: 'direction', direction: 'BUY_USDT' });
    expect(direction.early, 'a decisive look is already moving').toBeGreaterThan(amount.early);
    expect(direction.peakAt, 'and reaches full speed sooner').toBeLessThan(amount.peakAt);
    expect(amount.early, 'a deliberate one starts softly').toBeLessThan(0.3);
  });

  it('lets the neck lean into a turn only while it moves', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, run.time);
    let leaned = 0;
    run.step(0.4, {}, ({ pose }) => {
      leaned = Math.max(leaned, Math.abs(pose.neckRoll));
    });
    expect(leaned).toBeGreaterThan(0.002);
    expect(leaned).toBeLessThanOrEqual(0.012);
    expect(Math.abs(run.step(1).pose.neckRoll)).toBeLessThan(0.001);
  });

  it('lets the arms trail the chest when it turns — in opposition — and then settle', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, run.time);
    let largest = 0;
    run.step(0.6, {}, ({ pose }) => {
      largest = Math.max(largest, Math.abs(pose.armTwist));
    });
    // Well under a degree, and back down to the hundredths of a degree the arms trail the resting drift by once
    // the body is at rest again (after the hold and the return).
    expect(largest).toBeGreaterThan(1e-3);
    expect(largest).toBeLessThan(0.015);
    expect(Math.abs(run.step(6).pose.armTwist)).toBeLessThan(5e-4);
  });

  it('keeps the head within reach, and lets the eyes carry the rest of a look', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'value' }, run.time);
    const pose = run.step(0.4, { angles: (t) => (t === 'viewer' ? ANGLES.viewer : { yaw: 2, pitch: 1.2 }) }).pose;
    expect(Math.abs(pose.headYaw)).toBeLessThanOrEqual(0.3 + 1e-6);
    expect(pose.gazeX).toBeGreaterThan(0);
  });

  it('holds the head on its aim while the body turns beneath it', () => {
    const figure = buildFigure();
    let head: Object3D | undefined;
    figure.root.traverse((o) => {
      const material = (o as Mesh).material as { customProgramCacheKey?: () => string } | undefined;
      if (material?.customProgramCacheKey?.() === 'inrp2p-robot-head') head = o;
    });
    const facing = () => {
      figure.root.updateMatrixWorld(true);
      const forward = new Vector3(0, 0, 1).applyQuaternion(head!.getWorldQuaternion(new Quaternion()));
      return { yaw: Math.atan2(forward.x, forward.z), pitch: Math.asin(forward.y) };
    };
    const aimed = { ...REST_POSE, headYaw: 0.2, neckYaw: 0.07, headPitch: -0.05, neckPitch: -0.0175 };
    figure.apply(aimed);
    const still = facing();
    figure.apply({ ...aimed, torsoYaw: 0.02, torsoPitch: 0.01, chestYaw: 0.03, chestPitch: 0.008, chestRoll: -0.004 });
    const moved = facing();
    expect(still.yaw).toBeCloseTo(0.2, 2);
    expect(moved.yaw).toBeCloseTo(still.yaw, 3);
    expect(moved.pitch).toBeCloseTo(still.pitch, 3);
    figure.dispose();
  });
});

describe('rate updated (from UI that shows a firm rate)', () => {
  it('reads the new rate — attention, the optics noticing then focusing, a pulse at the hub — and returns', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'rate' }, run.time);
    let widest = 0;
    let narrowest = 1;
    let hub = 0;
    const during = run.step(0.6, {}, ({ pose }) => {
      widest = Math.max(widest, pose.eyeOpen);
      narrowest = Math.min(narrowest, pose.eyeOpen);
      hub = Math.max(hub, pose.hubGlow);
    });
    expect(during.state).toBe('rate');
    expect(during.pose.headYaw).toBeGreaterThan(0.1);
    expect(widest).toBeGreaterThan(1);
    expect(narrowest).toBeLessThan(0.87);
    expect(hub).toBeGreaterThan(0.9);
    expect(run.step(2.5).state).toBe('idle');
  });

  it('looks at the module when the page marks no rate', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'rate' }, run.time);
    const pose = run.step(0.6, { angles: (t) => (t === 'rate' ? null : ANGLES[t]) }).pose;
    expect(pose.headYaw).toBeGreaterThan(0.1);
  });
});

describe('rate locked (from UI that shows a firm rate)', () => {
  it('resolves the whole mark at once, holds the visitor level and steady, then lets go', () => {
    const run = settled();
    const resting = run.step(0.01).pose;
    run.behaviour.cue({ kind: 'lock' }, run.time);
    const cueAt = run.time;
    let together = true;
    let blinked = false;
    const watch = ({ pose, time }: Frame) => {
      const [a, b, c] = pose.arcGlow;
      if (Math.max(a, b, c) > 0.3) together &&= Math.max(a, b, c) - Math.min(a, b, c) < 1e-9;
      if (time - cueAt > 0.4) blinked ||= pose.eyeOpen < 0.5;
    };

    const holding = run.step(1.2, {}, watch);
    expect(holding.state).toBe('locked');
    expect(Math.abs(holding.pose.headYaw), 'facing the visitor').toBeLessThan(0.03);
    expect(Math.abs(holding.pose.headRoll), 'level').toBeLessThan(0.01);
    expect(holding.pose.headPitch, 'chin up a touch from rest').toBeGreaterThan(resting.headPitch + 0.01);
    expect(holding.pose.eyeGain).toBeGreaterThan(1.05);
    expect(holding.pose.arcGlow[0], 'the mark is lit through the hold').toBeGreaterThan(1);

    run.step(1.2, {}, watch);
    expect(together, 'the three arcs light as one').toBe(true);
    expect(blinked, 'no blink through the hold').toBe(false);

    const after = run.step(3);
    expect(after.state).toBe('idle');
    expect(brightestArc(after.pose)).toBe(0);
  });

  it('supersedes a value still settling', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'value' }, run.time);
    run.step(0.1);
    run.behaviour.cue({ kind: 'lock' }, run.time);
    expect(run.step(0.8).state).toBe('locked');
  });
});

describe('call to action', () => {
  it('moves the eyes and, a little, the head — and nothing else: no lean, no light, no change of the optics', () => {
    const run = settled();
    const before = run.step(0.5).pose;
    let brightest = 0;
    const on = run.step(1.5, { focus: 'cta' }, ({ pose }) => {
      brightest = Math.max(brightest, brightestArc(pose));
    });
    expect(on.state).toBe('intent');
    expect(on.pose.gazeX).toBeGreaterThan(0.03);
    expect(on.pose.headYaw).toBeGreaterThan(0.03);
    expect(on.pose.torsoPitch).toBeCloseTo(before.torsoPitch, 4);
    expect(on.pose.eyeGain).toBeCloseTo(1, 3);
    expect(brightest).toBe(0);
    const off = run.step(2.5);
    expect(off.state).toBe('idle');
    expect(Math.abs(off.pose.headYaw), 'straight back, without a detour').toBeLessThan(0.02);
  });

  it('turns the head less towards the button than towards the amount; the eyes carry the difference', () => {
    const toCta = settled().step(1.5, { focus: 'cta' }).pose;
    const toAmount = typing(settled(), 1.6).pose;
    expect(Math.abs(toCta.headYaw)).toBeLessThan(toAmount.headYaw * 0.7);
    expect(toCta.gazeX).toBeGreaterThan(toAmount.gazeX);
  });

  it('lets an event finish its response before attending to the button', () => {
    const run = settled();
    run.behaviour.cue({ kind: 'direction', direction: 'BUY_USDT' }, run.time);
    expect(run.step(0.3, { focus: 'cta' }).state).toBe('direction');
    expect(run.step(1, { focus: 'cta' }).state).toBe('intent');
  });
});

describe('the way into the workspace', () => {
  it('draws a glance up to the masthead, carried by the eyes — and nothing else moves', () => {
    const run = settled();
    const before = run.step(0.5).pose;
    let brightest = 0;
    const on = run.step(1.5, { focus: 'entry' }, ({ pose }) => {
      brightest = Math.max(brightest, brightestArc(pose));
    });
    expect(on.state).toBe('entry');
    expect(on.pose.gazeX).toBeGreaterThan(0.03);
    expect(on.pose.gazeY, 'up, towards the masthead').toBeGreaterThan(0.03);
    expect(on.pose.torsoPitch).toBeCloseTo(before.torsoPitch, 4);
    expect(on.pose.eyeGain).toBeCloseTo(1, 3);
    expect(brightest).toBe(0);
    const off = run.step(2.5);
    expect(off.state).toBe('idle');
    expect(Math.abs(off.pose.headYaw), 'straight back, without a detour').toBeLessThan(0.02);
  });

  it('turns the head less than it does for the call to action', () => {
    const toEntry = settled().step(1.5, { focus: 'entry' }).pose;
    const toCta = settled().step(1.5, { focus: 'cta' }).pose;
    expect(Math.abs(toEntry.headYaw)).toBeLessThan(Math.abs(toCta.headYaw));
  });

  it('stays with the visitor when the masthead is not on the page', () => {
    const run = settled();
    const frame = run.step(1.5, { focus: 'entry', angles: (t) => (t === 'entry' ? null : ANGLES[t]) });
    expect(frame.state).toBe('entry');
    expect(Math.abs(frame.pose.headYaw)).toBeLessThan(0.02);
  });
});

describe('every response', () => {
  it('ends: after any sequence of events, the robot is back at rest and its lights are out', () => {
    const run = settled();
    const b = run.behaviour;
    b.cue({ kind: 'value' }, run.time);
    run.step(0.2);
    b.cue({ kind: 'direction', direction: 'BUY_USDT' }, run.time);
    run.step(0.3, { focus: 'cta' });
    b.cue({ kind: 'rate' }, run.time);
    run.step(0.4);
    b.cue({ kind: 'lock' }, run.time);
    run.step(0.2);
    b.cue({ kind: 'value', settled: true }, run.time);
    run.step(8);
    run.step(30, {}, ({ pose, state }) => {
      expect(state).toBe('idle');
      expect(brightestArc(pose)).toBe(0);
      expect(pose.hubGlow).toBeLessThan(1e-3);
      expect(pose.accentGlow).toBeCloseTo(STATES.idle.accent, 3);
      expect(Math.abs(pose.chestYaw)).toBeLessThan(0.002);
    });
  });
});

describe('the request the module sends', () => {
  it('opens the client app with the chosen direction and amount', () => {
    expect(requestHref('https://app.example', 'SELL_USDT', '100000')).toBe('https://app.example/exchange?direction=sell&amount=100000');
    expect(requestHref('https://app.example', 'BUY_USDT', '2500.5')).toBe('https://app.example/exchange?direction=buy&amount=2500.5');
  });

  it('leaves out an amount that is empty or zero, so the app asks for one', () => {
    expect(requestHref('https://app.example', 'BUY_USDT', '')).toBe('https://app.example/exchange?direction=buy');
    expect(requestHref('https://app.example', 'BUY_USDT', '0.00')).toBe('https://app.example/exchange?direction=buy');
  });
});
