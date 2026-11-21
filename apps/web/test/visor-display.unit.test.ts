import { describe, expect, it } from 'vitest';
import { LED_COLS, LED_ROWS, VisorDisplay } from '../src/app/(public)/_landing/robot/display.ts';
import { compactUsdt } from '../src/app/(public)/_landing/robot/director.ts';

/** The display's rows as text, top row first: `#` lit, `.` dark. */
const rows = (d: VisorDisplay): string[] =>
  Array.from({ length: LED_ROWS }, (_, r) => {
    const base = (LED_ROWS - 1 - r) * LED_COLS;
    return Array.from(d.data.slice(base, base + LED_COLS), (v) => (v ? '#' : '.')).join('');
  });

/**
 * The hero robot's visor display (display.ts): what the live robot's shader and the still robot's overlay both draw.
 * The words have to land where the eyes were, fade in and out rather than cut, and give the face back.
 */
describe('the robot visor display', () => {
  it('shows a short word still and in the middle, then gives the eyes back', () => {
    const d = new VisorDisplay();
    d.say('HI!', { ms: 1000 }, 0);
    d.frame(0);
    d.frame(500);
    const lit = rows(d);
    expect(lit.some((r) => r.includes('#'))).toBe(true);
    // Centred: as much dark on the left as on the right, give or take a column.
    const cols = lit.reduce((acc, r) => acc.map((v, i) => v || r[i] === '#'), Array<boolean>(LED_COLS).fill(false));
    const left = cols.indexOf(true);
    const right = LED_COLS - 1 - cols.lastIndexOf(true);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    // Fades in, and back out once its time is up.
    expect(d.frame(600).level).toBeGreaterThan(0.5);
    let level = 1;
    for (let t = 1000; t < 2000; t += 16) level = d.frame(t).level;
    expect(level).toBe(0);
  });

  it('runs a word wider than the display across it, entering from the right', () => {
    const d = new VisorDisplay();
    const ms = d.say('₹10,082,000', {}, 0);
    expect(ms).toBeGreaterThan(1000);
    d.frame(0);
    // At the start the words are still off to the right: nothing lit yet.
    expect(rows(d).join('')).not.toContain('#');
    d.frame(ms / 2);
    expect(rows(d).join('')).toContain('#');
    expect(d.busy(ms + 1)).toBe(false);
  });

  it('keeps a held word up under anything said, and lets go when released', () => {
    const d = new VisorDisplay();
    d.hold('→', 0);
    for (let t = 0; t < 400; t += 16) d.frame(t);
    expect(d.frame(400).level).toBeGreaterThan(0.95);
    d.hold(null, 400);
    let level = 1;
    for (let t = 400; t < 1400; t += 16) level = d.frame(t).level;
    expect(level).toBe(0);
  });

  it('says an amount the way a person does', () => {
    expect(compactUsdt(25000)).toBe('25K');
    expect(compactUsdt(2500)).toBe('2.5K');
    expect(compactUsdt(1250000)).toBe('1.25M');
    expect(compactUsdt(750)).toBe('750');
  });
});
