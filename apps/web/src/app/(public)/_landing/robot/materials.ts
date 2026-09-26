import { Color, MeshPhysicalMaterial, MeshStandardMaterial, Vector2, Vector3, type IUniform } from 'three';
import { COLOR } from '@inrp2p/ui/tokens';
import type { Outline } from './geometry.ts';

/**
 * The robot's materials.
 *
 * Five real materials — a warm ceramic shell, a deep glass visor with the face behind it, graphite for the joints,
 * the brand orange in satin, and the orange as light — and the details that make them read as manufactured rather
 * than modelled: the seam where the front shell meets the back, the shadow a gasket throws on the shell around the
 * visor, the chest mark. Those details are drawn on the surface in the shader, measured in the shell's own units,
 * rather than built as separate meshes floating a hair above it; that is what keeps their edges exact at every size
 * and every angle.
 *
 * Neutral colours below are material albedos, not interface colours: a white shell is not `#FFFFFF`, because
 * nothing physical reflects all the light that reaches it. Orange is the brand token, used as supplied.
 */
const SHELL = '#F3F0EA';
const SEAM = '#3A3B40';
const GRAPHITE = '#1C1D21';
const GLASS = '#040506';
const BRAND = COLOR['brand-primary'];
/** The motif's inlay: the logo's ivory, a shade deeper, so a lit arc can be seen to light. */
const INLAY = '#F1E6D6';
/** The hot centre of an eye: the brand orange pushed towards warm white, never a second hue. */
const EYE_CORE = '#FFA36E';

type Uniforms = Record<string, IUniform>;

interface SurfacePatch {
  /** Distinguishes the compiled program from other patched materials. */
  readonly key: string;
  readonly uniforms: Uniforms;
  /** GLSL at file scope in the fragment shader: uniforms, constants, helper functions. */
  readonly declarations: string;
  /** Runs after the base colour is known; may change `diffuseColor` and declare masks used below. */
  readonly surface: string;
  /** Runs after `roughnessFactor` is known. */
  readonly roughness?: string;
  /** Runs after the physical material is assembled; may adjust `material` (e.g. where the clearcoat stops). */
  readonly lighting?: string;
  /** Runs after `totalEmissiveRadiance` is known. */
  readonly emissive?: string;
  /** Whether the fragment shader needs the direction from the camera, in the part's own space (`vViewObj`). */
  readonly view?: boolean;
}

/** Signed-distance helpers shared by every patched surface. */
const SDF = /* glsl */ `
varying vec3 vSurface;
varying vec3 vViewObj;
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float fill(float d) {
  float aa = max(fwidth(d), 1e-4);
  return 1.0 - smoothstep(-aa, aa, d);
}
float line(float d, float halfWidth) {
  return fill(abs(d) - halfWidth);
}
vec2 rotate2(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
}
float smax(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}
float sdArc(vec2 p, vec2 sc, float ra, float rb) {
  p.x = abs(p.x);
  return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb;
}
`;

