import './held.css';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Euler, PointLight, Quaternion, Vector3 } from 'three';
import { COLOR } from '@inrp2p/ui/tokens';
import type { Pose } from '../../src/app/(public)/_landing/robot/behaviour.ts';
import type { RobotCue } from '../../src/app/(public)/_landing/robot/cues.ts';
import { MARK_ARC_RADIUS } from '../../src/app/(public)/_landing/robot/materials.ts';
import { Overlay, type Registration } from './overlay.tsx';
import { Price } from './price.ts';
import { type ArcState, CLOSED, OPEN, Rings } from './rings.ts';
import {
  AT,
  type Anchors,
  DURATION,
  FPS,
  FRAME,
  HELD_RATE,
  type Lens,
  RING,
  ROBOT_CUES,
  SHOTS,
  WAVE_SPEED,
  inOut,
  out,
  shotAt,
  smooth,
  span,
  wind,
  worldShown,
} from './score.ts';
import { renderSoundtrack } from './sound.ts';
import { Storm, type StormFrame } from './storm.ts';
import { World } from './world.ts';

/**
 * HELD's stage: draws the film's frame for any moment, on request (`window.film.seek`).
 *
 * The page's layers are drawn first (the chat, the word, the phones, the card), then — when the shot is in the
 * world — the world: the robot moved to the moment on its own clock and acted, and every sub-frame of the exposure
 * placed exactly: the camera on its path, the storm on its clocks, the arcs in flight or closed. Frames asked for in
 * order are exact; an earlier one starts the robot again from its first moment.
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

/** The robot's clock runs this far ahead of the film's, so its first frame finds it settled. */
const PREROLL = 2;
/** A 180° shutter: each frame is exposed for half its length. */
const SHUTTER = 0.5 / FPS;

const canvas = document.getElementById('world') as HTMLCanvasElement;
const root = createRoot(document.getElementById('overlay')!);
const registration: { -readonly [K in keyof Registration]: Registration[K] } = { mark: null, lockup: null };
const draw = (t: number) => flushSync(() => root.render(<Overlay t={t} registration={{ ...registration }} />));
const q = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);

let world!: World;
let storm!: Storm;
let rings!: Rings;
let price!: Price;
let ringLight!: PointLight;
let anchors!: Anchors;
/** Where the 3D ring sits on screen as the film cuts to the phone: the product's own ring takes its place. */
let ringOnScreen = { x: FRAME.width / 2, y: FRAME.height / 2, r: 240 };

const ready = (async () => {
  // The storm and the price are set in Geist on canvases: the faces must be loaded before a letter is drawn.
  await Promise.all(['600 104px Geist', '500 20px Geist', '400 20px Geist'].map((f) => document.fonts.load(f)));
  await document.fonts.ready;
  canvas.style.width = `${FRAME.width}px`;
  canvas.style.height = `${FRAME.height}px`;
  world = new World(canvas);
  storm = new Storm();
  rings = new Rings();
  price = new Price();
  ringLight = new PointLight(COLOR['brand-primary'], 0, 18, 1.6);
  ringLight.position.copy(RING.centre);
  world.scene.add(storm.mesh, ...rings.arcs, rings.wave, price.mesh, ringLight);
  world.moveRobot(PREROLL, { cues: [], look: { viewer: new Vector3(0, 0.4, 30) } });
  anchors = { mark: world.figure.mark.getWorldPosition(new Vector3()).add(new Vector3(0, 0, 0.03)) };
  await world.ready();

  // Where the ring is on screen at the cut to the phone.
  const ringShot = SHOTS.find((s) => s.name === 'ring')!;
  setCamera(ringShot.lens(1, AT.phone, anchors), 0, 0);
  ringOnScreen = project(RING.centre, new Vector3(RING.radius, 0, 0));

  // Where the mark comes to rest on the last card.
  draw(AT.card + 1);
  const lockup = q('[data-film="lockup"]');
  if (lockup) {
    const r = lockup.getBoundingClientRect();
    registration.lockup = { x: r.x, y: r.y, size: r.width };
  }
  draw(0);
})();

