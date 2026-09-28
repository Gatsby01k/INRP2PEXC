import { describe, expect, it } from 'vitest';
import { FLOW, HERO, TRUST } from '../src/content/site.ts';
import { AT, BEATS, CUES, DURATION, ILLUSTRATIVE, SHOTS, SUPERS, TRADE, eveningAt, productEase, progress, shotAt } from '../film/timeline.ts';

/**
 * The flagship film's score (`apps/web/film/timeline.ts`), held to what the film is about.
 *
 * The robot reports; it does not perform. So every cue it hears answers something the interface has just shown,
 * the chest's arcs light in order and only as their stages are true, and the trade it watches adds up. The film's
 * words are the site's own, and its figures are labelled as an illustration for as long as they are on screen.
 */

describe('the robot moves second', () => {
  it('hears every cue at or just after the change in the interface it answers — never before', () => {
    for (const beat of BEATS) {
      expect(beat.at, beat.what).toBeGreaterThanOrEqual(beat.ui);
      expect(beat.at - beat.ui, `${beat.what}: answered promptly`).toBeLessThanOrEqual(0.4);
    }
  });

  it('hears its cues in the order of the film, all within it', () => {
    expect(CUES.map((c) => c.at)).toEqual([...CUES.map((c) => c.at)].sort((a, b) => a - b));
    expect(CUES.every((c) => c.at >= 0 && c.at < DURATION)).toBe(true);
  });

  it('lights the chest’s arcs one at a time, in order, each as its stage is reached — and lets them go at the cut', () => {
    const stages = CUES.filter((c) => c.cue.kind === 'stage').map((c) => ({ at: c.at, stage: (c.cue as { stage: number }).stage }));
    expect(stages.map((s) => s.stage)).toEqual([1, 2, 3, 0]);
    expect(stages[0]!.at).toBeGreaterThanOrEqual(AT.accepted);
    expect(stages[1]!.at).toBeGreaterThanOrEqual(AT.final);
    expect(stages[2]!.at, 'only once nothing remains to be paid').toBeGreaterThan(AT.legs.at(-1)!);
    expect(stages[3]!.at).toBe(AT.logo);
  });

  it('reads every payment as it is confirmed', () => {
    const tallies = CUES.filter((c) => c.cue.kind === 'tally').map((c) => c.at);
    expect(tallies).toHaveLength(TRADE.legs.length);
    tallies.forEach((at, i) => expect(at).toBeGreaterThanOrEqual(AT.legs[i]!));
  });

  it('marks the settled trade with the stage, then the mood — so it is marked once', () => {
    const complete = CUES.findIndex((c) => c.cue.kind === 'stage' && c.cue.stage === 3);
    const settled = CUES.findIndex((c) => c.cue.kind === 'mood' && c.cue.mood === 'success');
    expect(complete).toBeLessThan(settled);
  });
});

describe('the trade', () => {
  it('adds up: the quoted amount at the quoted rate, paid in full by its transfers', () => {
    expect(Number(TRADE.usdt) * Number(TRADE.rate)).toBe(Number(TRADE.inr));
    expect(TRADE.legs.reduce((sum, l) => sum + Number(l.amount), 0)).toBe(Number(TRADE.inr));
  });

  it('keeps its own clock honest: transfers confirmed in order, over the afternoon they took', () => {
    const times = TRADE.legs.map((l) => Date.parse(l.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(Date.parse(TRADE.finalAt)).toBeLessThan(times[0]!);
    expect(Date.parse(TRADE.acceptedAt) - Date.parse(TRADE.quotedAt)).toBeLessThan(TRADE.heldForMs);
    expect(AT.legs.every((t, i) => i === 0 || t > AT.legs[i - 1]!)).toBe(true);
    // The film's light follows the afternoon the transfers took: it changes across the payout and nowhere else.
    expect(eveningAt(AT.payout)).toBe(0);
    expect(eveningAt(AT.complete + 0.5)).toBe(1);
    expect(eveningAt(AT.hero)).toBe(0);
  });

  it('is labelled as an illustration for as long as its figures are on screen, and not on the home page', () => {
    expect(ILLUSTRATIVE.from).toBeLessThanOrEqual(1);
    expect(ILLUSTRATIVE.to).toBe(AT.logo);
  });
});

describe('the picture', () => {
  it('is cut into shots end to end, with only the logo card between the trade and the home page', () => {
    for (let i = 1; i < SHOTS.length; i++) {
      const gap = SHOTS[i]!.from - SHOTS[i - 1]!.to;
      if (SHOTS[i - 1]!.to === AT.logo) expect(SHOTS[i]!.from).toBe(AT.hero);
      else expect(gap).toBe(0);
    }
    expect(SHOTS[0]!.from).toBe(0);
    expect(SHOTS.at(-1)!.to).toBe(DURATION);
    expect(shotAt((AT.logo + AT.hero) / 2)).toBeNull();
  });

  it('says only what the site already says, in its words', () => {
    const headings = [FLOW, TRUST].map((s) => ({ eyebrow: s.eyebrow, text: s.heading }));
    for (const line of SUPERS) expect(headings).toContainEqual({ eyebrow: line.eyebrow, text: line.text });
    expect(HERO.voice.lines.ready).toBe('Ready when you are.');
  });

  it('eases every move from rest to rest', () => {
    expect(progress(0, 0, 1)).toBe(0);
    expect(progress(1, 0, 1)).toBe(1);
    expect(progress(0.5, 0, 1)).toBeCloseTo(0.5, 6);
  });

  it('moves the interface on the product’s own curve, cubic-bezier(0.2, 0, 0, 1): quick to leave, long to settle', () => {
    expect(productEase(0)).toBe(0);
    expect(productEase(1)).toBeCloseTo(1, 9);
    expect(productEase(0.5)).toBeCloseTo(0.878, 2);
    const samples = Array.from({ length: 101 }, (_, i) => productEase(i / 100));
    expect(samples.every((v, i) => i === 0 || v >= samples[i - 1]! - 1e-12)).toBe(true);
  });
});
