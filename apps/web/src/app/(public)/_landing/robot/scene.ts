import { Color, HemisphereLight, NeutralToneMapping, PCFShadowMap, PerspectiveCamera, Raycaster, SRGBColorSpace, Scene, Timer, Vector2, Vector3, WebGLRenderer } from 'three';
import type { Direction } from '@inrp2p/kernel';
import { COLOR } from '@inrp2p/ui/tokens';
import { type LookAngles, type LookTarget, type Pose, REST_POSE, RobotBehaviour } from './behaviour.ts';
import { type RobotCue, type RobotFocus, type RobotMood, robotCues } from './cues.ts';
import { HEAD_CENTRE, buildFigure } from './figure.ts';
import { MARK_ARC_RADIUS } from './materials.ts';
import { seeded } from './motion.ts';
import { studio } from './studio.ts';

/**
 * The robot's scene: renderer, camera, studio and figure, and the loop that runs them.
 *
 * Plain three.js rather than a React renderer: one figure in one fixed shot does not need a reconciler, and the
 * page stays free of a dependency that has to be re-released for every React minor version.
 *
 * The camera is fixed and long (22° vertical), like a product photograph: little perspective distortion, so
 * the shell's curves read as designed rather than as a wide-angle bulge. It frames a bust — the antenna's tip to the
 * middle of the chest, the mark just inside the lower edge — at the height of the eyes, so the robot stands beside
 * the quote module as an assistant rather than towering over it. Framing is set vertically, so every stage size
 * shows the same crop — the still image and the live figure line up exactly.
 */

const CAMERA_POSITION = new Vector3(0, -0.1, 6.9);
const CAMERA_TARGET = new Vector3(0, -0.28, 0);
const CAMERA_FOV = 22;
/** Page elements are placed on this plane in front of the robot, so a look at one lands where it is drawn. */
const TARGET_PLANE_Z = 2.4;
const HEAD = new Vector3(HEAD_CENTRE.x, HEAD_CENTRE.y, HEAD_CENTRE.z);

/**
 * Where each look target lives on the page. `rate` is marked only by UI that shows a firm rate; without it,
 * attention falls back to the module (`states.ts`).
 */
const TARGET_SELECTORS: Record<Exclude<LookTarget, 'viewer' | 'entry'>, string> = {
  panel: '[data-robot-target="panel"]',
  amount: '[data-robot-target="amount"]',
  toggle: '[data-robot-target="toggle"]',
  rate: '[data-robot-target="rate"]',
  cta: '[data-robot-target="cta"]',
  row: '[data-robot-target="row"]',
};

/**
 * A manual scene's longest step. However far apart two drawn frames are, the behaviour is moved between them in
 * steps no longer than this, so a film rendered one slow frame at a time moves exactly as it would live.
 */
const MANUAL_STEP = 1 / 120;

/** The key light as the film's day ends: lower, further round, warmer, a little softer. */
const EVENING_KEY = { position: new Vector3(4.6, 3.0, 5.8), color: new Color('#ffd4b0'), intensity: 2.3 } as const;

/** A cue and the moment, in the scene's own seconds, it is heard (manual scenes). */
export interface TimedCue {
  readonly at: number;
  readonly cue: RobotCue;
}

