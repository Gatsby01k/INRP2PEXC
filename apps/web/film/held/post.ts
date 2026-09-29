import { type Camera, CustomBlending, HalfFloatType, type IUniform, OneFactor, type Scene, ShaderMaterial, type Texture, Vector2, type WebGLRenderer, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * The film's lens and film stock: every frame is several exposures averaged, then bloom, then the grade.
 *
 * A frame is `samples` sub-frames spread across the shutter (half a frame, as a 180° shutter exposes), each
 * rendered with the projection nudged by a fraction of a pixel. Averaged, the sub-frames give true motion blur —
 * words in the storm streak by the distance they actually travel — and anti-aliasing from the same work. The
 * average is taken in linear light, before anything bright is clipped, so the arcs and the eyes bloom from their
 * real brightness. Then tone mapping (Khronos PBR Neutral, which keeps the brand's orange the orange it was
 * specified as) and a light grade in display space: a vignette, faint lateral colour at the edges, and grain.
 */

/** A sub-frame about to be rendered: which one of how many, and where in the shutter it falls (−0.5 to 0.5). */
export type Exposure = (index: number, count: number, offset: number) => void;

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Renders the scene several times into one buffer, each weighted equally: the exposure. */
class ExposurePass extends Pass {
  samples = 1;
  expose: Exposure = () => {};
  private readonly scene: Scene;
  private readonly camera: Camera;
  private readonly exposure: WebGLRenderTarget;
  private readonly weights: { tMap: IUniform<Texture | null>; uWeight: IUniform<number> } = { tMap: { value: null }, uWeight: { value: 1 } };
  private readonly add = new FullScreenQuad(
    new ShaderMaterial({
      uniforms: this.weights,
      vertexShader: quadVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tMap;
        uniform float uWeight;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tMap, vUv) * uWeight; }
      `,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
    }),
  );

  constructor(scene: Scene, camera: Camera, width: number, height: number) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.exposure = new WebGLRenderTarget(width, height, { type: HalfFloatType, depthBuffer: true });
  }

  override setSize(width: number, height: number): void {
    this.exposure.setSize(width, height);
  }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget): void {
    for (let i = 0; i < this.samples; i++) {
      this.expose(i, this.samples, this.samples === 1 ? 0 : i / (this.samples - 1) - 0.5);
      renderer.setRenderTarget(this.exposure);
      renderer.clear();
      renderer.render(this.scene, this.camera);
      renderer.setRenderTarget(writeBuffer);
      if (i === 0) {
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
      }
      this.weights.tMap.value = this.exposure.texture;
      this.weights.uWeight.value = 1 / this.samples;
      this.add.render(renderer);
    }
  }

  override dispose(): void {
    this.exposure.dispose();
    this.add.dispose();
  }
}

/** The grade, in display space: vignette, a little lateral colour towards the corners, and grain that changes every frame. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.07 },
    uFringe: { value: 0.0016 },
    uGrain: { value: 0.035 },
    uSeed: { value: 0 },
    uLift: { value: 0 },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: quadVertex,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uFringe;
    uniform float uGrain;
    uniform float uSeed;
    uniform float uLift;
    uniform float uAspect;
    varying vec2 vUv;
    float hash(vec2 p) {
      p = fract(p * vec2(443.897, 441.423) + uSeed);
      p += dot(p, p.yx + 19.19);
      return fract((p.x + p.y) * p.x);
    }
    void main() {
      vec2 c = vUv - 0.5;
      c.x *= uAspect;
      float r = length(c);
      vec2 dir = r > 0.0 ? c / r : vec2(0.0);
      dir.x /= uAspect;
      vec2 shift = dir * uFringe * r * r * 4.0;
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + shift).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - shift).b
      );
      col *= 1.0 - uVignette * smoothstep(0.35, 1.05, r);
      col += uLift;
      // Grain: stronger in the mid-tones, as film's is; never shifting the average.
      float n = hash(gl_FragCoord.xy) - 0.5;
      float mid = 1.0 - abs(dot(col, vec3(0.299, 0.587, 0.114)) * 2.0 - 1.0);
      col += n * uGrain * (0.35 + 0.65 * mid);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export interface Lens {
  /** Sub-frames per frame: 1 for a still subject, more for motion. */
  samples: number;
  /** Called before each sub-frame is drawn, to move the world and the camera to it. */
  expose: Exposure;
  bloom: UnrealBloomPass;
  grade: ShaderPass;
  render(frame: number): void;
  dispose(): void;
}

export function lens(renderer: WebGLRenderer, scene: Scene, camera: Camera): Lens {
  const size = renderer.getDrawingBufferSize(new Vector2());
  const composer = new EffectComposer(renderer, new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType }));
  const exposure = new ExposurePass(scene, camera, size.x, size.y);
  // Only what emits light blooms (the eyes, the arcs, the ring). The set's ivory sits near 1.4 in linear light — the
  // value tone mapping turns into the site's ivory — so the threshold stands well above it.
  const bloom = new UnrealBloomPass(new Vector2(size.x, size.y), 0.9, 0.5, 2.2);
  const output = new OutputPass();
  const grade = new ShaderPass(GradeShader);
  grade.uniforms.uAspect!.value = size.x / size.y;
  composer.addPass(exposure);
  composer.addPass(bloom);
  composer.addPass(output);
  composer.addPass(grade);
  return {
    get samples() {
      return exposure.samples;
    },
    set samples(n: number) {
      exposure.samples = Math.max(1, Math.round(n));
    },
    get expose() {
      return exposure.expose;
    },
    set expose(fn: Exposure) {
      exposure.expose = fn;
    },
    bloom,
    grade,
    render(frame) {
      grade.uniforms.uSeed!.value = (frame * 0.6180339887) % 1;
      composer.render();
    },
    dispose() {
      exposure.dispose();
      composer.dispose();
    },
  };
}
