import { onRows, strip } from '../led/font.ts';

/**
 * The hero robot's visor as a display: a matrix of its own orange LEDs behind the glass, that can show a few words in
 * place of its eyes and then give the face back. One state for the whole page, read by whatever draws the robot — the
 * live figure's visor shader (materials.ts), or the still robot's overlay (VisorOverlay.tsx) — so both show the same.
 *
 * Plain module state, no React and no DOM: the figure reads it once a frame. `say` puts words up for a while (short
 * ones stand still in the middle, long ones run across once, entering from the right); `hold` keeps a word up for as
 * long as it is set, under anything said meanwhile. `frame` reports how far the display is lit (it fades in and out,
 * so the eyes cross-fade with it) and refreshes `data` — one byte per LED, rows from the bottom, as a texture wants.
 */
export const LED_COLS = 26;
export const LED_ROWS = 16;
/** Columns a second for words that run across. */
const SPEED = 15;

interface Show {
  readonly rows: readonly string[];
  readonly width: number;
  readonly marquee: boolean;
  readonly started: number;
  readonly until: number;
}

export class VisorDisplay {
  readonly data = new Uint8Array(LED_COLS * LED_ROWS);
  private current: Show | null = null;
  private held: Show | null = null;
  private heldText: string | null = null;
  private level = 0;
  private last = 0;
  private key = '';

  /** Words up for `ms` (or once across, for words wider than the display); replaces whatever was said before. */
  say(text: string, opts: { ms?: number; marquee?: boolean } = {}, now = performance.now()): number {
    const rows = onRows(strip(text), LED_ROWS);
    const width = rows[0]!.length;
    const marquee = opts.marquee ?? width > LED_COLS;
    const duration = marquee ? ((width + LED_COLS) / SPEED) * 1000 : (opts.ms ?? 1500);
    this.current = { rows, width, marquee, started: now, until: now + duration };
    return duration;
  }

  /** A word kept up while it is set (null lets the eyes back); anything said meanwhile shows over it. */
  hold(text: string | null, now = performance.now()): void {
    if (text === this.heldText) return;
    this.heldText = text;
    this.held = text === null ? null : { ...this.shape(text), started: now, until: Infinity };
  }

  /** Whether something said is still up. */
  busy(now = performance.now()): boolean {
    return this.current !== null && now < this.current.until;
  }

  clear(): void {
    this.current = null;
  }

  /** How lit the display is (0 = the eyes, 1 = the words), and whether `data` changed since the last frame. */
  frame(now = performance.now()): { level: number; dirty: boolean } {
    if (this.current && now >= this.current.until) this.current = null;
    const show = this.current ?? this.held;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const target = show ? 1 : 0;
    this.level += (target - this.level) * Math.min(1, dt * 10);
    if (Math.abs(target - this.level) < 0.002) this.level = target;
    if (!show) return { level: this.level, dirty: false };

    // Which columns of the words are on the display now: a still word centred, a running one sliding in from the right.
    const offset = show.marquee ? Math.floor(((now - show.started) / 1000) * SPEED) - LED_COLS : -Math.floor((LED_COLS - show.width) / 2);
    const key = `${show.rows.join('|')}@${offset}`;
    if (key === this.key) return { level: this.level, dirty: false };
    this.key = key;
    for (let r = 0; r < LED_ROWS; r++) {
      const row = show.rows[r] ?? '';
      const base = (LED_ROWS - 1 - r) * LED_COLS;
      for (let c = 0; c < LED_COLS; c++) this.data[base + c] = row[c + offset] === '#' ? 255 : 0;
    }
    return { level: this.level, dirty: true };
  }

  private shape(text: string): Pick<Show, 'rows' | 'width' | 'marquee'> {
    const rows = onRows(strip(text), LED_ROWS);
    return { rows, width: rows[0]!.length, marquee: false };
  }
}

/** The hero robot's display: one for the page. */
export const visorDisplay = new VisorDisplay();