/** Where the robot's square shot lies in a larger canvas, in CSS pixels from the canvas's top left. */
export interface ShotBox {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * The one target outside the hero: the masthead's way into the workspace. The masthead is drawn on the server and
 * ships no script, so the robot listens to it itself — and only a live robot does, because only a live one looks.
 */
const ENTRY_SELECTOR = '[data-robot-target="entry"]';
const ENTRY_EVENTS = ['pointerenter', 'pointerleave', 'focus', 'blur'] as const;

/**
 * How long a target that was not on the page stays "not on the page" before it is looked for again. The
 * workspace keeps the robot across client-side navigation, so the elements it looks at are replaced under it; the
 * home page's never are, and finds each once.
 */
const TARGET_RECHECK_MS = 400;

export interface RobotSceneOptions {
  readonly canvas: HTMLCanvasElement;
  /** The element the robot's look targets live in (the hero). */
  readonly scope: HTMLElement | null;
  readonly direction: Direction;
  /** The mood the page is already in (`cues.ts`), rested in from the first frame. */
  readonly mood?: RobotMood;
  /** The robot stands to the right of what it attends to (the workspace), not to its left (the home page). */
  readonly mirror?: boolean;
  /** Hold one pose and draw only when the size changes. */
  readonly still: boolean;
  /** The pose a still robot holds: rest, unless another is given (a state, drawn for the robot's sheet). */
  readonly pose?: Pose;
  /**
   * Driven from outside rather than by the clock (`advance`): no frame loop, no cues from the page, no greeting on
   * coming online, and the same randomness every run (`seed`). The film.
   */
  readonly manual?: boolean;
  readonly seed?: number;
  /** After the first frames are drawn — called in the same task, so the drawing buffer can still be read. A manual scene calls it once it is ready to draw. */
  readonly onFirstFrame?: () => void;
  /** The GPU took the context away; the caller shows the still robot again. */
  readonly onLost?: () => void;
}

export class RobotScene {
  private readonly options: RobotSceneOptions;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 40);
  private readonly timer = new Timer();
  private readonly figure = buildFigure();
  private readonly lighting: ReturnType<typeof studio>;
  private behaviour: RobotBehaviour;
  /** A manual scene's time, and the pose it last reached. */
  private clock = 0;
  private reached: Pose = REST_POSE;
  /** Where the robot's shot lies in a larger canvas (`frame`), or null for the stage's own framing. */
  private box: ShotBox | null = null;
  /** The warm light of the page's orange on the robot (`light`), made only when first asked for. */
  private spill: HemisphereLight | null = null;
  private readonly day = { position: new Vector3(), color: new Color(), intensity: 0 };
  private readonly targets = new Map<LookTarget, Element>();
  /** When each target missing from the page may next be looked for. */
  private readonly missingUntil = new Map<LookTarget, number>();
  private readonly entry: Element | null;
  private readonly entryHeld = { pointer: false, focus: false };
  private readonly resize: ResizeObserver;
  private readonly unsubscribe: () => void;
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hit = new Vector3();

  private canvasRect: DOMRect | null = null;
  private frame = 0;
  private raf = 0;
  private active = false;
  private compiled = false;
  private compiling: Promise<unknown> | null = null;
  private disposed = false;

  constructor(options: RobotSceneOptions) {
    this.options = options;
    const { canvas } = options;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = SRGBColorSpace;
    // Khronos PBR Neutral keeps the brand orange the orange it was specified as.
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.lighting = studio(this.renderer);
    this.scene.environment = this.lighting.environment;
    this.scene.environmentIntensity = 0.85;
    this.scene.add(...this.lighting.lights, this.figure.root);

    this.camera.position.copy(CAMERA_POSITION);
    this.camera.lookAt(CAMERA_TARGET);
    // Looks are aimed through the camera before anything is drawn when the scene is driven by hand.
    this.camera.updateMatrixWorld();
    const { key } = this.lighting;
    this.day.position.copy(key.position);
    this.day.color.copy(key.color);
    this.day.intensity = key.intensity;

    this.behaviour = this.newBehaviour();
    this.unsubscribe = options.still || options.manual ? () => {} : robotCues.subscribe((cue) => this.behaviour.cue(cue, this.timer.getElapsed()));

    if (options.scope) {
      for (const name of Object.keys(TARGET_SELECTORS) as (keyof typeof TARGET_SELECTORS)[]) this.find(name);
    }
    this.entry = options.still || options.manual ? null : document.querySelector(ENTRY_SELECTOR);
    if (this.entry) {
      this.targets.set('entry', this.entry);
      for (const type of ENTRY_EVENTS) this.entry.addEventListener(type, this.onEntry);
    }
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.timer.connect(document);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
    this.fit();

    // Compile every program before the first visible frame, off the main thread where the driver allows, so
    // the robot arrives without the page stuttering.
    this.compiling = this.renderer.compileAsync(this.scene, this.camera).then(
      () => {
        this.compiling = null;
        if (this.disposed) return;
        this.compiled = true;
        if (options.manual) {
          options.onFirstFrame?.();
          return;
        }
        if (options.still || this.active) this.draw(performance.now());
        if (this.active && !options.still) this.loop();
      },
      // A context lost while compiling: the still robot is already on screen, so it simply stays.
      () => {
        this.compiling = null;
        if (!this.disposed) options.onLost?.();
      },
    );
  }