// ——— the camera ———————————————————————————————————————————————————————————————————————————————————————

/** Sub-pixel offsets for each sub-frame (Halton 2, 3): the exposure's anti-aliasing. */
function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  for (let n = i + 1; n > 0; n = Math.floor(n / base)) {
    f /= base;
    r += f * (n % base);
  }
  return r;
}

function setCamera(lens: Lens, sample: number, shake: number): void {
  const cam = world.camera;
  cam.position.copy(lens.pos);
  if (shake > 0) cam.position.add(new Vector3(Math.sin(sample * 3.1 + lens.pos.x * 40) * shake, Math.sin(sample * 1.7 + lens.pos.y * 37) * shake, 0));
  cam.fov = lens.fov;
  cam.lookAt(lens.at);
  const jx = sample > 0 ? halton(sample, 2) - 0.5 : 0;
  const jy = sample > 0 ? halton(sample, 3) - 0.5 : 0;
  cam.setViewOffset(FRAME.width, FRAME.height, jx, jy, FRAME.width, FRAME.height);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
}

/** A point, and a point at a distance from it, on screen: centre and radius in pixels. */
function project(centre: Vector3, offset: Vector3): { x: number; y: number; r: number } {
  const a = centre.clone().project(world.camera);
  const b = centre.clone().add(offset).project(world.camera);
  const x = ((a.x + 1) / 2) * FRAME.width;
  const y = ((1 - a.y) / 2) * FRAME.height;
  return { x, y, r: Math.hypot(((b.x + 1) / 2) * FRAME.width - x, ((1 - b.y) / 2) * FRAME.height - y) };
}

// ——— the robot ——————————————————————————————————————————————————————————————————————————————————————————

const cues = ROBOT_CUES.map((c) => ({ at: c.at + PREROLL, cue: c.cue as RobotCue }));

/** What the film asks of the robot's body on top of its behaviour at `t`. */
function acting(t: number) {
  return (pose: Pose): Pose => {
    const open = t < AT.eyesOpen ? 0 : out(span(t, AT.eyesOpen, AT.eyesOpen + 0.22));
    // The chest charges arc by arc; each goes dark as its light leaves for the sky; at the end the mark is whole.
    const arc = (i: number) => {
      const charge = smooth(span(t, AT.charge[i]!, AT.charge[i]! + 0.16)) * 2.6;
      const leave = 1 - span(t, AT.launch + i * 0.05, AT.launch + i * 0.05 + 0.12);
      const home = smooth(span(t, AT.mark[i]!, AT.mark[i]! + 0.2)) * 1.4;
      return t < AT.ending ? charge * leave : home;
    };
    const hub = t < AT.ending ? smooth(span(t, AT.charge[2] + 0.15, AT.charge[2] + 0.3)) * 2 * (1 - span(t, AT.launch, AT.launch + 0.2)) : smooth(span(t, AT.hub, AT.hub + 0.25)) * 1.4;
    return {
      ...pose,
      eyeOpen: pose.eyeOpen * open,
      arcGlow: [pose.arcGlow[0] + arc(0), pose.arcGlow[1] + arc(1), pose.arcGlow[2] + arc(2)],
      hubGlow: pose.hubGlow + hub,
    };
  };
}

/** The antenna in the wind: a lean, and a fast tremble on top of it. */
function sway(t: number) {
  const w = wind(t);
  const tau = Math.PI * 2;
  return {
    pitch: w * (0.05 + 0.045 * Math.sin(tau * 7.3 * t) + 0.025 * Math.sin(tau * 12.1 * t + 1.3)),
    roll: w * (0.035 * Math.sin(tau * 6.1 * t + 0.4) + 0.02 * Math.sin(tau * 13.7 * t)),
  };
}

// ——— the lock ———————————————————————————————————————————————————————————————————————————————————————————

const FRONT = new Quaternion();
/** The chest mark's disc faces +y in its own frame; an arc card faces +z. */
const CARD_FROM_MARK = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, 0));

