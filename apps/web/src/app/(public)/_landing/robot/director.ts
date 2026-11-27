import type { Direction } from '@inrp2p/kernel';
import { marketEstimate } from '../estimate.ts';
import { marketNow, rateFor } from '../market.ts';
import { robotCues } from './cues.ts';
import { visorDisplay } from './display.ts';
import { robotPresence } from './presence.ts';
import { DURATION } from './states.ts';

/**
 * What the hero robot's visor says (display.ts), and when. It answers the visitor, briefly, then gives its eyes back:
 *
 * - arriving, it says hello;
 * - an amount being typed shows on its face as the visitor would say it ("100K"); once the amount settles, the face
 *   reacts to it (pleased, impressed, star-struck) and only then do the rupees it comes to at the market's rate run
 *   across ("₹10,082,000") — the converter's own estimate, never a price of ours;
 * - turning the deal round shows which way it now goes ("SELL", "BUY");
 * - asking for a price with no amount puts up a question mark;
 * - the call to action hovered or focused shows an arrow — until the visitor has stayed on it a while and the robot's
 *   eyes turn to hearts for it, and from the moment they press it, when the face celebrates;
 * - back at the top after reading on, an arrow to the converter: → beside the robot, ↓ under it on a phone;
 * - left alone a while, it runs the market's rate across its face, as the board under it does — but never once it is
 *   nodding off: its face is busy falling asleep.
 *
 * The words cover the eyes, so the two take turns (docs/ROBOT_BEHAVIOUR.md): words wait while an emotion is on the
 * face, and an emotion never plays under words. The still robot (a phone that keeps it, a GPU that cannot keep up)
 * has no moving face, so its visor carries the moments in words instead: hearts for the call to action, Z's while it
 * sleeps, HI! when the visitor comes back or wakes it.
 *
 * Browser only; started once by the robot's stage and stopped with it. Off under reduced motion: the robot is still.
 */

const HELLO_AT = 1500;
const IDLE_MS = 16000;
/** Where the page is watched (`presence.ts`), the visitor too must have been still this long: the rate is for a pause. */
const IDLE_VISITOR_S = 8;
/** How long the face's response to a settled amount holds it before the rupees run across (`states.ts` DURATION). */
const AMOUNT_FACE_MS = { pleased: 1000, wow: 1750, starstruck: 2200 } as const;
/** How long after a welcome back the visor points at the next step, and for how long. */
const POINT_AT_MS = 1000;
const POINT_FOR_MS = 1400;

/** An amount of USDT as a person says it: 25K, 2.5K, 1.25M. */
export function compactUsdt(amount: number): string {
  const trim = (v: number) => String(Math.round(v * 100) / 100);
  if (amount >= 1e6) return `${trim(amount / 1e6)}M`;
  if (amount >= 1e3) return `${trim(amount / 1e3)}K`;
  return trim(amount);
}

/** How long the face reacts to an amount once it settles, before the visor may speak over it. */
export function amountFaceMs(amount: number): number {
  if (amount >= DURATION.stellar) return AMOUNT_FACE_MS.starstruck;
  if (amount >= DURATION.impressive) return AMOUNT_FACE_MS.wow;
  return AMOUNT_FACE_MS.pleased;
}

let running = 0;
let liveFace = false;

/** Whether the live robot is drawing its own face: set by the stage as the live robot takes over, and as it hands back. */
export function setLiveFace(on: boolean): void {
  liveFace = on;
}