function patch(material: MeshPhysicalMaterial, p: SurfacePatch): MeshPhysicalMaterial {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, p.uniforms);
    const view = p.view
      ? 'vViewObj = inverse(mat3(modelMatrix)) * ((modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition);'
      : 'vViewObj = vec3(0.0, 0.0, -1.0);';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurface;\nvarying vec3 vViewObj;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvSurface = position;\n${view}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SDF}\n${p.declarations}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${p.surface}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${p.roughness ?? ''}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>\n${p.lighting ?? ''}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${p.emissive ?? ''}`);
  };
  material.customProgramCacheKey = () => p.key;
  return material;
}

const f = (n: number) => n.toFixed(5);

/** A squircle outline as GLSL: its radius function, 1 on the outline, measured in its own proportions. */
const outlineGlsl = (name: string, o: Outline) => /* glsl */ `
float ${name}(vec2 p) {
  vec2 q = abs(p - vec2(${f(o.cx)}, ${f(o.cy)})) / vec2(${f(o.w)}, ${f(o.h)});
  return pow(pow(q.x, ${f(o.m)}) + pow(q.y, ${f(o.m)}), ${f(1 / o.m)});
}`;

/** The ceramic: a warm white under a thin, hard lacquer. */
export const shellMaterial = (): MeshPhysicalMaterial =>
  new MeshPhysicalMaterial({ color: SHELL, roughness: 0.36, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.09, sheen: 0.25, sheenRoughness: 0.6, sheenColor: new Color('#fff4e8') });

/**
 * The head shell: the seam where its front half meets the back, over the crown and down behind the ears, and the
 * soft shadow the visor's gasket throws on the shell around it.
 */
export function headMaterial(visor: Outline, seamZ: number): MeshPhysicalMaterial {
  return patch(shellMaterial(), {
    key: 'inrp2p-robot-head',
    uniforms: { uSeamColor: { value: new Color(SEAM) } },
    declarations: /* glsl */ `
      uniform vec3 uSeamColor;
      ${outlineGlsl('visorRadius', visor)}
    `,
    surface: /* glsl */ `
      float front = smoothstep(0.12, 0.3, vSurface.z);
      // Just outside the gasket the shell is in its shadow, fading within a few millimetres.
      float r = visorRadius(vSurface.xy);
      float nearVisor = (1.0 - smoothstep(1.0, 1.09, r)) * step(1.0, r) * front;
      diffuseColor.rgb *= 1.0 - 0.16 * nearVisor;
      float seam = line(vSurface.z - ${f(seamZ)}, 0.0024) * smoothstep(-0.25, -0.05, vSurface.y);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSeamColor, seam * 0.8);
    `,
    roughness: /* glsl */ `
      roughnessFactor = mix(roughnessFactor, 0.55, seam);
    `,
  });
}

/** What the behaviour writes every frame to drive the face. */
export interface FaceUniforms {
  /** Eye offset across the display, in shell units. */
  readonly uGaze: { value: Vector2 };
  /** 1 open, 0 shut; below 1 while the optics focus. */
  readonly uEyeOpen: { value: number };
  /** Brightness of the eyes, around 1. */
  readonly uEyeGain: { value: number };
  /** 0 neutral; rising, a lower lid lifts the eyes into a smile; 1 is the closed, smiling arc. */
  readonly uSmile: { value: number };
  /** How far the upper lids come down: 0 open, towards 0.5 intently focused. */
  readonly uLid: { value: number };
  /** The lids' slope: positive lowers their inner ends (concentration), negative raises them (concern). */
  readonly uTilt: { value: number };
  /** 0 open; 1 narrowed to read — lower and a little wider. */
  readonly uSquint: { value: number };
  /** Strength of the reading band, and where it is across the face, 0 → 1. */
  readonly uScan: { value: number };
  readonly uScanAt: { value: number };
  /** 0 two eyes; 1 three dots — the face of waiting. */
  readonly uDots: { value: number };
  /** Brightness of each dot, left to right, while waiting. */
  readonly uDotLevel: { value: Vector3 };
}

/**
 * The visor: dark glass over a display, the face drawn on the display.
 *
 * The display sits a few millimetres behind the glass, and the face is drawn where the eye would see it through
 * the glass — so as the head turns the face moves a little against the reflections on the glass, the way a real
 * screen under a real cover does. That parallax is what makes the visor read as deep rather than painted.
 *
 * The face is one rig, not a set of pictures: an eye is a rounded pill whose upper lid can come down and tilt and
 * whose lower lid can rise into a smile, until at full smile it becomes a single arc; waiting draws the eyes in to
 * two dots and raises a third between them. Every expression is a setting of those few numbers, so any expression
 * can ease into any other without a cut.
 */
export function visorMaterial(): { material: MeshPhysicalMaterial; face: FaceUniforms } {
  const face: FaceUniforms = {
    uGaze: { value: new Vector2() },
    uEyeOpen: { value: 1 },
    uEyeGain: { value: 1 },
    uSmile: { value: 0 },
    uLid: { value: 0 },
    uTilt: { value: 0 },
    uSquint: { value: 0 },
    uScan: { value: 0 },
    uScanAt: { value: 0 },
    uDots: { value: 0 },
    uDotLevel: { value: new Vector3(1, 1, 1) },
  };
  const material = patch(
    new MeshPhysicalMaterial({ color: GLASS, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.025, specularIntensity: 0.6 }),
    {
      key: 'inrp2p-robot-visor',
      view: true,
      uniforms: {
        uEyeColor: { value: new Color(BRAND) },
        uEyeCore: { value: new Color(EYE_CORE) },
        ...face,
      },
      declarations: /* glsl */ `
        uniform vec3 uEyeColor;
        uniform vec3 uEyeCore;
        uniform vec2 uGaze;
        uniform float uEyeOpen;
        uniform float uEyeGain;
        uniform float uSmile;
        uniform float uLid;
        uniform float uTilt;
        uniform float uSquint;
        uniform float uScan;
        uniform float uScanAt;
        uniform float uDots;
        uniform vec3 uDotLevel;
        // The eye line, the display's depth behind the glass, and the eyes' size and spacing.
        const vec2 FACE = vec2(0.0, -0.01);
        const float DEPTH = 0.055;
        const float EYE_X = 0.215;
        const vec2 EYE = vec2(0.064, 0.098);
        const float DOT_X = 0.17;
        const float DOT_R = 0.05;

        // One eye in its own frame: x outward from the face's centre line, y up.
        float eyeShape(vec2 q) {
          // Squinting narrows an eye and draws it out a little sideways, the way a real one narrows to read.
          vec2 h = vec2(EYE.x * (1.0 + 0.3 * uSquint), max(EYE.y * uEyeOpen * (1.0 - 0.55 * uSquint), 0.004));
          float d = sdRoundBox(q, h, min(h.x, h.y));
          // The upper lid: a straight edge, lowered and sloped.
          float k = uTilt * 0.6;
          float dLid = (q.y - (h.y * (1.0 - 1.9 * uLid) + k * q.x)) * inversesqrt(1.0 + k * k);
          d = smax(d, dLid, 0.018);
          // Smiling bends the eye into an arch — a full one halfway — and then draws it out into a single arc
          // with the same weight at every point.
          float bend = smoothstep(0.0, 0.5, uSmile);
          float thin = smoothstep(0.5, 1.0, uSmile);
          float a = radians(mix(74.0, 60.0, thin));
          float arc = sdArc(q - vec2(0.0, mix(-0.052, -0.035, thin)), vec2(sin(a), cos(a)), mix(0.068, 0.1, thin), mix(0.043, 0.027, thin));
          return mix(d, arc, bend);
        }

        vec3 glow(float d, float level) {
          float body = fill(d);
          float core = 1.0 - smoothstep(-0.034, 0.0, d);
          float halo = exp(-max(d, 0.0) * 32.0) * 0.18 + exp(-max(d, 0.0) * 12.0) * 0.012;
          return (mix(uEyeColor, uEyeCore, core * 0.7) * body * (1.05 + 0.95 * core) + uEyeColor * halo) * level;
        }
      `,
      surface: '',
      roughness: '',
      emissive: /* glsl */ `
        // Through the glass to the display behind it.
        vec3 ray = normalize(vViewObj);
        vec2 onDisplay = vSurface.xy + ray.xy * (DEPTH / max(-ray.z, 0.3));
        vec2 pe = onDisplay - FACE - uGaze;
        float side = pe.x < 0.0 ? uDotLevel.x : uDotLevel.z;
        float eyeX = mix(EYE_X, DOT_X, uDots);
        float dEye = eyeShape(vec2(abs(pe.x) - eyeX, pe.y));
        float dDot = length(vec2(abs(pe.x) - eyeX, pe.y)) - DOT_R;
        float d = mix(dEye, dDot, uDots);
        // Reading: a band of brighter light passes through the eyes, from one side to the other.
        float scan = uScan * exp(-pow((pe.x - mix(-0.4, 0.4, uScanAt)) / 0.045, 2.0));
        vec3 light = glow(d, mix(1.0, side, uDots) * (1.0 + 0.9 * scan));
        float middle = smoothstep(0.3, 0.9, uDots);
        light += glow(length(pe) - DOT_R * middle, uDotLevel.y) * middle;
        totalEmissiveRadiance += light * uEyeGain;
      `,
    },
  );
  return { material, face };
}

/** The chest shell, with the pocket the chest mark sits in: `mark` is its centre (x, y) and radius, in the shell's units. */
export function torsoMaterial(mark: Vector3): MeshPhysicalMaterial {
  return patch(shellMaterial(), {
    key: 'inrp2p-robot-torso',
    uniforms: { uMark: { value: mark } },
    declarations: /* glsl */ `
      uniform vec3 uMark;
    `,
    surface: /* glsl */ `
      float frontFace = smoothstep(0.04, 0.2, vSurface.z);
      // The mark sits in a shallow pocket: the shell darkens just outside its bezel, as a recess would.
      float fromMark = length(vSurface.xy - uMark.xy) - uMark.z;
      float pocket = (1.0 - smoothstep(0.0, 0.05, fromMark)) * step(0.0, fromMark) * frontFace;
      diffuseColor.rgb *= 1.0 - 0.14 * pocket;
    `,
  });
}

/** What the behaviour writes every frame to drive the chest mark: one glow value per arc, and the hub. */
export interface MarkUniforms {
  readonly uArcGlow: { value: Vector3 };
  readonly uHubGlow: { value: number };
}

/**
 * The chest mark: a domed disc of orange enamel with the three arcs of the brand's motif inlaid in ivory — the
 * logo's field and its mark's colour, not the logo. The arcs are light guides: each can glow on its own.
 */
export function emblemMaterial(): { material: MeshPhysicalMaterial; mark: MarkUniforms } {
  const mark: MarkUniforms = { uArcGlow: { value: new Vector3() }, uHubGlow: { value: 0 } };
  const material = patch(new MeshPhysicalMaterial({ color: BRAND, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 }), {
    key: 'inrp2p-robot-emblem',
    uniforms: { uInlay: { value: new Color(INLAY) }, uArcLight: { value: new Color('#FFE3CC') }, uBrand: { value: new Color(BRAND) }, ...mark },
    declarations: /* glsl */ `
      uniform vec3 uInlay;
      uniform vec3 uArcLight;
      uniform vec3 uBrand;
      uniform vec3 uArcGlow;
      uniform float uHubGlow;
      const float ARC_RADIUS = 0.105;
      const float ARC_HALF_WIDTH = 0.0135;
      // Each arc spans 120° less a 30° gap, as in the mark: half-aperture 45°.
      const vec2 ARC_APERTURE = vec2(0.70710678, 0.70710678);
    `,
    surface: /* glsl */ `
      // The disc faces +Y in its own frame; its up is -Z.
      vec2 pm = vec2(vSurface.x, -vSurface.z);
      // Arcs centred at 30°, 270° and 150°: the gaps sit where the mark's three nodes are.
      vec3 arcs = vec3(
        fill(sdArc(rotate2(pm, radians(60.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH)),
        fill(sdArc(rotate2(pm, radians(-180.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH)),
        fill(sdArc(rotate2(pm, radians(-60.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH))
      );
      float hub = fill(length(pm) - 0.03);
      float inlay = max(max(arcs.x, arcs.y), max(arcs.z, hub));
      diffuseColor.rgb = mix(diffuseColor.rgb, uInlay, inlay);
      // How close the enamel is to each arc: a lit arc's light spreads a little way into the enamel around it.
      vec3 near = exp(-max(vec3(
        sdArc(rotate2(pm, radians(60.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH),
        sdArc(rotate2(pm, radians(-180.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH),
        sdArc(rotate2(pm, radians(-60.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH)
      ), 0.0) * 55.0);
    `,
    roughness: /* glsl */ `
      roughnessFactor = mix(roughnessFactor, 0.22, inlay);
    `,
    emissive: /* glsl */ `
      totalEmissiveRadiance += uArcLight * 0.9 * (dot(arcs, uArcGlow) + hub * uHubGlow);
      // The enamel around a lit arc glows with it, and warms a little all over under the light behind it.
      totalEmissiveRadiance += uBrand * (0.4 * dot(near, uArcGlow) * (1.0 - inlay) + 0.04 * (uArcGlow.x + uArcGlow.y + uArcGlow.z + uHubGlow));
    `,
  });
  return { material, mark };
}

export const graphiteMaterial = (): MeshPhysicalMaterial =>
  new MeshPhysicalMaterial({ color: GRAPHITE, roughness: 0.42, metalness: 0.25, clearcoat: 0.35, clearcoatRoughness: 0.3 });

/** The brand orange as a finish: satin enamel over the ear cups. */
export const orangeMaterial = (): MeshPhysicalMaterial =>
  new MeshPhysicalMaterial({ color: BRAND, roughness: 0.34, metalness: 0, clearcoat: 0.8, clearcoatRoughness: 0.12 });

/**
 * The antenna's tip: frosted ceramic at rest; as it lights, its colour goes to the brand orange ahead of its glow,
 * so even a faintly lit tip reads as orange light — never as a white bulb tinted pink.
 */
export function beaconMaterial(): { material: MeshPhysicalMaterial; set: (level: number) => void } {
  const material = new MeshPhysicalMaterial({ color: SHELL, roughness: 0.42, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2, emissive: new Color(BRAND), emissiveIntensity: 0 });
  const white = new Color(SHELL);
  const orange = new Color(BRAND);
  return {
    material,
    set(level) {
      const t = Math.min(Math.max(level, 0), 1);
      material.color.copy(white).lerp(orange, Math.sqrt(t));
      material.emissiveIntensity = 1.1 * t;
    },
  };
}

/** The orange as light: the rings in the ear cups. Its strength is what the behaviour pulses. */
export const lightMaterial = (): MeshStandardMaterial =>
  new MeshStandardMaterial({ color: BRAND, roughness: 0.4, metalness: 0, emissive: new Color(EYE_CORE), emissiveIntensity: 0.6 });