  /**
   * A manual scene: moves the robot on to `time` (seconds since its start), hearing each cue at its own moment on
   * the way, and draws it there. Time only moves forward — `reset` starts again from 0 — and `cues` are the ones
   * heard in this stretch, in order. `focus` is what the visitor is on throughout it.
   */
  advance(time: number, cues: readonly TimedCue[] = [], focus: RobotFocus = 'none'): void {
    if (!this.options.manual) throw new Error('advance() drives a manual scene; a live one keeps its own time');
    this.canvasRect = null;
    let at = this.clock;
    let next = 0;
    const hear = (until: number) => {
      for (; next < cues.length && cues[next]!.at <= until; next++) this.behaviour.cue(cues[next]!.cue, cues[next]!.at);
    };
    hear(at);
    while (at < time - 1e-9) {
      const dt = Math.min(MANUAL_STEP, time - at);
      at += dt;
      hear(at);
      this.reached = this.behaviour.update({ time: at, dt, focus, angles: (target) => this.anglesTo(target) });
    }
    hear(time);
    this.clock = Math.max(this.clock, time);
    this.render(this.reached);
  }

  /** A manual scene goes back to its first moment, exactly as it was created. */
  reset(): void {
    this.behaviour = this.newBehaviour();
    this.clock = 0;
    this.reached = REST_POSE;
  }

  /**
   * Where the robot's own square shot lies in the canvas, for a canvas larger than the shot that a camera moves
   * across (the film). The robot is drawn exactly as its stage would draw it at that size and place, cropped to the
   * canvas, so a close-up is rendered at full resolution rather than enlarged. Null restores the stage's framing.
   */
  place(box: ShotBox | null): void {
    this.box = box;
    this.canvasRect = null;
    this.applyFraming();
  }

  /** Where the chest mark's arcs are drawn now: their centre, and the radius of their centre line, in CSS pixels of the canvas. */
  markOnScreen(): { x: number; y: number; r: number } {
    const { clientWidth: w, clientHeight: h } = this.options.canvas;
    this.figure.root.updateWorldMatrix(true, true);
    this.camera.updateMatrixWorld();
    // The arcs are inlaid in the top of the domed disc, a little proud of its rim.
    const at = (x: number) => {
      const p = this.figure.mark.localToWorld(new Vector3(x, 0.02, 0)).project(this.camera);
      return { x: ((p.x + 1) / 2) * w, y: ((1 - p.y) / 2) * h };
    };
    const centre = at(0);
    const edge = at(MARK_ARC_RADIUS);
    return { ...centre, r: Math.hypot(edge.x - centre.x, edge.y - centre.y) };
  }

  /**
   * The film's light on the set. `evening` (0 to 1) lowers the key and warms it, as a day's light goes; `spill`
   * (0 to 1) is the warm light of the product's own orange falling on the robot from the page beside it.
   */
  light({ evening = 0, spill = 0 }: { evening?: number; spill?: number }): void {
    const { key } = this.lighting;
    key.position.lerpVectors(this.day.position, EVENING_KEY.position, evening);
    key.color.lerpColors(this.day.color, EVENING_KEY.color, evening);
    key.intensity = this.day.intensity + (EVENING_KEY.intensity - this.day.intensity) * evening;
    if (spill > 0 && !this.spill) {
      // A wash rather than a lamp: a hemisphere of the brand's orange on the page's side and nothing on the other,
      // so the shell warms where it faces the page without a single sharp highlight of its own.
      this.spill = new HemisphereLight(COLOR['brand-primary'], 0x000000, 0);
      // From the page, which stands on the visitor's right of the robot (its left, unless mirrored).
      this.spill.position.set(this.options.mirror ? -1 : 1, 0.1, 0.5);
      this.scene.add(this.spill);
    }
    if (this.spill) this.spill.intensity = 0.7 * spill;
  }

