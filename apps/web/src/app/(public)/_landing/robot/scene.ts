import { NeutralToneMapping, PCFShadowMap, PerspectiveCamera, Raycaster, SRGBColorSpace, Scene, Timer, Vector2, Vector3, WebGLRenderer } from 'three';
import type { Direction } from '@inrp2p/kernel';
import { type LookAngles, type LookTarget, type Pose, type Presence, REST_POSE, RobotBehaviour } from './behaviour.ts';
import { type RobotCue, type RobotMood, robotCues } from './cues.ts';
import { robotPresence } from './presence.ts';
import { type Figure, HEAD_CENTRE, figureSteps } from './figure.ts';
import { FrameGovernor, displayPeriod } from './governor.ts';
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
const TARGET_SELECTORS: Record<Exclude<LookTarget, 'viewer' | 'entry' | 'pointer' | 'reading' | 'exit'>, string> = {
  title: '#hero-title',
  panel: '[data-robot-target="panel"]',
  amount: '[data-robot-target="amount"]',
  toggle: '[data-robot-target="toggle"]',
  rate: '[data-robot-target="rate"]',
  cta: '[data-robot-target="cta"]',
};

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

/** How long after the pointer last moved the robot still follows it, before it looks back at the visitor. */
const POINTER_HOLD_MS = 2200;

/**
 * The page has scrolled on past the robot once its head is this high in the window: from here, what the visitor reads
 * is below it, and the robot looks there — at this point of the window — rather than out at them.
 */
const BELOW_AT = 0.3;
const READING = { x: 0.5, y: 0.64 } as const;

/**
 * The live robot's start, behind the still one: it draws its rest pose until this many frames in a row come in time
 * (the first frames pay for the GPU's uploads, and a robot shown then would stutter into life), or until `maxMs` has
 * passed, when the frame governor decides instead. Then it takes over, and comes online `wakeAfter` seconds later.
 */
const WARM = { frames: 8, maxMs: 3000, wakeAfter: 0.6 } as const;

/** What a tap or click on the robot never counts as: a press on anything that does something. */
const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [contenteditable="true"], [tabindex]:not([tabindex^="-"])';

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
  /** After the first frames are drawn — called in the same task, so the drawing buffer can still be read. */
  readonly onFirstFrame?: () => void;
  /** The GPU took the context away, or cannot draw the robot in time (`governor.ts`); the caller shows the still robot again. */
  readonly onLost?: () => void;
}

/**
 * The robot is assembled in steps, each its own task, so the page can answer a tap between them: a phone used to spend
 * a third of a second in one task here, at about the moment people start to touch the page. `scheduler.yield` keeps the
 * robot's place in line where the browser has it.
 */
function nextTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Three asks the driver for every program's logs when it first uses it — three synchronous calls into the GPU process
 * per program. A production build has no use for the logs: its shaders are the ones development, the poster and the
 * robot's sheet already compiled.
 */
const CHECK_SHADER_ERRORS = !(typeof process !== 'undefined' && process.env.NODE_ENV === 'production');

