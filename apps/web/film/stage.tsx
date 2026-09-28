import './film.css';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { RobotScene, type TimedCue } from '../src/app/(public)/_landing/robot/scene.ts';
import { type Camera, type Layout, cameraAt, framing, onScreen, transformOf } from './camera.ts';
import { Film } from './Film.tsx';
import { renderSoundtrack } from './sound.ts';
import { AT, CUES, DURATION, FPS, OPENING_MOOD, PREROLL, eveningAt, focusAt, inOut, progress, shotAt, spillAt } from './timeline.ts';

/**
 * The film's page: draws the frame for any moment, on request.
 *
 * `window.film.seek(t)` renders the page for `t`, puts every CSS animation and transition on the film's clock
 * rather than the wall's, measures where things were laid out, points the camera, and moves the robot to `t` —
 * hearing on the way every cue the score gives it — before drawing it where the camera puts its stage. Frames asked
 * for in order are exact; asking for an earlier one starts the robot again from its first moment. The render script
 * (`scripts/film.ts`) asks for every frame in turn and photographs each; the preview (`index.html`) asks as it plays.
 */

declare global {
  interface Window {
    film: {
      readonly ready: Promise<void>;
      readonly duration: number;
      readonly fps: number;
      seek(t: number): Promise<void>;
      /** The soundtrack as a 48 kHz stereo WAV, base64. */
      soundtrack(): Promise<string>;
    };
  }
}

const mount = document.getElementById('film')!;
const canvas = document.getElementById('robot') as HTMLCanvasElement;
const root = createRoot(mount);
const draw = (t: number) => flushSync(() => root.render(<Film t={t} />));

draw(0);
const scope = document.querySelector<HTMLElement>('[data-robot-scope]');
const q = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);

let scene!: RobotScene;
const sceneReady = new Promise<void>((resolve) => {
  scene = new RobotScene({ canvas, scope, direction: 'SELL_USDT', mood: OPENING_MOOD, manual: true, seed: 20260916, still: false, onFirstFrame: resolve });
});

/** The chest mark at rest, as a fraction of the robot's stage: measured once, from the figure itself. */
let markAtRest = { fx: 0.5, fy: 0.88, fr: 0.04 };

const ready = (async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
  await sceneReady;
  const box = rectOf(q('[data-film="robot"]')!);
  scene.place({ x: box.x, y: box.y, size: box.w });
  const m = scene.markOnScreen();
  markAtRest = { fx: (m.x - box.x) / box.w, fy: (m.y - box.y) / box.w, fr: m.r / box.w };
})();

function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}

/** Every CSS animation and transition on the page, run by the film's clock: loops by its time, the rest from when they began. */
const began = new WeakMap<Animation, number>();
function runMotion(t: number) {
  for (const a of document.getAnimations()) {
    if (!began.has(a)) began.set(a, t);
    a.pause();
    const endless = a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY;
    a.currentTime = (endless ? t : t - began.get(a)!) * 1000;
  }
}

/** Where things are on the page at this moment, in page pixels: measured with the camera off. */
function measure(): Layout {
  const robot = rectOf(q('[data-film="robot"]')!);
  const rates = document.querySelectorAll('[data-robot-target="rate"]');
  const size = robot.w;
  return {
    robot: { x: robot.x, y: robot.y, size },
    mark: { x: robot.x + markAtRest.fx * size, y: robot.y + markAtRest.fy * size, r: markAtRest.fr * size },
    column: rectOf(q('[data-film="column"]')!),
    rate: rates.length > 0 ? rectOf(rates[rates.length - 1]!) : null,
  };
}

// The robot's own clock runs PREROLL seconds ahead of the film's, so the first frame finds it already waiting.
let robotAt = Number.NEGATIVE_INFINITY;
function moveRobot(t: number) {
  if (t < robotAt) {
    scene.reset();
    registration = null;
    robotAt = Number.NEGATIVE_INFINITY;
  }
  const from = robotAt === Number.NEGATIVE_INFINITY ? -PREROLL - 1 : robotAt;
  const cues: TimedCue[] = CUES.filter((b) => b.at > from && b.at <= t).map((b) => ({ at: b.at + PREROLL, cue: b.cue }));
  scene.advance(t + PREROLL, cues, focusAt(t));
  robotAt = t;
}

