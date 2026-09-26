import { NeutralToneMapping, PCFShadowMap, PerspectiveCamera, Raycaster, SRGBColorSpace, Scene, Timer, Vector2, Vector3, WebGLRenderer } from 'three';
import type { Direction } from '@inrp2p/kernel';
import { type LookAngles, type LookTarget, type Pose, REST_POSE, RobotBehaviour } from './behaviour.ts';
import { robotCues } from './cues.ts';
import { HEAD_CENTRE, buildFigure } from './figure.ts';
import { studio } from './studio.ts';

/**
 * The robot's scene: renderer, camera, studio and figure, and the loop that runs them.
 *
 * Plain three.js rather than a React renderer: one figure in one fixed shot does not need a reconciler, and the
 * page stays free of a dependency that has to be re-released for every React minor version.
 *
 * The camera is fixed and long (22° vertical), like a product photograph: little perspective distortion, so
 * the shell's curves read as designed rather than as a wide-angle bulge. Framing is set vertically, so every
 * stage size shows the same crop — the still image and the live figure line up exactly.
 */

const CAMERA_POSITION = new Vector3(0, -0.45, 8.4);
const CAMERA_TARGET = new Vector3(0, -0.91, 0);
const CAMERA_FOV = 22;
/** Page elements are placed on this plane in front of the robot, so a look at one lands where it is drawn. */
const TARGET_PLANE_Z = 2.4;
const HEAD = new Vector3(HEAD_CENTRE.x, HEAD_CENTRE.y, HEAD_CENTRE.z);

/**
 * Where each look target lives on the page. `rate` is marked only by UI that shows a firm rate; without it,
 * attention falls back to the module (`states.ts`).
 */
const TARGET_SELECTORS: Record<Exclude<LookTarget, 'viewer'>, string> = {
  panel: '[data-robot-target="panel"]',
  amount: '[data-robot-target="amount"]',
  toggle: '[data-robot-target="toggle"]',
  rate: '[data-robot-target="rate"]',
  cta: '[data-robot-target="cta"]',
};

export interface RobotSceneOptions {
  readonly canvas: HTMLCanvasElement;
  /** The element the robot's look targets live in (the hero). */
  readonly scope: HTMLElement | null;
  readonly direction: Direction;
  /** Hold the rest pose and draw only when the size changes. */
  readonly still: boolean;
  /** After the first frames are drawn — called in the same task, so the drawing buffer can still be read. */
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
  private readonly behaviour: RobotBehaviour;
  private readonly targets = new Map<LookTarget, Element>();
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

    this.behaviour = new RobotBehaviour({ direction: options.direction, wakeAt: 0.9 });
    this.unsubscribe = options.still ? () => {} : robotCues.subscribe((cue) => this.behaviour.cue(cue, this.timer.getElapsed()));

    if (options.scope) {
      for (const [name, selector] of Object.entries(TARGET_SELECTORS)) {
        const el = options.scope.querySelector(selector);
        if (el) this.targets.set(name as LookTarget, el);
      }
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

  /** Off screen, nothing is drawn and nothing is spent. */
  setActive(active: boolean): void {
    this.active = active;
    if (!this.compiled || this.options.still) return;
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

  private loop = () => {
    this.raf = requestAnimationFrame((now) => {
      this.raf = 0;
      if (!this.active || this.disposed) return;
      this.draw(now);
      this.loop();
    });
  };

  private draw(now: number): void {
    this.timer.update(now);
    this.canvasRect = null;
    this.figure.apply(this.options.still ? REST_POSE : this.pose());
    this.renderer.render(this.scene, this.camera);
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
    const el = this.targets.get(target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return this.anglesAt(r.left + r.width / 2, r.top + r.height / 2);
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