export class RobotScene {
  private readonly options: RobotSceneOptions;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 40);
  private readonly timer = new Timer();
  private readonly behaviour: RobotBehaviour;
  /** Made by `start`, in turn; until then there is nothing to draw with. */
  private renderer: WebGLRenderer | null = null;
  private figure: Figure | null = null;
  private lighting: ReturnType<typeof studio> | null = null;
  private resize: ResizeObserver | null = null;
  private governor: FrameGovernor | null = null;
  private lastFrame = 0;
  /** Whether the live robot has taken over from the still one; until then it warms up unseen (`WARM`). */
  private revealed = false;
  private readonly warm = { since: 0, last: 0, smooth: 0 };
  /** A frame later than this is not in time (ms): half as long again as the display's own. */
  private smoothLimit = 1000 / 40;
  private readonly targets = new Map<LookTarget, Element>();
  /** When each target missing from the page may next be looked for. */
  private readonly missingUntil = new Map<LookTarget, number>();
  private readonly entry: Element | null;
  private readonly entryHeld = { pointer: false, focus: false };
  /** Where a mouse last was on screen, and when it got there; `out` once it has left the window. */
  private readonly pointer = { x: 0, y: 0, at: Number.NEGATIVE_INFINITY, out: false };
  /** Since when the mouse has rested on the robot's head, while it does. */
  private overSince = Number.POSITIVE_INFINITY;
  private readonly head = new Vector3();
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
    this.camera.position.copy(CAMERA_POSITION);
    this.camera.lookAt(CAMERA_TARGET);

    this.behaviour = new RobotBehaviour({
      direction: options.direction,
      ...(options.mood ? { mood: options.mood } : {}),
      ...(options.mirror ? { mirror: true } : {}),
    });
    this.unsubscribe = options.still ? () => {} : robotCues.subscribe((cue) => this.hear(cue));

    if (options.scope) {
      for (const name of Object.keys(TARGET_SELECTORS) as (keyof typeof TARGET_SELECTORS)[]) this.find(name);
    }
    this.entry = options.still ? null : document.querySelector(ENTRY_SELECTOR);
    if (this.entry) {
      this.targets.set('entry', this.entry);
      for (const type of ENTRY_EVENTS) this.entry.addEventListener(type, this.onEntry);
    }
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    if (!options.still) {
      window.addEventListener('pointermove', this.onPointer, { passive: true });
      window.addEventListener('pointerdown', this.onPress, { passive: true });
      document.addEventListener('mouseout', this.onLeave, { passive: true });
    }

    this.timer.connect(document);
    void this.start();
  }

  /**
   * The robot, assembled a step per task: how fast this display draws (before anything of ours does), the figure's
   * geometry, then the renderer and the studio's reflections, then every program — compiled before the first visible
   * frame, off the main thread where the driver allows. A dispose between two steps stops it there.
   */
  private async start(): Promise<void> {
    const { canvas, still } = this.options;
    const period = still ? 0 : await displayPeriod();
    if (this.disposed) return;

    // The figure's geometry, a part per task.
    const steps = figureSteps();
    let step = steps.next();
    while (!step.done) {
      await nextTask();
      if (this.disposed) return;
      step = steps.next();
    }
    const figure = step.value;
    this.figure = figure;
    await nextTask();
    if (this.disposed) return this.release();

    const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer = renderer;
    renderer.debug.checkShaderErrors = CHECK_SHADER_ERRORS;
    const ratio = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(ratio);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    // Khronos PBR Neutral keeps the brand orange the orange it was specified as.
    renderer.toneMapping = NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;

    this.lighting = studio(renderer);
    this.scene.environment = this.lighting.environment;
    this.scene.environmentIntensity = 0.85;
    this.scene.add(...this.lighting.lights, figure.root);
    if (!still) {
      this.governor = new FrameGovernor({ period, ratio });
      this.smoothLimit = Math.max(period, 1000 / 120) * 1.5;
    }

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
    this.fit();
    await nextTask();
    if (this.disposed) return this.release();

    this.compiling = renderer.compileAsync(this.scene, this.camera).then(
      () => {
        this.compiling = null;
        if (this.disposed) return this.release();
        this.compiled = true;
        if (still || this.active) this.draw(performance.now());
        if (this.active && !still) this.loop();
      },
      // A context lost while compiling: the still robot is already on screen, so it simply stays.
      () => {
        this.compiling = null;
        if (this.disposed) return this.release();
        this.options.onLost?.();
      },
    );
  }

  /** Whatever `start` had made by now, given back — once nothing is still using it. Safe to call twice. */
  private release(): void {
    this.figure?.dispose();
    this.lighting?.dispose();
    this.renderer?.dispose();
    this.figure = null;
    this.lighting = null;
    this.renderer = null;
  }

  /** Off screen, nothing is drawn and nothing is spent. */
  setActive(active: boolean): void {
    this.active = active;
    if (!this.compiled || this.options.still) return;
    if (active && this.raf === 0) this.loop();
    if (!active && this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.lastFrame = 0;
      this.warm.last = 0;
      this.governor?.pause();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf !== 0) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resize?.disconnect();
    this.unsubscribe();
    if (this.entry) {
      for (const type of ENTRY_EVENTS) this.entry.removeEventListener(type, this.onEntry);
      robotCues.setEntry(false);
    }
    this.options.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    window.removeEventListener('pointermove', this.onPointer);
    window.removeEventListener('pointerdown', this.onPress);
    document.removeEventListener('mouseout', this.onLeave);
    this.timer.dispose();
    // Programs still compiling belong to the driver until it answers: the compile's own callback releases them. A
    // step of `start` still waiting for its task does the same when it wakes.
    if (!this.compiling && (this.compiled || this.renderer === null)) this.release();
  }

  /** Pointer and keyboard count the same; the robot looks while either is on the entry. */
  private onEntry = (e: Event) => {
    const on = e.type === 'pointerenter' || e.type === 'focus';
    if (e.type === 'focus' || e.type === 'blur') this.entryHeld.focus = on;
    else this.entryHeld.pointer = on;
    robotCues.setEntry(this.entryHeld.pointer || this.entryHeld.focus);
  };

  /**
   * A cue, heard at the moment it happens. The clock is brought up to now first: a robot that has been off screen has
   * not been ticking, and a cue stamped with the last frame's time would already be over when the next frame comes.
   */
  private hear(cue: RobotCue): void {
    this.timer.update(performance.now());
    this.behaviour.cue(cue, this.timer.getElapsed());
  }

  /** A mouse moving anywhere on the page draws the resting robot's eyes; a finger on a phone does not. */
  private onPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    this.pointer.x = e.clientX;
    this.pointer.y = e.clientY;
    this.pointer.at = performance.now();
    this.pointer.out = false;
  };

  private onLeave = (e: MouseEvent) => {
    if (e.relatedTarget === null) this.pointer.out = true;
  };

  /**
   * A tap or click on the robot itself — its head or its chest — is a poke. Read from the window, passively: the
   * robot's stage takes no pointer events, so the tap still goes wherever it was going, and a press on anything that
   * does something is never a poke.
   */
  private onPress = (e: PointerEvent) => {
    if (!e.isPrimary || e.button !== 0 || !this.active || !this.compiled || !robotPresence.on()) return;
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
    const head = this.headOnScreen();
    if (!head) return;
    const dx = (e.clientX - head.x) / head.r;
    const dy = (e.clientY - head.y) / head.r;
    const onHead = dx * dx + (dy / 0.85) ** 2 <= 1.1;
    const onChest = Math.abs(dx) <= 0.8 && dy > 0 && dy <= 2.2;
    if (onHead || onChest) this.hear({ kind: 'poke' });
  };

  /** The robot's head on screen at rest: its centre and its half width, in CSS pixels. */
  private headOnScreen(): { x: number; y: number; r: number } | null {
    const c = (this.canvasRect ??= this.options.canvas.getBoundingClientRect());
    if (c.width === 0 || c.height === 0) return null;
    this.head.copy(HEAD).project(this.camera);
    const x = c.left + ((this.head.x + 1) / 2) * c.width;
    const y = c.top + ((1 - this.head.y) / 2) * c.height;
    this.head.set(HEAD.x + 0.8, HEAD.y, HEAD.z).project(this.camera);
    const r = Math.abs(c.left + ((this.head.x + 1) / 2) * c.width - x);
    return { x, y, r };
  }

  /** The visitor on the page as a whole (`presence.ts`), with what only the robot can tell: where it is on screen. */
  private presence(): Presence | undefined {
    // Only where the page is watched for the robot (the home page's stage); the workspace's robot keeps to its moods.
    if (!robotPresence.on()) return undefined;
    const now = performance.now();
    const head = this.headOnScreen();
    const below = head !== null && head.y < window.innerHeight * BELOW_AT;
    let over = false;
    if (head && !this.pointer.out && Number.isFinite(this.pointer.at)) {
      const dx = (this.pointer.x - head.x) / head.r;
      const dy = (this.pointer.y - head.y) / (head.r * 0.85);
      over = dx * dx + dy * dy <= 1;
    }
    if (!over) this.overSince = Number.POSITIVE_INFINITY;
    else if (!Number.isFinite(this.overSince)) this.overSince = now;
    return {
      quiet: robotPresence.quiet(now),
      scrolling: robotPresence.scrolling(now),
      below,
      over: over ? (now - this.overSince) / 1000 : 0,
      leaving: robotPresence.leaving(),
    };
  }

  private loop = () => {
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      if (!this.active || this.disposed) return;
      if (!this.revealed) {
        this.draw(now);
        this.warmUp(now);
        this.loop();
        return;
      }
      if (!this.govern(now)) return;
      this.draw(now);
      this.loop();
    });
  };

  /**
   * Warming up (`WARM`): counts the frames that come in time, and once enough have in a row — or once it has waited
   * long enough — takes over from the still robot and comes online, so the whole arrival is seen, and seen smooth.
   */
  private warmUp(now: number): void {
    const w = this.warm;
    const interval = w.last ? now - w.last : 0;
    w.last = now;
    if (w.since === 0) w.since = now;
    w.smooth = interval > 0 && interval <= this.smoothLimit ? w.smooth + 1 : 0;
    if (w.smooth < WARM.frames && now - w.since < WARM.maxMs) return;
    this.revealed = true;
    this.lastFrame = 0;
    this.timer.update(now);
    this.behaviour.wakeUp(this.timer.getElapsed() + WARM.wakeAfter);
    this.options.onFirstFrame?.();
  }

  /** The frame budget (`governor.ts`): false when the robot hands back to the still one. */
  private govern(now: number): boolean {
    const interval = this.lastFrame ? now - this.lastFrame : 0;
    this.lastFrame = now;
    const verdict = this.governor?.frame(interval);
    if (verdict?.kind === 'ratio' && this.renderer) {
      this.renderer.setPixelRatio(verdict.ratio);
      this.fit();
    }
    if (verdict?.kind !== 'still') return true;
    this.setActive(false);
    this.options.onLost?.();
    return false;
  }

  private draw(now: number): void {
    const { renderer, figure } = this;
    if (!renderer || !figure) return;
    this.canvasRect = null;
    if (this.options.still) {
      // A still robot is shown as soon as it exists.
      figure.apply(this.options.pose ?? REST_POSE);
      renderer.render(this.scene, this.camera);
      if (this.frame === 0 && ++this.frame === 1) this.options.onFirstFrame?.();
      return;
    }
    // A live robot still warming up draws the still one's own pose, its clock not yet started: nothing moves unseen.
    if (!this.revealed) {
      figure.apply(REST_POSE);
      renderer.render(this.scene, this.camera);
      return;
    }
    this.timer.update(now);
    figure.apply(this.pose());
    renderer.render(this.scene, this.camera);
  }

  private pose(): Pose {
    const presence = this.presence();
    return this.behaviour.update({
      time: this.timer.getElapsed(),
      dt: this.timer.getDelta(),
      focus: robotCues.focus(),
      angles: (target) => this.anglesTo(target),
      pointer: performance.now() - this.pointer.at < POINTER_HOLD_MS,
      ...(presence ? { presence } : {}),
    });
  }

  private anglesTo(target: LookTarget): LookAngles | null {
    if (target === 'viewer') return this.anglesFrom(this.hit.copy(this.camera.position));
    if (target === 'pointer') return Number.isFinite(this.pointer.at) ? this.anglesAt(this.pointer.x, this.pointer.y) : null;
    if (target === 'reading') return this.anglesAt(window.innerWidth * READING.x, window.innerHeight * READING.y);
    if (target === 'exit') return Number.isFinite(this.pointer.at) ? this.anglesAt(this.pointer.x, -window.innerHeight * 0.15) : null;
    let el = this.targets.get(target);
    // An element the page has since replaced is looked for again; one that is gone stays gone for a moment.
    if ((!el || !el.isConnected) && target !== 'entry') el = this.find(target);
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
    if (w === 0 || h === 0 || !this.renderer) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.compiled && (this.options.still || !this.active)) this.draw(performance.now());
  }

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.setActive(false);
    this.options.onLost?.();
  };
}
