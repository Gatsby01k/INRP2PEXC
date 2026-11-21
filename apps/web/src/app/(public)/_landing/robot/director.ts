import type { Direction } from '@inrp2p/kernel';
import { marketEstimate } from '../estimate.ts';
import { marketNow, rateFor } from '../market.ts';
import { robotCues } from './cues.ts';
import { visorDisplay } from './display.ts';

/**
 * What the hero robot's visor says (display.ts), and when. It answers the visitor, briefly, then gives its eyes back:
 *
 * - arriving, it says hello;
 * - an amount typed or picked shows on its face as the visitor would say it ("100K"), and once they stop, the rupees it
 *   comes to at the market's rate run across ("₹10,082,000") — the converter's own estimate, never a price of ours;
 * - turning the deal round shows which way it now goes ("SELL", "BUY");
 * - asking for a price with no amount puts up a question mark;
 * - the call to action hovered or focused shows an arrow for as long as it is;
 * - left alone a while, it runs the market's rate across its face, as the board under it does.
 *
 * Browser only; started once by the robot's stage and stopped with it. Off under reduced motion: the robot is still.
 */

const HELLO_AT = 1500;
const IDLE_MS = 16000;

/** An amount of USDT as a person says it: 25K, 2.5K, 1.25M. */
export function compactUsdt(amount: number): string {
  const trim = (v: number) => String(Math.round(v * 100) / 100);
  if (amount >= 1e6) return `${trim(amount / 1e6)}M`;
  if (amount >= 1e3) return `${trim(amount / 1e3)}K`;
  return trim(amount);
}

let running = 0;

export function startVisorDirector(): () => void {
  if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  running++;
  if (running > 1) return () => void running--;

  let amount: number | null = null;
  let quietSince = performance.now();
  let estimateTimer = 0;
  const timers: number[] = [];

  const estimate = (direction: Direction) => {
    window.clearTimeout(estimateTimer);
    estimateTimer = window.setTimeout(() => {
      const rate = rateFor(marketNow(), direction);
      if (!rate || amount === null) return;
      const e = marketEstimate(String(amount), rate);
      if (e) quietSince = performance.now() + visorDisplay.say(`₹${e.rupees}`);
    }, 1150);
  };

  timers.push(window.setTimeout(() => (quietSince = performance.now() + visorDisplay.say('HI!', { ms: 1900 })), HELLO_AT));

  const unsubscribe = robotCues.subscribe((cue) => {
    if (cue.kind === 'value') {
      if (cue.amount === undefined) return;
      amount = cue.amount;
      quietSince = performance.now() + visorDisplay.say(compactUsdt(cue.amount), { ms: 1300 });
      estimate(robotCues.direction());
    } else if (cue.kind === 'direction') {
      quietSince = performance.now() + visorDisplay.say(cue.direction === 'SELL_USDT' ? 'SELL' : 'BUY', { ms: 1100 });
      if (amount !== null) estimate(cue.direction);
    } else if (cue.kind === 'problem') {
      window.clearTimeout(estimateTimer);
      quietSince = performance.now() + visorDisplay.say('?', { ms: 1800 });
    }
  });

  // The call to action held, and the rate when the robot has been left alone: a light poll, a few times a second.
  const poll = window.setInterval(() => {
    const now = performance.now();
    visorDisplay.hold(robotCues.focus() === 'cta' ? '→' : null, now);
    if (document.visibilityState !== 'visible' || visorDisplay.busy(now) || now - quietSince < IDLE_MS) return;
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
