import { robotCues } from './cues.ts';

/**
 * What the visitor is doing on the page as a whole, for the home page's robot (docs/ROBOT_BEHAVIOUR.md): how long they
 * have been quiet, whether the page is scrolling and which way, whether the pointer has just left the window through
 * its top edge — and when they come back to the robot, to the tab after a while away or to the top of the page after
 * reading on, a `back` cue.
 *
 * A handful of passive listeners that store a time and a flag: no layout is read and nothing is drawn here. The
 * robot reads the snapshot once a frame (`scene.ts`), the visor's director a few times a second (`director.ts`).
 * Started by the home page's robot stage only, so in the workspace the snapshot stays at rest: never quiet, never
 * scrolling, never leaving — and nothing here ever reaches a robot with a state of record to keep.
 *
 * Browser only. Off under reduced motion, like everything else that moves the robot.
 */

/** How long the tab must have been hidden for coming back to it to be a return. */
const TAB_AWAY_MS = 6000;
/** How long the robot must have been out of sight for scrolling back up to it to be a return. */
const SCROLL_AWAY_MS = 4000;
/** A scroll this recent still counts as scrolling. */
const SCROLLING_MS = 240;
/** Less of the robot than this on screen and it has been scrolled away; this much and the visitor is back. */
const GONE_RATIO = 0.2;
const BACK_RATIO = 0.6;

const page = {
  started: 0,
  activeAt: 0,
  scrollAt: Number.NEGATIVE_INFINITY,
  direction: 0 as -1 | 0 | 1,
  lastY: 0,
  leaving: false,
};

export const robotPresence = {
  /** Whether anything is watching the page for the robot: only the home page's stage starts it. */
  on(): boolean {
    return page.started > 0;
  },
  /** Seconds since the visitor last moved, typed, touched or scrolled; 0 where nothing is watching (the workspace). */
  quiet(now = performance.now()): number {
    return page.started > 0 ? Math.max(0, now - page.activeAt) / 1000 : 0;
  },
  /** 1 while the page scrolls down, -1 while it scrolls up, 0 when it is still. */
  scrolling(now = performance.now()): -1 | 0 | 1 {
    return page.started > 0 && now - page.scrollAt < SCROLLING_MS ? page.direction : 0;
  },
  /** The pointer left the window through its top edge — towards the tabs and the address bar — and is not back. */
  leaving(): boolean {
    return page.started > 0 && page.leaving;
  },
};

export function startPresence(stage: HTMLElement): () => void {
  if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};
  if (page.started > 0) return () => {};
  const now = performance.now();
  page.started = now;
  page.activeAt = now;
  page.lastY = window.scrollY;
  page.leaving = false;

  const active = () => {
    page.activeAt = performance.now();
  };
  const moved = () => {
    page.activeAt = performance.now();
    page.leaving = false;
  };
  const scrolled = () => {
    const y = window.scrollY;
    const t = performance.now();
    page.activeAt = t;
    if (y !== page.lastY) {
      page.direction = y > page.lastY ? 1 : -1;
      page.scrollAt = t;
      page.lastY = y;
    }
  };
  const left = (e: MouseEvent) => {
    if (e.relatedTarget === null && e.clientY <= 0) page.leaving = true;
  };

  let visible = true;
  let hiddenAt = Number.POSITIVE_INFINITY;
  const shown = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = performance.now();
      return;
    }
    const t = performance.now();
    // Coming back counts as activity: the robot must not be found asleep on the tab it was left on.
    page.activeAt = t;
    page.leaving = false;
    if (visible && t - hiddenAt >= TAB_AWAY_MS) robotCues.emit({ kind: 'back', via: 'tab' });
    hiddenAt = Number.POSITIVE_INFINITY;
  };

  // Out of sight and back again: the robot is scrolled away while the visitor reads on, and comes back into view.
  let goneAt: number | null = null;
  const seen = new IntersectionObserver(
    ([entry]) => {
      if (!entry) return;
      const t = performance.now();
      visible = entry.intersectionRatio >= GONE_RATIO;
      if (entry.intersectionRatio < GONE_RATIO) goneAt ??= t;
      else if (entry.intersectionRatio >= BACK_RATIO && goneAt !== null) {
        if (t - goneAt >= SCROLL_AWAY_MS) robotCues.emit({ kind: 'back', via: 'scroll' });
        goneAt = null;
      }
    },
    { threshold: [0, GONE_RATIO, BACK_RATIO] },
  );
  seen.observe(stage);

  const passive = { passive: true } as const;
  window.addEventListener('pointermove', moved, passive);
  window.addEventListener('pointerdown', active, passive);
  window.addEventListener('keydown', active, passive);
  window.addEventListener('wheel', active, passive);
  window.addEventListener('touchstart', active, passive);
  window.addEventListener('scroll', scrolled, passive);
  document.addEventListener('mouseout', left, passive);
  document.addEventListener('visibilitychange', shown);

  return () => {
    page.started = 0;
    page.leaving = false;
    seen.disconnect();
    window.removeEventListener('pointermove', moved);
    window.removeEventListener('pointerdown', active);
    window.removeEventListener('keydown', active);
    window.removeEventListener('wheel', active);
    window.removeEventListener('touchstart', active);
    window.removeEventListener('scroll', scrolled);
    document.removeEventListener('mouseout', left);
    document.removeEventListener('visibilitychange', shown);
  };
}