function setLock(ts: number): void {
  // The figure the market shows is the frame's own, whole across its exposure: a price is read, not smeared.
  const moving = Price.moving(Math.round(ts * FPS) / FPS);
  if (ts < AT.launch || ts >= AT.sms) {
    rings.set([null, null, null]);
    rings.setWave(RING.centre, FRONT, 1, 0);
    ringLight.intensity = 0;
    price.show(moving, ts >= AT.price && ts < AT.sms ? smooth(span(ts, AT.price, AT.price + 0.5)) : 0);
    return;
  }
  const from = world.figure.mark.getWorldPosition(new Vector3());
  const facing = world.figure.mark.getWorldQuaternion(new Quaternion()).multiply(CARD_FROM_MARK);
  const states: (ArcState | null)[] = [0, 1, 2].map((k) => {
    if (ts < AT.snap) {
      const p = span(ts, AT.launch + k * 0.05, AT.snap - 0.05);
      if (p <= 0) return null;
      const lift = out(p);
      // Up and forward from the chest to the price, on a curve; growing all the way; spinning up, then settling.
      const control = from.clone().add(new Vector3(0, 1.7, 2.6));
      const a = from.clone().lerp(control, lift);
      const b = control.clone().lerp(RING.centre, lift);
      const position = a.lerp(b, lift);
      const radius = MARK_ARC_RADIUS * (RING.radius / MARK_ARC_RADIUS) ** smooth(p);
      const spin = (1 - out(p)) * Math.PI * 2.4;
      const quaternion = facing.clone().slerp(FRONT, smooth(p)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), spin));
      return { position, quaternion, radius, half: OPEN, light: 1.35, opacity: Math.min(1, p * 8) };
    }
    const close = out(span(ts, AT.snap, AT.snap + 0.07));
    const flare = (1 - span(ts, AT.snap, AT.snap + 0.8)) ** 2;
    return { position: RING.centre, quaternion: FRONT, radius: RING.radius, half: OPEN + (CLOSED - OPEN) * close, light: 1 + 1.4 * flare, opacity: 1 };
  });
  rings.set(states);
  const since = ts - AT.snap;
  rings.setWave(RING.centre, FRONT, RING.radius + Math.max(0, since) * WAVE_SPEED, since >= 0 ? (1 - span(ts, AT.snap, AT.snap + 1.3)) ** 1.5 : 0);
  ringLight.intensity = ts < AT.snap ? 5 * span(ts, AT.launch, AT.snap) : 9 + 30 * (1 - span(ts, AT.snap, AT.snap + 0.6)) ** 2;
  price.show(ts < AT.snap ? moving : HELD_RATE, 1);
}

function stormFrame(ts: number, lens: Lens): StormFrame {
  const distance = lens.pos.distanceTo(lens.at);
  return {
    t: ts,
    force: smooth(span(ts, AT.reveal - 0.3, AT.reveal + 1.0)),
    freeze: { at: AT.snap, origin: RING.centre, speed: WAVE_SPEED },
    resume: AT.restart,
    ring: ts >= AT.restart ? { centre: RING.centre, normal: new Vector3(0, 0, 1), radius: RING.radius } : null,
    fallen: ts >= AT.pleased ? 1 : 0,
    focus: { distance, depth: Math.max(1.2, distance * 0.85) },
  };
}

// ——— the page's own motion, and its cameras ——————————————————————————————————————————————————————————————————

/** Every CSS animation and transition on the page, run by the film's clock. */
const began = new WeakMap<Animation, number>();
function runMotion(t: number) {
  for (const a of document.getAnimations()) {
    if (!began.has(a)) began.set(a, t);
    a.pause();
    const endless = a.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY;
    a.currentTime = (endless ? t : t - began.get(a)!) * 1000;
  }
}