/** The client's pointer: in from below, onto "Accept quote", a press, and away once the quote is accepted. */
let acceptAt: { x: number; y: number } | null = null;
function placeCursor(t: number) {
  const cursor = q<SVGElement>('[data-film="cursor"]')!;
  const button = q('[data-film="accept"]');
  if (button) {
    const b = rectOf(button);
    acceptAt = { x: b.x + b.w * 0.62, y: b.y + b.h * 0.58 };
  }
  const shown = progress(t, AT.cursorIn, AT.cursorIn + 0.2) * (1 - progress(t, AT.accepted + 0.2, AT.accepted + 0.5));
  if (!acceptAt || shown <= 0) {
    cursor.style.opacity = '0';
    return;
  }
  const p = progress(t, AT.cursorIn, AT.cursorOn, inOut);
  const x = acceptAt.x + (1 - p) * 150;
  const y = acceptAt.y + (1 - p) * 200;
  const press = t >= AT.press - 0.08 && t < AT.press + 0.1 ? 0.9 : 1;
  cursor.style.opacity = String(shown);
  cursor.style.transform = `translate(${x - 2}px, ${y - 2}px) scale(${press})`;
}

/** The logo card: the supplied mark, placed so its arcs stand exactly where the chest's arcs were at the cut. */
let registration: { x: number; y: number; r: number } | null = null;
/** The arcs' centre and centre-line radius in the supplied 1024-pixel file, measured from it. */
const LOGO_ARCS = { x: 511.5, y: 514.5, r: 330 };
function placeLogo(layout: Layout) {
  const logo = q<HTMLImageElement>('[data-film="logo"]');
  if (!logo) return;
  if (!registration) {
    const cut = framing('chestMacro', layout);
    const box = onScreen(cut, { x: layout.robot.x, y: layout.robot.y, w: layout.robot.size, h: layout.robot.size });
    scene.place({ x: box.x, y: box.y, size: box.w });
    registration = scene.markOnScreen();
  }
  const s = registration.r / LOGO_ARCS.r;
  logo.style.transform = `translate(${registration.x - LOGO_ARCS.x * s}px, ${registration.y - LOGO_ARCS.y * s}px) scale(${s})`;
}

async function seek(t: number): Promise<void> {
  await ready;
  t = Math.min(Math.max(t, 0), DURATION);
  draw(t);
  runMotion(t);

  const content = q('[data-film="content"]')!;
  const backdrop = q('[data-film="backdrop"]')!;
  content.style.transform = 'none';
  backdrop.style.transform = 'none';
  const layout = measure();
  const hero = rectOf(q('[data-film="hero"]')!);
  Object.assign(q('[data-film="light"]')!.style, { left: `${hero.x}px`, top: `${hero.y}px`, width: `${hero.w}px`, height: `${hero.h}px` });
  q('[data-film="evening"]')!.style.opacity = String(eveningAt(t));
  placeCursor(t);

  const shot = shotAt(t);
  const logo = shot === null;
  const camera: Camera = shot ? cameraAt(shot, t, layout) : framing('chestMacro', layout);
  const transform = transformOf(camera);
  content.style.transform = transform;
  backdrop.style.transform = transform;

  const box = onScreen(camera, { x: layout.robot.x, y: layout.robot.y, w: layout.robot.size, h: layout.robot.size });
  scene.place({ x: box.x, y: box.y, size: box.w });
  scene.light({ evening: eveningAt(t), spill: spillAt(t) });
  // The opening's focus pull: the dots come sharp as the lens settles.
  const blur = 5 * (1 - progress(t, 0.05, 0.95, inOut));
  canvas.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
  canvas.style.visibility = logo ? 'hidden' : 'visible';
  moveRobot(t);
  if (logo) placeLogo(layout);
}

window.film = {
  ready: ready.then(() => seek(0)),
  duration: DURATION,
  fps: FPS,
  seek,
  soundtrack: () => renderSoundtrack(),
};
