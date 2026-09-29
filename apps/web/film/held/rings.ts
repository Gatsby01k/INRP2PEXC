import type { Quaternion, Vector3 } from 'three';
import { Color, DoubleSide, type IUniform, Mesh, PlaneGeometry, ShaderMaterial } from 'three';

/**
 * The lock: the three arcs of the robot's chest mark, as light.
 *
 * Each arc is drawn the way the chest mark draws its arcs — an arc of the mark's own proportions, 90° long with 30°
 * gaps where the logo's nodes sit, rounded at its ends — on a flat card in the air, in light rather than inlay: the
 * brand's orange lit from within, a white-hot line along its centre, an orange halo round it. They leave the chest
 * as the chest's own arcs, rise, grow to the size of the sky's price, and snap shut: each arc lengthens to 120°, the gaps close, and three arcs are one ring. That ring
 * is the rate, held.
 *
 * A shockwave leaves the ring as it closes: a thin circle of light running outward, and the storm stops where it
 * passes (`storm.ts`).
 */

/** The mark's arcs: centred at 30°, 270° and 150°, half-aperture 45° (a 90° arc) until they close to 60° (120°). */
export const ARC_CENTRES = [Math.PI / 6, (3 * Math.PI) / 2, (5 * Math.PI) / 6] as const;
export const OPEN = Math.PI / 4;
export const CLOSED = Math.PI / 3;

/** Band width relative to radius: the chest mark's own (0.0135 / 0.105), a touch finer at the ring's size. */
const WIDTH = 0.1;

const vertex = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export interface ArcState {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly radius: number;
  /** Half the arc's angle: `OPEN` as it leaves the chest, `CLOSED` once the ring is whole. */
  readonly half: number;
  /** Brightness of the core, in linear light; the halo follows it. */
  readonly light: number;
  readonly opacity: number;
}

export class Rings {
  readonly arcs: Mesh[] = [];
  readonly wave: Mesh;
  private readonly arcUniforms: { uHalf: IUniform<number>; uLight: IUniform<number>; uOpacity: IUniform<number> }[] = [];
  private readonly waveUniforms = { uRadius: { value: 1 }, uLight: { value: 0 } };

  constructor() {
    const core = new Color('#fff1e4');
    const halo = new Color('#f04e23');
    ARC_CENTRES.forEach((centre) => {
      const lit = { uHalf: { value: OPEN }, uLight: { value: 1 }, uOpacity: { value: 1 } };
      const material = new ShaderMaterial({
        uniforms: {
          ...lit,
          uCentre: { value: centre },
          uCore: { value: core },
          uHalo: { value: halo },
          uWidth: { value: WIDTH },
        },
        vertexShader: vertex,
        fragmentShader: /* glsl */ `
          uniform float uCentre;
          uniform float uHalf;
          uniform float uLight;
          uniform float uOpacity;
          uniform vec3 uCore;
          uniform vec3 uHalo;
          uniform float uWidth;
          varying vec2 vP;
          // Distance to an arc of radius 1 centred on angle uCentre, spanning ±uHalf, with round ends.
          float sdArc(vec2 p) {
            float c = cos(-uCentre + 1.5707963);
            float s = sin(-uCentre + 1.5707963);
            p = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
            p.x = abs(p.x);
            vec2 sc = vec2(sin(uHalf), cos(uHalf));
            float d = (sc.y * p.x > sc.x * p.y) ? length(p - sc) : abs(length(p) - 1.0);
            return d - uWidth * 0.5;
          }
          void main() {
            float d = sdArc(vP);
            float aa = fwidth(d) * 1.2;
            float body = 1.0 - smoothstep(-aa, aa, d);
            // On an ivory sky light alone does not show: the arc is the brand's orange, lit from within, with a
            // white-hot line along its centre (the only part bright enough to bloom) and an orange halo round it.
            float centre = 1.0 - smoothstep(0.0, uWidth * 0.32, abs(d + uWidth * 0.5));
            float halo = (exp(-max(d, 0.0) * 7.0) * 0.5 + exp(-max(d, 0.0) * 28.0) * 0.45) * (1.0 - body);
            vec3 band = mix(uHalo * 1.7, uCore * 3.6, centre * centre);
            vec3 col = band * body + uHalo * 1.25 * halo;
            float a = clamp(body + halo, 0.0, 1.0) * uOpacity;
            gl_FragColor = vec4(col * uLight, a);
          }
        `,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const mesh = new Mesh(new PlaneGeometry(2.8, 2.8), material);
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      this.arcUniforms.push(lit);
      this.arcs.push(mesh);
    });

    const waveMaterial = new ShaderMaterial({
      uniforms: { ...this.waveUniforms, uHalo: { value: halo }, uCore: { value: core } },
      vertexShader: vertex,
      fragmentShader: /* glsl */ `
        uniform float uRadius;
        uniform float uLight;
        uniform vec3 uHalo;
        uniform vec3 uCore;
        varying vec2 vP;
        void main() {
          // A thin circle running outward: a crisp orange edge, hot at its heart, and a faint warmth inside it.
          float r = length(vP);
          float edge = r - uRadius;
          float line = exp(-abs(edge) * 90.0);
          float trail = edge < 0.0 ? exp(edge * 5.0) * 0.18 : 0.0;
          vec3 col = mix(uHalo * 1.6, uCore * 2.4, line * line);
          gl_FragColor = vec4(col, clamp(line + trail, 0.0, 1.0) * uLight);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.wave = new Mesh(new PlaneGeometry(2, 2), waveMaterial);
    this.wave.renderOrder = 3;
    this.wave.frustumCulled = false;
  }

  /** Sets each arc; null hides it. */
  set(states: readonly (ArcState | null)[]): void {
    states.forEach((s, i) => {
      const mesh = this.arcs[i]!;
      mesh.visible = s !== null && s.opacity > 0.001;
      if (!s) return;
      mesh.position.copy(s.position);
      mesh.quaternion.copy(s.quaternion);
      // The card is 2.8 wide for a unit arc, room for its halo; scaled to the arc's radius.
      mesh.scale.setScalar(s.radius);
      const u = this.arcUniforms[i]!;
      u.uHalf.value = s.half;
      u.uLight.value = s.light;
      u.uOpacity.value = s.opacity;
    });
  }

  /** The shockwave: its centre, facing, radius and brightness; zero brightness hides it. */
  setWave(centre: Vector3, quaternion: Quaternion, radius: number, light: number): void {
    this.wave.visible = light > 0.001;
    if (!this.wave.visible) return;
    this.wave.position.copy(centre);
    this.wave.quaternion.copy(quaternion);
    const size = radius * 1.25;
    this.wave.scale.setScalar(size);
    this.waveUniforms.uRadius.value = radius / size;
    this.waveUniforms.uLight.value = light;
  }
}