  /** Off screen, nothing is drawn and nothing is spent. */
  setActive(active: boolean): void {
    this.active = active;
    if (!this.compiled || this.options.still || this.options.manual) return;
    if (active && this.raf === 0) this.loop();
    if (!active && this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resize.disconnect();
    this.unsubscribe();
    if (this.entry) {
      for (const type of ENTRY_EVENTS) this.entry.removeEventListener(type, this.onEntry);
      robotCues.setEntry(false);
    }
    this.options.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.timer.dispose();
    // Programs still compiling belong to the driver until it answers; release them once it has.
    const release = () => {
      this.figure.dispose();
      this.lighting.dispose();
      this.renderer.dispose();
    };
    if (this.compiling) void this.compiling.then(release, release);
    else release();
  }

  /** Pointer and keyboard count the same; the robot looks while either is on the entry. */
  private onEntry = (e: Event) => {
    const on = e.type === 'pointerenter' || e.type === 'focus';
    if (e.type === 'focus' || e.type === 'blur') this.entryHeld.focus = on;
    else this.entryHeld.pointer = on;
    robotCues.setEntry(this.entryHeld.pointer || this.entryHeld.focus);
  };

  private loop = () => {
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      if (!this.active || this.disposed) return;
      this.draw(now);
      this.loop();
    });
  };

  private newBehaviour(): RobotBehaviour {
    const { direction, mood, mirror, manual, seed } = this.options;
    return new RobotBehaviour({
      direction,
      ...(mood ? { mood } : {}),
      ...(mirror ? { mirror: true } : {}),
      // Coming online is marked with a greeting; a film starts where its first shot does.
      ...(manual ? { random: seeded(seed ?? 1) } : { wakeAt: 0.9 }),
    });
  }

  private render(pose: Pose): void {
    this.figure.apply(pose);
    this.renderer.render(this.scene, this.camera);
  }

  private draw(now: number): void {
    this.timer.update(now);
    this.canvasRect = null;
    this.render(this.options.still ? (this.options.pose ?? REST_POSE) : this.pose());
    // A live robot is revealed once its motion has started (two frames); a still one as soon as it exists.
    const reveal = this.options.still ? 1 : 2;
    if (this.frame < reveal && ++this.frame === reveal) this.options.onFirstFrame?.();
  }

  private pose(): Pose {
    return this.behaviour.update({
      time: this.timer.getElapsed(),
      dt: this.timer.getDelta(),
      focus: robotCues.focus(),
      angles: (target) => this.anglesTo(target),
    });
  }

  private anglesTo(target: LookTarget): LookAngles | null {
    if (target === 'viewer') return this.anglesFrom(this.hit.copy(this.camera.position));
    let el = this.targets.get(target);
    // An element the page has since replaced, or moved the target away from (the newest payment is a new row), is
    // looked for again; one that is gone stays gone for a moment.
    if (target !== 'entry' && (!el || !el.isConnected || !el.matches(TARGET_SELECTORS[target]))) el = this.find(target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return this.anglesAt(r.left + r.width / 2, r.top + r.height / 2);
  }

  /** The element a target names, from the scope, unless it was looked for and missing a moment ago. */
  private find(target: keyof typeof TARGET_SELECTORS): Element | undefined {
    const scope = this.options.scope;
    this.targets.delete(target);
    if (!scope) return undefined;
    const now = performance.now();
    if ((this.missingUntil.get(target) ?? 0) > now) return undefined;
    const el = scope.querySelector(TARGET_SELECTORS[target]);
    if (el) {
      this.targets.set(target, el);
      this.missingUntil.delete(target);
      return el;
    }
    this.missingUntil.set(target, now + TARGET_RECHECK_MS);
    return undefined;
  }

  /** The look towards a point on screen: a ray through that pixel, met on the plane in front of the robot. */
  private anglesAt(x: number, y: number): LookAngles {
    const c = (this.canvasRect ??= this.options.canvas.getBoundingClientRect());
    this.ndc.set(((x - c.left) / c.width) * 2 - 1, -(((y - c.top) / c.height) * 2 - 1));
    this.ray.setFromCamera(this.ndc, this.camera);
    const { origin, direction } = this.ray.ray;
    return this.anglesFrom(this.hit.copy(origin).addScaledVector(direction, (TARGET_PLANE_Z - origin.z) / direction.z));
  }

  private anglesFrom(point: Vector3): LookAngles {
    const d = point.sub(HEAD);
    return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.options.canvas;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.applyFraming();
    if (this.compiled && !this.options.manual && (this.options.still || !this.active)) this.draw(performance.now());
  }

  /** The stage's own framing, or the shot placed in a larger canvas (`place`). */
  private applyFraming(): void {
    const { clientWidth: w, clientHeight: h } = this.options.canvas;
    if (this.box) {
      // The shot's square view, of which the canvas shows the part it covers: a view offset, in CSS pixels.
      this.camera.aspect = 1;
      this.camera.setViewOffset(this.box.size, this.box.size, -this.box.x, -this.box.y, w, h);
    } else {
      this.camera.clearViewOffset();
      if (w > 0 && h > 0) this.camera.aspect = w / h;
    }
    this.camera.updateProjectionMatrix();
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.setActive(false);
    this.options.onLost?.();
  };
}