export function startVisorDirector(stage: () => HTMLElement | null = () => null): () => void {
  if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  running++;
  if (running > 1) return () => void running--;

  let amount: number | null = null;
  let quietSince = performance.now();
  let estimateTimer = 0;
  let ctaSince = Number.POSITIVE_INFINITY;
  let committedAt = Number.NEGATIVE_INFINITY;
  let asleep = false;
  const timers: number[] = [];
  const later = (ms: number, run: () => void) => timers.push(window.setTimeout(run, ms));
  const say = (text: string, opts: { ms?: number } = {}) => {
    quietSince = performance.now() + visorDisplay.say(text, opts);
  };

  const estimate = (direction: Direction, after: number) => {
    window.clearTimeout(estimateTimer);
    estimateTimer = window.setTimeout(() => {
      const rate = rateFor(marketNow(), direction);
      if (!rate || amount === null) return;
      const e = marketEstimate(String(amount), rate);
      if (e) say(`₹${e.rupees}`);
    }, after);
  };

  /** Where the converter is from the robot: beside it on a wide screen, under it on a phone. */
  const towardsConverter = (): string => {
    const panel = document.querySelector('[data-robot-target="panel"]')?.getBoundingClientRect();
    const robot = stage()?.getBoundingClientRect();
    if (!panel || !robot) return '→';
    return panel.left >= robot.left + robot.width * 0.6 ? '→' : '↓';
  };

  later(HELLO_AT, () => say('HI!', { ms: 1900 }));

  const unsubscribe = robotCues.subscribe((cue) => {
    if (cue.kind === 'value') {
      if (cue.amount === undefined) return;
      amount = cue.amount;
      const settle = (cue.settled ? DURATION.settledSettle : DURATION.typedSettle) * 1000;
      if (!liveFace) {
        // No face to react: the amount, then what it comes to.
        say(compactUsdt(cue.amount), { ms: 1300 });
        estimate(robotCues.direction(), 1150);
      } else {
        // Typing: the amount echoes until it settles, and gives the face back for its reaction. A preset was just
        // read off the button pressed, so the face answers at once. The rupees follow the reaction.
        if (!cue.settled) say(compactUsdt(cue.amount), { ms: settle + 120 });
        else visorDisplay.clear();
        estimate(robotCues.direction(), settle + amountFaceMs(cue.amount));
      }
    } else if (cue.kind === 'direction') {
      say(cue.direction === 'SELL_USDT' ? 'SELL' : 'BUY', { ms: 1100 });
      if (amount !== null) estimate(cue.direction, 1150);
    } else if (cue.kind === 'problem') {
      window.clearTimeout(estimateTimer);
      say('?', { ms: 1800 });
    } else if (cue.kind === 'commit') {
      // The face celebrates (hearts); nothing may cover it. The still robot says it instead.
      committedAt = performance.now();
      window.clearTimeout(estimateTimer);
      visorDisplay.hold(null);
      if (liveFace) visorDisplay.clear();
      else say('♥ ♥', { ms: 1800 });
    } else if (cue.kind === 'back') {
      if (!liveFace) say('HI!', { ms: cue.via === 'scroll' ? POINT_AT_MS - 100 : 1500 });
      if (cue.via === 'scroll') later(POINT_AT_MS, () => say(towardsConverter(), { ms: POINT_FOR_MS }));
    }
  });

  // What is held up while it holds (the arrow on the call to action, Z's on a sleeping still), and the rate when the
  // robot has been left alone: a light poll, a few times a second.
  const poll = window.setInterval(() => {
    const now = performance.now();
    const quiet = robotPresence.quiet(now);
    const focus = robotCues.focus();
    if (focus !== 'cta') ctaSince = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(ctaSince)) {
      // The visitor has just come onto the call to action: that is what the visor is for now, not what it was saying.
      ctaSince = now;
      if (now - committedAt >= DURATION.delight * 1000) visorDisplay.clear();
    }

    const sleeping = robotPresence.on() && quiet >= DURATION.asleep;
    if (asleep && quiet < DURATION.drowsy) {
      // Woken. The live robot's face says it (a start, then a greeting); the still one's visor says hello.
      asleep = false;
      if (!liveFace) say('HI!', { ms: 1500 });
    } else if (sleeping) asleep = true;

    const celebrating = now - committedAt < DURATION.delight * 1000;
    const fond = liveFace && now - ctaSince >= DURATION.smitten * 1000;
    const held = sleeping ? (liveFace ? null : 'Z Z') : focus === 'cta' && !celebrating && !fond ? '→' : null;
    visorDisplay.hold(held, now);

    // Left alone: the rate — in a pause of the visitor's, never while the pointer is away at the tabs (the face is
    // pleading), and not once the robot is getting drowsy, when its face has something to show.
    if (document.visibilityState !== 'visible' || visorDisplay.busy(now) || now - quietSince < IDLE_MS) return;
    if (robotPresence.on() && (quiet < IDLE_VISITOR_S || quiet >= DURATION.drowsy - 6 || robotPresence.leaving())) return;
    const market = marketNow();
    const rate = rateFor(market, robotCues.direction());
    if (!rate) return;
    quietSince = now + visorDisplay.say(`USDT ₹${Number(rate).toFixed(2)}`, {}, now);
  }, 250);

  return () => {
    running--;
    unsubscribe();
    window.clearInterval(poll);
    window.clearTimeout(estimateTimer);
    for (const t of timers) window.clearTimeout(t);
    visorDisplay.hold(null);
    visorDisplay.clear();
  };
}
