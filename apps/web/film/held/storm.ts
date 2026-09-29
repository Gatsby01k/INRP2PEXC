import {
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  PlaneGeometry,
  type PerspectiveCamera,
  Quaternion,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { seeded } from '../../src/app/(public)/_landing/robot/motion.ts';
import { FLOOR_Y } from './world.ts';

/**
 * The market, as weather: a storm of the things traders read all day — the chat that moves the price, and the
 * prices themselves, changing — turning around the robot.
 *
 * Every word is set in the brand's own typeface (Geist) into one atlas and drawn as a flat card in the air. Its path
 * is a closed-form function of time — an orbit that is faster the closer it runs, a slow rise and fall, a tumble —
 * so any moment of the storm can be drawn exactly, in any order, and the film's motion blur samples real motion.
 *
 * The storm keeps its own clock per word. When the robot locks the price, a wave runs out from the ring, and each
 * word stops dead the moment the wave reaches it. When the market resumes, every word picks up where it stopped —
 * but the air inside the ring stays clear: words flow around it the way water goes round a stone. At the end the
 * words lie on the plain where they fell.
 */

/** What the storm is made of: the chat that moves a price, in the words traders actually use. */
const CHAT = [
  'rate changed',
  'bhai 5 min',
  'send first',
  'new rate?',
  'payment pending',
  'screenshot bhejo',
  'rate update ho gaya',
  'wait',
  'rate?',
  'price moved',
  'confirm?',
  'sent?',
  'bhai?',
  'final rate?',
  'ok wait',
  'UTR?',
  'call me',
  'kitna?',
  'recheck',
  'rate gone',
  'still pending',
  'check again',
  'abhi nahi',
  'market down',
  'market up',
  'refresh',
  'slippage',
  'partial fill',
  'min 10 min',
  'screenshot?',
  'rate valid?',
  'aur kitna',
  '???',
  '!!',
  'cancel?',
  'repeat',
] as const;

/** And the prices, which never sit still. Each card with a price shows a different one every few frames. */
const PRICES = ['101.84', '102.37', '101.20', '99.95', '102.91', '100.64', '103.10', '101.07', '98.72', '102.05', '100.18', '103.46', '101.53', '99.40', '102.68', '100.93'] as const;

const COUNT = 1500;
const ATLAS = { width: 4096, height: 2048, font: 104, pad: 26 } as const;

/** How the storm is at a moment: its clock, and what it is doing. */
export interface StormFrame {
  /** Film seconds. */
  readonly t: number;
  /** 0 before the storm has risen, 1 at full force. */
  readonly force: number;
  /** The lock: when and where the freezing wave starts, and how fast it runs (units per second). */
  readonly freeze: { readonly at: number; readonly origin: Vector3; readonly speed: number } | null;
  /** When the market resumes after the freeze. */
  readonly resume: number | null;
  /** The ring whose air stays clear once the market has resumed. */
  readonly ring: { readonly centre: Vector3; readonly normal: Vector3; readonly radius: number } | null;
  /** 1 once every word lies on the plain. */
  readonly fallen: number;
  /** The window round the price that no word may cross in front of (what lies behind it is dimmed), or null. */
  readonly clear: { readonly centre: Vector3; readonly radius: number } | null;
  /** Where the lens is focused, and how deep its field is (units). */
  readonly focus: { readonly distance: number; readonly depth: number };
}

interface Card {
  readonly entry: number;
  readonly price: boolean;
  readonly radius: number;
  readonly height: number;
  readonly angle: number;
  readonly speed: number;
  readonly bob: number;
  readonly bobRate: number;
  readonly phase: number;
  readonly axis: Vector3;
  readonly spin: number;
  readonly size: number;
  readonly face: boolean;
  readonly shade: number;
  /** Where it lies once fallen. */
  readonly rest: { readonly x: number; readonly z: number; readonly yaw: number };
}

interface Entry {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  /** Width over height. */
  readonly aspect: number;
}

export class Storm {
  readonly mesh: InstancedMesh;
  private readonly cards: Card[] = [];
  private readonly entries: Entry[] = [];
  private readonly priceEntries: number[] = [];
  private readonly uv: InstancedBufferAttribute;
  private readonly alpha: InstancedBufferAttribute;
  private readonly blur: InstancedBufferAttribute;
  private readonly shade: InstancedBufferAttribute;
  private readonly order: number[] = [];
  private readonly depth: number[] = [];
  private readonly positions: Vector3[] = [];
  private readonly rotations: Quaternion[] = [];
  private readonly scales: Vector3[] = [];
  private readonly visible: number[] = [];

  constructor() {
    const atlas = this.buildAtlas();
    const geometry = new PlaneGeometry(1, 1);
    this.uv = new InstancedBufferAttribute(new Float32Array(COUNT * 4), 4).setUsage(DynamicDrawUsage);
    this.alpha = new InstancedBufferAttribute(new Float32Array(COUNT), 1).setUsage(DynamicDrawUsage);
    this.blur = new InstancedBufferAttribute(new Float32Array(COUNT), 1).setUsage(DynamicDrawUsage);
    this.shade = new InstancedBufferAttribute(new Float32Array(COUNT), 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('aUv', this.uv);
    geometry.setAttribute('aAlpha', this.alpha);
    geometry.setAttribute('aBlur', this.blur);
    geometry.setAttribute('aShade', this.shade);
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uAtlas: { value: atlas }, uInk: { value: new Color('#121317') }, uSoft: { value: new Color('#54575f') } }]),
      vertexShader: /* glsl */ `
        attribute vec4 aUv;
        attribute float aAlpha;
        attribute float aBlur;
        attribute float aShade;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vBlur;
        varying float vShade;
        #include <fog_pars_vertex>
        void main() {
          vUv = mix(aUv.xy, aUv.zw, uv);
          vAlpha = aAlpha;
          vBlur = aBlur;
          vShade = aShade;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        uniform vec3 uInk;
        uniform vec3 uSoft;
        varying vec2 vUv;
        varying float vAlpha;
        varying float vBlur;
        varying float vShade;
        #include <fog_pars_fragment>
        void main() {
          // Out of focus, the glyphs are read from a smaller copy of the atlas: soft, never blocky, never sharp.
          float a = texture(uAtlas, vUv, vBlur).a * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(mix(uInk, uSoft, vShade), a);
          #include <fog_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    this.mesh = new InstancedMesh(geometry, material, COUNT);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.buildCards();
    for (let i = 0; i < COUNT; i++) {
      this.positions.push(new Vector3());
      this.rotations.push(new Quaternion());
      this.scales.push(new Vector3());
      this.order.push(i);
      this.depth.push(0);
      this.visible.push(0);
    }
  }

  /** Sets every card for a moment of the storm, as seen from `camera`, back to front. */
  update(frame: StormFrame, camera: PerspectiveCamera): void {
    const { t } = frame;
    const view = camera.matrixWorldInverse;
    const camPos = camera.position;
    const temp = new Vector3();
    // The window, as the lens sees it: a centre and radius in view space, per unit of depth.
    const win = frame.clear ? frame.clear.centre.clone().applyMatrix4(view) : null;
    const window = win && win.z < 0 ? { x: win.x / -win.z, y: win.y / -win.z, r: frame.clear!.radius / -win.z, depth: -win.z } : null;
    for (let i = 0; i < COUNT; i++) {
      const c = this.cards[i]!;
      const clock = this.clock(c, frame);
      const p = this.positions[i]!;
      const q = this.rotations[i]!;
      this.place(c, clock, p, q);
      if (frame.ring && frame.resume !== null && t > frame.resume) this.flowAround(p, frame.ring, t - frame.resume);
      if (frame.fallen > 0) this.fall(c, p, q, frame.fallen, camPos);
      const e = this.entries[this.entryAt(c, clock)]!;
      const h = c.size;
      this.scales[i]!.set(h * e.aspect, h, 1);
      temp.copy(p).applyMatrix4(view);
      this.depth[i] = temp.z;
      // Force brings the storm in from nothing: the far words first, the near ones last.
      const inner = 1 - Math.min(1, Math.max(0, (c.radius - 3) / 40));
      const grow = Math.min(1, Math.max(0, (frame.force - inner * 0.4) / 0.6));
      const distance = -temp.z;
      const defocus = Math.abs(distance - frame.focus.distance) / frame.focus.depth;
      const blur = Math.min(5.5, defocus * 2.2);
      // Out of focus, a word's ink spreads thin, as a lens spreads light: it veils less, not more.
      let seen = (frame.fallen > 0 ? 0.4 : grow) / (1 + 0.18 * blur);
      if (window && distance > 0) {
        const off = Math.hypot(temp.x / distance - window.x, temp.y / distance - window.y);
        const overlap = window.r * 1.08 + (h * e.aspect * 0.5) / distance - off;
        const inside = Math.min(1, Math.max(0, overlap / (window.r * 0.35)));
        // In front of the price: gone. Behind it: dimmed, so the figure is always what is read.
        seen *= 1 - inside * (distance < window.depth + 0.4 ? 1 : 0.7);
      }
      this.visible[i] = seen;
      this.blur.setX(i, blur);
      this.shade.setX(i, c.shade);
      this.uv.setXYZW(i, e.u0, e.v0, e.u1, e.v1);
    }
    // Drawn back to front, so every card blends over the ones behind it.
    this.order.sort((a, b) => this.depth[a]! - this.depth[b]!);
    const m = new Matrix4();
    for (let k = 0; k < COUNT; k++) {
      const i = this.order[k]!;
      const v = this.visible[i]!;
      const s = this.scales[i]!;
      m.compose(this.positions[i]!, this.rotations[i]!, v > 0 ? s : s.clone().setScalar(0));
      this.mesh.setMatrixAt(k, m);
      // Attributes follow the drawing order, not the card's number.
      this.reorder(k, i, v);
    }
    this.commitReorder();
    this.mesh.instanceMatrix.needsUpdate = true;
    this.uv.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.blur.needsUpdate = true;
    this.shade.needsUpdate = true;
  }

  // ——— the motion ———————————————————————————————————————————————————————————————————————————

  /** A card's own clock: film time until the wave stops it, and from where it stopped once the market resumes. */
  private clock(c: Card, f: StormFrame): number {
    if (!f.freeze || f.t < f.freeze.at) return f.t;
    const at = this.place(c, f.freeze.at, new Vector3(), new Quaternion());
    const reach = f.freeze.at + at.distanceTo(f.freeze.origin) / f.freeze.speed;
    if (f.t < reach) return f.t;
    if (f.resume === null || f.t < f.resume) return reach;
    // Picking up speed again over half a second, as a stopped tape does.
    const since = f.t - f.resume;
    const ease = since < 0.5 ? (since * since) / 1.0 : since - 0.25;
    return reach + ease;
  }

  /** Where a card is, and how it is turned, at its clock `s`. Returns the position for convenience. */
  private place(c: Card, s: number, p: Vector3, q: Quaternion): Vector3 {
    const a = c.angle + c.speed * s;
    const r = c.radius * (1 + 0.06 * Math.sin(s * 0.7 + c.phase * 3));
    p.set(Math.sin(a) * r, c.height + c.bob * Math.sin(s * c.bobRate + c.phase), Math.cos(a) * r);
    if (c.face) {
      // Carried face-on round the orbit, tilted a little as it goes: the words you can read.
      q.setFromEuler(new Euler(0.25 * Math.sin(s * 1.3 + c.phase), a + Math.PI * 0.08 * Math.sin(s + c.phase * 2), 0.18 * Math.sin(s * 0.9 + c.phase)));
    } else {
      q.setFromAxisAngle(c.axis, c.spin * s + c.phase);
    }
    return p;
  }

  /** Once the market resumes, the ring's air stays clear: anything that would pass through is pushed round it. */
  private flowAround(p: Vector3, ring: NonNullable<StormFrame['ring']>, since: number): void {
    const d = p.clone().sub(ring.centre);
    const along = d.dot(ring.normal);
    const inPlane = d.clone().addScaledVector(ring.normal, -along);
    const r = inPlane.length();
    const clear = ring.radius * 1.35;
    const depth = 2.4;
    if (r >= clear || Math.abs(along) >= depth) return;
    const strength = Math.min(1, since * 2) * (1 - Math.abs(along) / depth);
    const out = r > 1e-4 ? inPlane.multiplyScalar(1 / r) : new Vector3(1, 0, 0);
    p.addScaledVector(out, (clear - r) * strength);
  }

  /** Lies a card on the plain where it fell, face up, turned any way. */
  private fall(c: Card, p: Vector3, q: Quaternion, k: number, _cam: Vector3): void {
    const target = new Vector3(c.rest.x, FLOOR_Y + 0.004 + (c.entry % 7) * 0.0006, c.rest.z);
    p.lerp(target, k);
    const flat = new Quaternion().setFromEuler(new Euler(-Math.PI / 2, 0, c.rest.yaw, 'YXZ'));
    q.slerp(flat, k);
  }

  /** Which atlas entry a card shows at its clock: a word always the same, a price a new one every few frames. */
  private entryAt(c: Card, s: number): number {
    if (!c.price) return c.entry;
    const tick = Math.floor(s * 9 + c.phase * 10);
    return this.priceEntries[(tick * 7 + c.entry) % this.priceEntries.length]!;
  }

  // ——— drawing order ——————————————————————————————————————————————————————————————————————————

  private readonly staged = { uv: new Float32Array(COUNT * 4), alpha: new Float32Array(COUNT), blur: new Float32Array(COUNT), shade: new Float32Array(COUNT) };

  private reorder(k: number, i: number, visible: number): void {
    const s = this.staged;
    s.uv.set([this.uv.getX(i), this.uv.getY(i), this.uv.getZ(i), this.uv.getW(i)], k * 4);
    s.alpha[k] = visible * (this.cards[i]!.price ? 0.9 : 0.82);
    s.blur[k] = this.blur.getX(i);
    s.shade[k] = this.shade.getX(i);
  }

  private commitReorder(): void {
    (this.uv.array as Float32Array).set(this.staged.uv);
    (this.alpha.array as Float32Array).set(this.staged.alpha);
    (this.blur.array as Float32Array).set(this.staged.blur);
    (this.shade.array as Float32Array).set(this.staged.shade);
  }

  // ——— the cards ——————————————————————————————————————————————————————————————————————————————

  private buildCards(): void {
    const random = seeded(311);
    const between = (a: number, b: number) => a + (b - a) * random();
    const phrases = CHAT.length;
    for (let i = 0; i < COUNT; i++) {
      // Most of the storm is far; the near ring of words, fast and large, is what the lens catches.
      const u = random();
      const radius = 3.1 + 44 * u ** 1.6;
      const price = random() < 0.28;
      const face = random() < 0.62;
      const axis = new Vector3(between(-1, 1), between(-1, 1), between(-1, 1)).normalize();
      this.cards.push({
        // The atlas holds the phrases first, then the prices.
        entry: price ? phrases + (i % PRICES.length) : i % phrases,
        price,
        radius,
        height: FLOOR_Y + 0.4 + (13 + radius * 0.35) * random() ** 1.3,
        angle: random() * Math.PI * 2,
        // Faster the closer it runs, as air in a vortex does.
        speed: 1.5 * (radius / 4) ** -0.75 * between(0.85, 1.15),
        bob: between(0.2, 1.1),
        bobRate: between(0.4, 1.3),
        phase: random() * Math.PI * 2,
        axis,
        spin: between(0.6, 2.2) * (random() < 0.5 ? -1 : 1),
        size: (price ? 0.55 : 0.42) * (0.75 + radius * 0.035) * between(0.7, 1.5),
        face,
        shade: random() < 0.35 ? 1 : 0,
        rest: (() => {
          const a = random() * Math.PI * 2;
          const r = 2.6 + 26 * random() ** 1.4;
          return { x: Math.sin(a) * r, z: Math.cos(a) * r, yaw: random() * Math.PI * 2 };
        })(),
      });
    }
  }

  private buildAtlas(): CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS.width;
    canvas.height = ATLAS.height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    const line = ATLAS.font + ATLAS.pad * 2;
    let x = 0;
    let y = 0;
    const add = (text: string, font: string) => {
      ctx.font = font;
      const w = Math.ceil(ctx.measureText(text).width) + ATLAS.pad * 2;
      if (x + w > ATLAS.width) {
        x = 0;
        y += line;
      }
      if (y + line > ATLAS.height) throw new Error('the storm atlas is full');
      ctx.fillText(text, x + ATLAS.pad, y + ATLAS.pad + ATLAS.font * 0.78);
      this.entries.push({ u0: x / ATLAS.width, v0: 1 - (y + line) / ATLAS.height, u1: (x + w) / ATLAS.width, v1: 1 - y / ATLAS.height, aspect: w / line });
      x += w;
    };
    for (const text of CHAT) add(text, `600 ${ATLAS.font}px Geist`);
    for (const text of PRICES) {
      this.priceEntries.push(this.entries.length);
      add(`₹${text}`, `600 ${ATLAS.font}px Geist`);
    }
    const texture = new CanvasTexture(canvas);
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 8;
    return texture;
  }
}
