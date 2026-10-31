/**
 * Keeps the live robot inside the frame budget of the device it is drawn on.
 *
 * The robot is drawn every frame it is on screen, and on a phone whose GPU cannot draw it in time it takes the page's
 * scrolling down with it. So the robot watches its own frames: when they come markedly slower than the display's own
 * (measured before the robot started drawing, so a browser that caps the page at 30 frames a second — a phone saving
 * its battery — is not mistaken for a slow GPU), it draws at a lower pixel ratio, a step at a time, never below one
 * pixel per CSS pixel. When even that cannot keep up, it gives up and the still robot — the same figure, the same pose
 * — takes over. A device that keeps up never sees any of this.
 *
 * Pure, so the decisions can be tested without a GPU.
 */
export interface GovernorOptions {
  /** The display's own frame interval, ms, as the page saw it before the robot drew. */
  readonly period: number;
  /** The pixel ratio the robot starts at. */
  readonly ratio: number;
}

/** What a frame told the governor: keep going, draw at another ratio, or hand back to the still robot. */
export type GovernorVerdict = { readonly kind: 'keep' } | { readonly kind: 'ratio'; readonly ratio: number } | { readonly kind: 'still' };

/** Frames after a start or a change, not judged: the first frames of any change pay for it (buffers, caches). */
const SETTLE = 20;
/** Frames judged together; their median decides, so a single hitch — a collection, a decode — decides nothing. */
const WINDOW = 60;
/** Slower than this many display frames is slow. */
const SLOW = 1.5;
/** One step of pixel ratio down, and the floor. */
const STEP = 0.25;
const FLOOR = 1;
/** An interval this long is a pause (a background tab, a paused robot), not a slow frame. */
const PAUSE_MS = 250;

const KEEP: GovernorVerdict = { kind: 'keep' };

export class FrameGovernor {
  private readonly limit: number;
  private ratio: number;
  private settle = SETTLE;
  private frames: number[] = [];
  /** Said `still` once: the robot has stopped drawing, and there is nothing left to judge. */
  private done = false;

  constructor(options: GovernorOptions) {
    this.limit = Math.max(options.period, 1000 / 120) * SLOW;
    this.ratio = options.ratio;
  }

  /** One frame's interval, ms. */
  frame(interval: number): GovernorVerdict {
    if (this.done || !(interval > 0) || interval >= PAUSE_MS) return KEEP;
    if (this.settle > 0) {
      this.settle--;
      return KEEP;
    }
    this.frames.push(interval);
    if (this.frames.length < WINDOW) return KEEP;
    const median = [...this.frames].sort((a, b) => a - b)[WINDOW / 2]!;
    this.frames = [];
    if (median <= this.limit) return KEEP;
    this.settle = SETTLE;
    if (this.ratio > FLOOR) {
      this.ratio = Math.max(FLOOR, this.ratio - STEP);
      return { kind: 'ratio', ratio: this.ratio };
    }
    this.done = true;
    return { kind: 'still' };
  }

  /** Frames stop being judged while the robot is not drawing; a pause is not a slow frame. */
  pause(): void {
    this.settle = SETTLE;
    this.frames = [];
  }
}

/**
 * The display's frame interval: the median of a few frames while nothing else is drawing. Resolves after `frames`
 * frames, or with 60 Hz if the page is hidden and frames do not come.
 */
export function displayPeriod(frames = 8): Promise<number> {
  return new Promise((resolve) => {
    const seen: number[] = [];
    let last = 0;
    const fallback = window.setTimeout(() => resolve(1000 / 60), 1000);
    const tick = (now: number) => {
      if (last) seen.push(now - last);
      last = now;
      if (seen.length < frames) {
        requestAnimationFrame(tick);
        return;
      }
      window.clearTimeout(fallback);
      resolve([...seen].sort((a, b) => a - b)[Math.floor(seen.length / 2)]!);
    };
    requestAnimationFrame(tick);
  });
}
