import type {
  DirectionalLight} from 'three';
import {
  BackSide,
  CanvasTexture,
  Color,
  Fog,
  type IUniform,
  Mesh,
  MeshBasicMaterial,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { type LookAngles, type LookTarget, type Pose, RobotBehaviour } from '../../src/app/(public)/_landing/robot/behaviour.ts';
import type { RobotCue, RobotFocus, RobotMood } from '../../src/app/(public)/_landing/robot/cues.ts';
import { HEAD_CENTRE, buildFigure } from '../../src/app/(public)/_landing/robot/figure.ts';
import { seeded } from '../../src/app/(public)/_landing/robot/motion.ts';
import { studio } from '../../src/app/(public)/_landing/robot/studio.ts';
import { type Lens, lens } from './post.ts';
import { beforeNeutral } from './tone.ts';

/**
 * HELD's world: the INRP2P robot — the site's own figure, materials, studio light and behaviour — hovering over an
 * endless ivory plain, and a camera free to go anywhere around it.
 *
 * The robot is the site's robot, whole for the first time: the same shapes, the same ceramic and glass, the same
 * rig and the same state machine, stepped on the film's clock. What the film adds is the place it stands in (a plain
 * of the brand's ivory that dissolves into haze, with the robot's shadow on it), a camera with a real lens, and the
 * few things only a film asks of the robot's body (eyes that open, arcs that charge, an antenna in the wind), laid
 * over the pose its behaviour produces.
 */

/** The plain lies this far below the head's centre: the robot hovers a little above it, perfectly still. */
export const FLOOR_Y = -3.05;

/** The set's colours, as the site draws them. The floor is a step deeper than the haze, so the horizon exists. */
const IVORY = '#F7F5F0';
const FLOOR = '#EDE9E1';
const HORIZON = '#FBF6EE';

/** The behaviour's longest step: however far apart two frames are, it moves in steps no longer than this. */
const STEP = 1 / 120;

export interface RobotDirection {
  /** Cues heard between the last frame and this one, each at its own time. */
  readonly cues: readonly { readonly at: number; readonly cue: RobotCue }[];
  /** Where each thing the robot may look at is, in the world; `viewer` is where it looks when it faces us. */
  readonly look: Partial<Record<LookTarget, Vector3>>;
  readonly focus?: RobotFocus;
  /** What the film asks of the body on top of the behaviour's pose at this moment. */
  readonly adjust?: (pose: Pose) => Pose;
  /** The antenna's sway in the wind, radians. */
  readonly antenna?: { readonly pitch: number; readonly roll: number };
}

export class World {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(30, 16 / 9, 0.05, 900);
  readonly figure = buildFigure();
  readonly lens: Lens;
  readonly key: DirectionalLight;
  readonly ivory = beforeNeutral(IVORY);
  private readonly floorMaterial: MeshBasicMaterial;
  private readonly sky: { uZenith: IUniform<Color>; uHorizon: IUniform<Color> };
  private behaviour: RobotBehaviour;
  private robotAt = 0;
  private pose: Pose | null = null;
  private readonly mood: RobotMood;

  constructor(canvas: HTMLCanvasElement, options: { mood?: RobotMood } = {}) {
    this.mood = options.mood ?? 'none';
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.camera.aspect = canvas.clientWidth / canvas.clientHeight;
    this.camera.updateProjectionMatrix();

    // The studio the robot is lit in on the site: its reflections, its key, its rim, its fill.
    const light = studio(this.renderer);
    this.scene.environment = light.environment;
    this.scene.environmentIntensity = 0.85;
    this.scene.add(...light.lights);
    this.key = light.key;
    // The key now has a whole figure and the plain under it to shadow, not a bust.
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 6;
    Object.assign(this.key.shadow.camera, { left: -4.5, right: 4.5, top: 4, bottom: -5, near: 1, far: 40 });
    this.key.shadow.camera.updateProjectionMatrix();

    this.scene.background = this.ivory.clone();
    this.scene.fog = new Fog(beforeNeutral(HORIZON), 26, 150);

    // The sky: the site's ivory overhead, warming a touch towards a horizon lost in haze.
    this.sky = { uZenith: { value: this.ivory.clone() }, uHorizon: { value: beforeNeutral(HORIZON) } };
    const sky = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      uniforms: this.sky,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          gl_FragColor = vec4(mix(uHorizon, uZenith, pow(h, 0.45)), 1.0);
        }
      `,
    });
    const dome = new Mesh(new SphereGeometry(800, 48, 24), sky);
    dome.frustumCulled = false;
    this.scene.add(dome);

    // The plain: unlit, so it is the brand's colour wherever the light falls, with the shadow laid over it.
    this.floorMaterial = new MeshBasicMaterial({ color: beforeNeutral(FLOOR) });
    const floor = new Mesh(new PlaneGeometry(2000, 2000), this.floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR_Y;
    const shadow = new Mesh(new PlaneGeometry(60, 60), new ShadowMaterial({ opacity: 0.2, color: new Color('#3a2a1c') }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = FLOOR_Y + 0.002;
    shadow.receiveShadow = true;
    // Under a hovering thing the ground darkens softly even where no light is blocked: a contact shade.
    const contact = new Mesh(new PlaneGeometry(4.2, 4.2), new MeshBasicMaterial({ map: contactShade(), transparent: true, depthWrite: false, color: new Color('#3a2a1c') }));
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = FLOOR_Y + 0.004;
    this.scene.add(floor, shadow, contact);

    this.scene.add(this.figure.root);
    this.figure.root.traverse((o) => {
      if ((o as Mesh).isMesh) (o as Mesh).castShadow = true;
    });

    this.behaviour = this.newBehaviour();
    this.lens = lens(this.renderer, this.scene, this.camera);
  }

  /** Compile every program before the first frame is asked for. */
  async ready(): Promise<void> {
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  /** Back to the robot's first moment (a frame asked for out of order). */
  reset(): void {
    this.behaviour = this.newBehaviour();
    this.robotAt = 0;
    this.pose = null;
  }

  get robotTime(): number {
    return this.robotAt;
  }

  /**
   * Moves the robot to `time` on its own clock, hearing its cues on the way, and applies the pose with whatever the
   * film adds to it. Time only moves forward; an earlier time starts again from the beginning.
   */
  moveRobot(time: number, direction: RobotDirection): void {
    if (time < this.robotAt - 1e-9) this.reset();
    const cues = [...direction.cues].sort((a, b) => a.at - b.at);
    let next = 0;
    const hear = (until: number) => {
      for (; next < cues.length && cues[next]!.at <= until; next++) {
        if (cues[next]!.at > this.robotAt - 1e-9) this.behaviour.cue(cues[next]!.cue, cues[next]!.at);
      }
    };
    const angles = (target: LookTarget): LookAngles | null => {
      const p = direction.look[target];
      if (!p) return null;
      const d = p.clone().sub(new Vector3(HEAD_CENTRE.x, HEAD_CENTRE.y, HEAD_CENTRE.z));
      return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
    };
    hear(this.robotAt);
    let at = this.robotAt;
    while (at < time - 1e-9) {
      const dt = Math.min(STEP, time - at);
      at += dt;
      hear(at);
      this.pose = this.behaviour.update({ time: at, dt, focus: direction.focus ?? 'none', angles });
    }
    this.robotAt = Math.max(this.robotAt, time);
    if (!this.pose) this.pose = this.behaviour.update({ time, dt: 0, focus: direction.focus ?? 'none', angles });
    this.figure.apply(direction.adjust ? direction.adjust(this.pose) : this.pose);
    const sway = direction.antenna ?? { pitch: 0, roll: 0 };
    this.figure.antenna.rotation.set(sway.pitch, 0, sway.roll);
  }

  /** The set's light as the day goes: 0 is the site's daylight; 1 is warm evening. */
  set evening(k: number) {
    const warm = beforeNeutral('#F6EBDD');
    const floorWarm = beforeNeutral('#EADFD0');
    this.sky.uZenith.value.copy(this.ivory).lerp(warm, k);
    this.floorMaterial.color.copy(beforeNeutral(FLOOR)).lerp(floorWarm, k);
    (this.scene.background as Color).copy(this.ivory).lerp(warm, k);
    (this.scene.fog as Fog).color.copy(beforeNeutral(HORIZON)).lerp(warm, k);
  }

  private newBehaviour(): RobotBehaviour {
    return new RobotBehaviour({ direction: 'SELL_USDT', mood: this.mood, random: seeded(20260929) });
  }
}

/** A soft round shade, dark at the centre and clear at the edge: the ground under something hovering close. */
function contactShade(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.34)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
