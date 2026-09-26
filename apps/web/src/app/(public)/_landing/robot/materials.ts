import { Color, MeshPhysicalMaterial, MeshStandardMaterial, Vector2, Vector3, type IUniform } from 'three';
import { COLOR } from '@inrp2p/ui/tokens';

/**
 * The robot's materials.
 *
 * Four real materials — a glossy moulded shell, a graphite metal for joints, a dark glass visor and the brand
 * orange — and the details that make them read as manufactured rather than modelled: the visor set into the
 * shell with a gasket around it, the seam where the front shell meets the back, the chest mark. Those details
 * are drawn on the surface in the shader, measured in the shell's own units, rather than built as separate
 * meshes floating a hair above it; that is what keeps their edges exact at every size and every angle.
 *
 * Neutral colours below are material albedos, not interface colours: a white shell is not `#FFFFFF`, because
 * nothing physical reflects all the light that reaches it. Orange is the brand token, used as supplied.
 */
const SHELL = '#F2F0EB';
const SEAM = '#2E3036';
const GRAPHITE = '#25272C';
const VISOR = '#060709';
const BRAND = COLOR['brand-primary'];
/** The hot centre of an eye: the brand orange pushed towards warm white, never a second hue. */
const EYE_CORE = '#FF9B63';

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
}

/** Signed-distance helpers shared by every patched surface. */
const SDF = /* glsl */ `
varying vec3 vSurface;
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
`;

