import { describe, expect, it } from 'vitest';
import { AT, DURATION, FPS, HELD_RATE, HOOK_MESSAGES, HOOK_SHOUTS, ROBOT_CUES, SHOTS, TRADE, illustrative, shotAt, worldShown } from '../film/held/score.ts';
import { heard } from '../film/held/sound.ts';

/**
 * HELD's score (`apps/web/film/held/score.ts`), held to what the film promises.
 *
 * The market moves; the rate does not. So the ring holds one figure from the moment it closes, and the trade the
 * phone and the bank's message show is that figure's trade; every figure in the product's world is labelled as an
 * illustration while it is on screen; the robot answers what it has seen, never ahead of it; and the soundtrack
 * never starts a sound before its picture.
 */

const FRAMES = Array.from({ length: DURATION * FPS }, (_, i) => i / FPS);

describe('the film', () => {
  it('plays its beats in order, inside its thirty seconds', () => {
    const beats = [
      AT.hookEnd,
      AT.eyesOpen,
      AT.reveal,
      AT.price,
      AT.lookUp,
      ...AT.charge,
      AT.launch,
      AT.snap,
      AT.frozen,
      AT.calm,
      AT.held,
      AT.ringClose,
      AT.phone,
      AT.tap,
      AT.accepted,
      AT.resume,
      AT.restart,
      AT.sms,
      AT.ping,
      AT.pleased,
      AT.ending,
      ...AT.mark,
      AT.toChest,
      AT.hub,
      AT.logo,
      AT.lockup,
      AT.card,
    ];
    expect(beats).toEqual([...beats].sort((a, b) => a - b));
    expect(beats.every((t) => t > 0 && t < DURATION)).toBe(true);
    // The end card holds, silent, long enough to be read.
    expect(DURATION - AT.card).toBeGreaterThanOrEqual(2);
  });

  it('stays in the world from the market’s return to the mark: the monument, the phone at dusk, the robot', () => {
    for (const t of FRAMES.filter((f) => f >= AT.resume && f < AT.logo)) expect(worldShown(t), `${t.toFixed(3)} s`).toBe(true);
    expect(SHOTS.map((s) => s.name)).toEqual(expect.arrayContaining(['monument', 'message']));
  });

  it('frames a shot whenever it is in the world, and only then', () => {
    for (const t of FRAMES) expect(shotAt(t) !== null, `${t.toFixed(3)} s`).toBe(worldShown(t));
    for (let i = 1; i < SHOTS.length; i++) expect(SHOTS[i]!.from).toBeGreaterThanOrEqual(SHOTS[i - 1]!.to);
  });

  it('opens on the chat, and every message has landed before the cut — coming faster and faster', () => {
    expect(HOOK_MESSAGES.every((m) => m.at > 0 && m.at < AT.hookEnd)).toBe(true);
    expect(HOOK_SHOUTS.every((s) => s.at < AT.hookEnd)).toBe(true);
    const gaps = HOOK_MESSAGES.slice(1).map((m, i) => m.at - HOOK_MESSAGES[i]!.at);
    expect(gaps.every((g, i) => g > 0 && (i === 0 || g <= gaps[i - 1]! + 1e-9))).toBe(true);
  });
});

describe('the rate, held', () => {
  it('is the trade the phone quotes and the bank credits', () => {
    expect(Number(TRADE.usdt) * Number(HELD_RATE)).toBe(Number(TRADE.inr));
    // Written the way an Indian bank writes it: 1,02,00,000.00.
    expect(TRADE.credited.replaceAll(',', '')).toBe(`${TRADE.inr}.00`);
    expect(TRADE.credited).toMatch(/^\d{1,2}(,\d{2})*,\d{3}\.\d{2}$/);
  });

  it('is labelled as an illustration wherever a figure of the product is on screen, and nowhere else', () => {
    const shown = { 'the price in the sky': 9.6, 'the ring closing': 11.9, 'the frozen world': 13, 'the ring': 15.5, 'the quote': 16.5, 'the rate in the ground': 19.5, 'the bank': 22.4, 'the rate behind the robot': 24.6 };
    for (const [what, t] of Object.entries(shown)) expect(illustrative(t), what).toBe(true);
    const clear = { 'the chat': 2, 'the eyes': 5.3, 'the word': 14.5, 'the mark': 27, 'the card': 29 };
    for (const [what, t] of Object.entries(clear)) expect(illustrative(t), what).toBe(false);
  });
});

describe('the robot', () => {
  it('reads the price only once it is there — and never performs: it is not made to smile', () => {
    expect(ROBOT_CUES.map((c) => c.at)).toEqual([...ROBOT_CUES.map((c) => c.at)].sort((a, b) => a - b));
    const read = ROBOT_CUES.find((c) => c.cue.kind === 'rate')!;
    expect(read.at).toBeGreaterThan(AT.price);
    const moods: readonly string[] = ROBOT_CUES.flatMap((c) => (c.cue.kind === 'mood' ? [c.cue.mood] : []));
    expect(moods).not.toContain('success');
  });
});

describe('the soundtrack', () => {
  it('starts each sound on the first frame that shows it, never ahead of its picture', () => {
    for (const t of [AT.hookEnd, AT.eyesOpen, AT.reveal, AT.snap, AT.held, AT.tap, AT.accepted, AT.ping, AT.hub, ...AT.charge, ...AT.mark]) {
      const at = heard(t);
      expect(at).toBeGreaterThanOrEqual(t);
      expect(at - t).toBeLessThan(1 / FPS);
      expect(Math.abs(at * FPS - Math.round(at * FPS))).toBeLessThan(1e-9);
    }
    // The ring closes at 11.85 s: the first frame to show it is the one at 11.875 s, and that is where the blow lands.
    expect(heard(AT.snap)).toBe(285 / FPS);
    expect(heard(AT.ping)).toBe(AT.ping);
  });
});
