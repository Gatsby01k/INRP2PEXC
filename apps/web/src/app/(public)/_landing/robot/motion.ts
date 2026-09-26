/**
 * The robot's motion vocabulary, as plain functions of time.
 *
 * Nothing here knows about three.js or React, so every curve can be tested for the one property that matters:
 * it settles. A robot that overshoots, oscillates or drifts reads as a toy; one that arrives exactly where it was
 * going, at a speed that depends on how far it had to go, reads as a machine that knows what it is doing.
 */

/** A value that follows a target with a critically damped response: no overshoot, velocity carried through. */
export interface Follower {
  value: number;
  velocity: number;
}

export const follower = (value = 0): Follower => ({ value, velocity: 0 });

/**
 * Critically damped approach towards `target` (the closed form popularised as SmoothDamp). `smoothTime` is
 * roughly the time to cover most of the distance; the response never overshoots, and a target that moves while
 * the value is travelling is picked up without a jolt, because velocity is carried rather than reset.
 */
export function follow(f: Follower, target: number, smoothTime: number, dt: number): number {
  if (dt <= 0) return f.value;
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = f.value - target;
  const temp = (f.velocity + omega * change) * dt;
  let next = target + (change + temp) * decay;
  let velocity = (f.velocity - omega * temp) * decay;
  // Never step past the target: arriving is the whole point.
  if (target - f.value > 0 === next > target) {
    next = target;
    velocity = 0;
  }
  f.value = next;
  f.velocity = velocity;
  return next;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const easeInQuad = (t: number): number => t * t;
const easeInOutSine = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * t);

/**
 * A single response: rises over `attack` seconds, holds for `hold`, then fades over `release`. Returns 0 before
 * it starts and after it ends, so a finished response costs nothing and can never loop.
 */
export function envelope(elapsed: number, attack: number, hold: number, release: number): number {
  if (elapsed < 0) return 0;
  if (elapsed < attack) return easeOutCubic(elapsed / attack);
  if (elapsed < attack + hold) return 1;
  const r = (elapsed - attack - hold) / release;
  return r >= 1 ? 0 : 1 - easeInOutSine(r);
}

/** Eyelid openness during a blink that started `elapsed` seconds ago: quick close, brief hold, slower open. */
export function blinkOpenness(elapsed: number): number {
  const close = 0.075;
  const shut = 0.035;
  const open = 0.13;
  if (elapsed < 0 || elapsed >= close + shut + open) return 1;
  if (elapsed < close) return 1 - 0.94 * easeInQuad(elapsed / close);
  if (elapsed < close + shut) return 0.06;
  return 0.06 + 0.94 * easeOutCubic((elapsed - close - shut) / open);
}

/**
 * The shape of one idle load cycle, 0 → 1 → 0 over a phase of 0 → 1: the rise takes forty per cent of the cycle
 * and the fall the rest. The behaviour varies each cycle's length and depth, so no two are alike and nothing reads
 * as a loop; the shape is what keeps it from reading as a sine wave bobbing an object up and down.
 */
export function loadCycle(phase: number): number {
  const p = clamp(phase, 0, 1);
  return p < 0.4 ? easeInOutSine(p / 0.4) : 1 - easeInOutSine((p - 0.4) / 0.6);
}

/** Uniform random value in [min, max). Isolated so tests can reason about the ranges rather than the dice. */
export const between = (min: number, max: number, random: () => number = Math.random): number => min + (max - min) * random();