function patch(material: MeshPhysicalMaterial, p: SurfacePatch): MeshPhysicalMaterial {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, p.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurface;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurface = position;');
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

const shell = (): MeshPhysicalMaterial =>
  new MeshPhysicalMaterial({ color: SHELL, roughness: 0.34, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.14 });

/** What the behaviour writes every frame to drive the face. */
export interface FaceUniforms {
  /** Eye offset across the visor, in shell units. */
  readonly uGaze: { value: Vector2 };
  /** 1 open, 0 shut; below 1 while the optics focus. */
  readonly uEyeOpen: { value: number };
  /** Brightness of the eyes, around 1. */
  readonly uEyeGain: { value: number };
}

/** What the behaviour writes every frame to drive the chest mark: one glow value per arc, and the hub. */
export interface MarkUniforms {
  readonly uArcGlow: { value: Vector3 };
  readonly uHubGlow: { value: number };
}

/** The head shell, with the visor, its gasket, the crown seam and the eyes drawn on it. */
export function headMaterial(): { material: MeshPhysicalMaterial; face: FaceUniforms } {
  const face: FaceUniforms = {
    uGaze: { value: new Vector2() },
    uEyeOpen: { value: 1 },
    uEyeGain: { value: 1 },
  };
  const uniforms: Uniforms = {
    uVisorColor: { value: new Color(VISOR) },
    uSeamColor: { value: new Color(SEAM) },
    uEyeColor: { value: new Color(BRAND) },
    uEyeCore: { value: new Color(EYE_CORE) },
    ...face,
  };
  const material = patch(shell(), {
    key: 'inrp2p-robot-head',
    uniforms,
    declarations: /* glsl */ `
      uniform vec3 uVisorColor;
      uniform vec3 uSeamColor;
      uniform vec3 uEyeColor;
      uniform vec3 uEyeCore;
      uniform vec2 uGaze;
      uniform float uEyeOpen;
      uniform float uEyeGain;
      const vec2 VISOR_CENTER = vec2(0.0, -0.03);
      const vec2 VISOR_HALF = vec2(0.5, 0.33);
      const float VISOR_RADIUS = 0.2;
      const float EYE_SEPARATION = 0.19;
      const vec2 EYE_HALF = vec2(0.056, 0.086);
    `,
    surface: /* glsl */ `
      float front = smoothstep(0.1, 0.3, vSurface.z);
      float dVisor = sdRoundBox(vSurface.xy - VISOR_CENTER, VISOR_HALF, VISOR_RADIUS);
      float visor = fill(dVisor) * front;
      float gasket = line(dVisor - 0.0075, 0.0075) * front * (1.0 - visor);
      // A little occlusion outside the gasket sets the visor into the shell instead of painting it on.
      float recess = (1.0 - smoothstep(0.0, 0.07, dVisor)) * front * (1.0 - visor);
      diffuseColor.rgb *= 1.0 - 0.12 * recess;
      // The seam where the front shell meets the back, over the crown and down to the ears.
      float crown = line(vSurface.z + 0.07, 0.0028) * smoothstep(-0.3, -0.1, vSurface.y);
      diffuseColor.rgb = mix(diffuseColor.rgb, uSeamColor, max(gasket, crown * 0.85));
      diffuseColor.rgb = mix(diffuseColor.rgb, uVisorColor, visor);
    `,
    roughness: /* glsl */ `
      roughnessFactor = mix(roughnessFactor, 0.5, max(gasket, crown));
      roughnessFactor = mix(roughnessFactor, 0.08, visor);
    `,
    emissive: /* glsl */ `
      vec2 pe = vSurface.xy - VISOR_CENTER - uGaze;
      vec2 q = vec2(abs(pe.x) - EYE_SEPARATION, pe.y);
      float h = max(EYE_HALF.y * uEyeOpen, 0.005);
      float dEye = sdRoundBox(q, vec2(EYE_HALF.x, h), min(EYE_HALF.x, h));
      float eye = fill(dEye);
      float core = 1.0 - smoothstep(-EYE_HALF.x * 0.9, 0.0, dEye);
      float halo = exp(-max(dEye, 0.0) * 40.0) * 0.16;
      // Brand orange at the rim, warmer towards the middle: how an emitter looks through dark glass.
      vec3 eyeLight = mix(uEyeColor, uEyeCore, core * 0.7) * eye * (1.15 + 0.85 * core) + uEyeColor * halo;
      totalEmissiveRadiance += eyeLight * uEyeGain * visor;
    `,
  });
  return { material, face };
}

/** The chest shell, with the plate seam and the three-arc mark — the brand's motif, not its logo. */
export function torsoMaterial(): { material: MeshPhysicalMaterial; mark: MarkUniforms } {
  const mark: MarkUniforms = {
    uArcGlow: { value: new Vector3() },
    uHubGlow: { value: 0 },
  };
  const material = patch(shell(), {
    key: 'inrp2p-robot-torso',
    uniforms: {
      uSeamColor: { value: new Color(SEAM) },
      uPortColor: { value: new Color(GRAPHITE) },
      uArcColor: { value: new Color(BRAND) },
      ...mark,
    },
    declarations: /* glsl */ `
      uniform vec3 uSeamColor;
      uniform vec3 uPortColor;
      uniform vec3 uArcColor;
      uniform vec3 uArcGlow;
      uniform float uHubGlow;
      const vec2 MARK_CENTER = vec2(0.0, 0.65);
      // The yoke: one seam curving under the mark from shoulder to shoulder, where a chest plate would meet.
      const vec2 YOKE_CENTRE = vec2(0.0, 1.38);
      const float YOKE_RADIUS = 0.98;
      const float PORT_RADIUS = 0.13;
      const float ARC_RADIUS = 0.086;
      const float ARC_HALF_WIDTH = 0.0115;
      // Each arc spans 120° less a 30° gap, as in the mark: half-aperture 45°.
      const vec2 ARC_APERTURE = vec2(0.70710678, 0.70710678);
      float sdArc(vec2 p, vec2 sc, float ra, float rb) {
        p.x = abs(p.x);
        return ((sc.y * p.x > sc.x * p.y) ? length(p - sc * ra) : abs(length(p) - ra)) - rb;
      }
    `,
    surface: /* glsl */ `
      float frontM = smoothstep(0.18, 0.34, vSurface.z);
      vec2 pm = vSurface.xy - MARK_CENTER;
      float dPort = length(pm) - PORT_RADIUS;
      float port = fill(dPort) * frontM;
      float portRim = line(dPort - 0.008, 0.005) * frontM * (1.0 - port);
      float frontFace = smoothstep(0.05, 0.2, vSurface.z);
      float yoke = line(length(vSurface.xy - YOKE_CENTRE) - YOKE_RADIUS, 0.0028) * frontFace * step(vSurface.y, 1.05);
      // The chest plate's two side seams, running down from where the yoke meets them.
      float yokeY = YOKE_CENTRE.y - sqrt(max(YOKE_RADIUS * YOKE_RADIUS - 0.34, 0.0));
      yoke = max(yoke, line(abs(vSurface.x) - 0.58, 0.0028) * frontFace * step(vSurface.y, yokeY));
      // Arcs centred at 30°, 270° and 150°: the gaps sit where the mark's three nodes are.
      vec3 arcs = vec3(
        fill(sdArc(rotate2(pm, radians(60.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH)),
        fill(sdArc(rotate2(pm, radians(-180.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH)),
        fill(sdArc(rotate2(pm, radians(-60.0)), ARC_APERTURE, ARC_RADIUS, ARC_HALF_WIDTH))
      ) * frontM;
      float hub = fill(length(pm) - 0.024) * frontM;
      float arcMask = max(max(arcs.x, arcs.y), max(arcs.z, hub));
      diffuseColor.rgb = mix(diffuseColor.rgb, uSeamColor, max(portRim, yoke * 0.8));
      diffuseColor.rgb = mix(diffuseColor.rgb, uPortColor, port);
      diffuseColor.rgb = mix(diffuseColor.rgb, uArcColor, arcMask);
    `,
    roughness: /* glsl */ `
      roughnessFactor = mix(roughnessFactor, 0.46, max(port, portRim));
      roughnessFactor = mix(roughnessFactor, 0.4, arcMask);
    `,
    // The port is matte graphite under the lacquer's edge, not under the lacquer: no clearcoat sheen over it.
    lighting: /* glsl */ `
      #ifdef USE_CLEARCOAT
        material.clearcoat *= 1.0 - max(port, portRim);
      #endif
    `,
    emissive: /* glsl */ `
      totalEmissiveRadiance += uArcColor * (dot(arcs, uArcGlow) + hub * uHubGlow + arcMask * 0.32);
    `,
  });
  return { material, mark };
}

/**
 * An arm's shell, with an orange stripe inlaid around it just below the shoulder — the same orange as the ear
 * rings, so the accents read as one system. Its glow follows the ear rings'.
 */
export function armMaterial(): { material: MeshPhysicalMaterial; glow: { value: number } } {
  const glow = { value: 0.15 };
  const material = patch(shell(), {
    key: 'inrp2p-robot-arm',
    uniforms: { uAccentColor: { value: new Color(BRAND) }, uAccentGlow: glow },
    declarations: /* glsl */ `
      uniform vec3 uAccentColor;
      uniform float uAccentGlow;
    `,
    surface: /* glsl */ `
      float band = line(vSurface.y - 0.4, 0.014);
      diffuseColor.rgb = mix(diffuseColor.rgb, uAccentColor, band);
    `,
    roughness: /* glsl */ `
      roughnessFactor = mix(roughnessFactor, 0.34, band);
    `,
    emissive: /* glsl */ `
      totalEmissiveRadiance += uAccentColor * band * uAccentGlow;
    `,
  });
  return { material, glow };
}

export const shellMaterial = shell;

export const graphiteMaterial = (): MeshStandardMaterial => new MeshStandardMaterial({ color: GRAPHITE, roughness: 0.38, metalness: 0.55 });

/** The orange of the ear rings. Its glow is what the behaviour pulses; the arms' stripes follow it. */
export const accentMaterial = (): MeshStandardMaterial =>
  new MeshStandardMaterial({ color: BRAND, roughness: 0.32, metalness: 0.1, emissive: new Color(BRAND), emissiveIntensity: 0.15 });