/** The phone: from the product's ring, where the sky's ring was, back to the whole quote. */
function placePhone(t: number): void {
  const camera = q('[data-film="phone-camera"]');
  if (!camera) return;
  camera.style.transform = 'none';
  const ring = q('[data-motion="countdown-arc"]');
  const device = camera.firstElementChild as HTMLElement | null;
  if (!ring || !device) return;
  const rr = ring.getBoundingClientRect();
  const dr = device.getBoundingClientRect();
  // The countdown's circle is r = 20 in a 48-unit box.
  const ringR = (rr.width * 20) / 48;
  const ringC = { x: rr.x + rr.width / 2, y: rr.y + rr.height / 2 };
  const start = { s: ringOnScreen.r / ringR, x: ringOnScreen.x, y: ringOnScreen.y, ox: ringC.x, oy: ringC.y };
  const restScale = 1.12;
  const rest = { s: restScale, x: FRAME.width / 2, y: FRAME.height / 2 + 8, ox: dr.x + dr.width / 2, oy: dr.y + dr.height / 2 };
  const k = inOut(span(t, AT.phone + 0.08, AT.phone + 1.25));
  const push = 1 + 0.035 * span(t, AT.accepted, AT.resume);
  const s = start.s * (rest.s / start.s) ** k * push;
  const ox = start.ox + (rest.ox - start.ox) * k;
  const oy = start.oy + (rest.oy - start.oy) * k;
  const x = start.x + (rest.x - start.x) * k;
  const y = start.y + (rest.y - start.y) * k;
  camera.style.transform = `translate(${x - ox * s}px, ${y - oy * s}px) scale(${s})`;
  // The thumb lands on "Accept quote".
  const touch = q('[data-film="touch"]');
  const accept = [...device.querySelectorAll('button')].find((b) => b.textContent?.includes('Accept'));
  if (touch && accept) {
    const b = accept.getBoundingClientRect();
    const d = device.getBoundingClientRect();
    touch.style.left = `${(b.x + b.width * 0.55 - d.x) / s}px`;
    touch.style.top = `${(b.y + b.height * 0.5 - d.y) / s}px`;
  }
}

// ——— a frame ——————————————————————————————————————————————————————————————————————————————————————————————

async function seek(t: number): Promise<void> {
  await ready;
  t = Math.min(Math.max(t, 0), DURATION);
  draw(t);
  runMotion(t);
  placePhone(t);
  if (!worldShown(t)) {
    canvas.style.visibility = 'hidden';
    return;
  }
  canvas.style.visibility = 'visible';
  const shot = shotAt(t)!;
  world.evening = t >= AT.pleased ? 1 : 0;
  const lensNow = shot.lens(span(t, shot.from, shot.to), t, anchors);
  world.moveRobot(t + PREROLL, {
    cues,
    look: { viewer: t >= AT.ending ? lensNow.pos.clone() : new Vector3(0, 0.4, 30), rate: RING.centre, panel: RING.centre },
    adjust: acting(t),
    antenna: sway(t),
  });
  world.lens.samples = shot.samples;
  world.lens.expose = (i, _n, offset) => {
    const ts = t + offset * SHUTTER;
    const lens = shot.lens(span(ts, shot.from, shot.to), ts, anchors);
    const shake = shot.name === 'lock' && ts >= AT.snap ? 0.1 * (1 - span(ts, AT.snap, AT.snap + 0.55)) ** 2 : 0;
    setCamera(lens, i, shake);
    storm.update(stormFrame(ts, lens), world.camera);
    setLock(ts);
  };
  world.lens.render(Math.round(t * FPS));
  // The chest's arcs, where they are on screen at the cut to the mark.
  if (shot.name === 'ending') {
    setCamera(shot.lens(1, AT.logo - 1e-4, anchors), 0, 0);
    const centre = world.figure.mark.localToWorld(new Vector3(0, 0.02, 0));
    const edge = world.figure.mark.localToWorld(new Vector3(MARK_ARC_RADIUS, 0.02, 0));
    registration.mark = project(centre, edge.sub(centre));
  }
}

window.film = {
  ready: ready.then(() => seek(0)),
  duration: DURATION,
  fps: FPS,
  seek,
  soundtrack: () => renderSoundtrack(),
};
