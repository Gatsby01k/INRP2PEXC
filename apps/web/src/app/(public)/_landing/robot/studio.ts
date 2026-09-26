import {
  BackSide,
  Color,
  DirectionalLight,
  DoubleSide,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SphereGeometry,
  type Texture,
  type WebGLRenderer,
} from 'three';

/**
 * The studio the robot is lit in, built rather than downloaded.
 *
 * Reflections come from a small photographic set rendered once into an environment map: a large soft box
 * overhead, a tall strip either side and a broad rim behind, in a room of warm mid-grey. On glossy shells that
 * reads as long, clean highlights along the edges — how a product is photographed — instead of the scattered
 * window shapes of a generic room. Nothing sits directly in front of the robot, so the visor stays deep.
 *
 * The direct lights then do what the environment cannot: a warm key that casts the head's shadow onto the neck,
 * and a rim that separates a white shell from a near-white page.
 */
export function studio(renderer: WebGLRenderer): { environment: Texture; lights: readonly (DirectionalLight | HemisphereLight)[]; dispose: () => void } {
  const set = new Scene();
  const disposables: { dispose: () => void }[] = [];
  const room = new Mesh(new SphereGeometry(24, 32, 16), new MeshBasicMaterial({ color: new Color('#5d5955'), side: BackSide }));
  set.add(room);
  disposables.push(room.geometry, room.material);

  const panel = (w: number, h: number, colour: string, intensity: number, at: readonly [number, number, number]) => {
    const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: new Color(colour).multiplyScalar(intensity), side: DoubleSide }));
    mesh.position.set(...at);
    mesh.lookAt(0, 0, 0);
    set.add(mesh);
    disposables.push(mesh.geometry, mesh.material);
  };
  panel(10, 10, '#ffffff', 2.4, [0, 11, 0.5]); // overhead soft box
  panel(1.8, 12, '#ffffff', 4.2, [-8.5, 2, 2.5]); // key strip, the visitor's left
  panel(1.6, 12, '#fff2e8', 2.2, [8.5, 1, 1.5]); // fill strip, the visitor's right
  panel(14, 6, '#ffffff', 2.6, [0, 3, -11]); // rim, behind
  panel(10, 2.6, '#ffffff', 1.25, [0, 6.2, 10]); // a broad diffuser above the camera: the long sweep across the visor
  panel(30, 30, '#efe2d4', 0.3, [0, -10, 0]); // warm floor bounce

  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(set, 0.03).texture;
  pmrem.dispose();
  for (const d of disposables) d.dispose();

  const key = new DirectionalLight('#fff5ec', 2.6);
  key.position.set(3.4, 4.8, 6.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.025;
  key.shadow.radius = 3;
  Object.assign(key.shadow.camera, { left: -2.8, right: 2.8, top: 2.2, bottom: -3.4, near: 1, far: 22 });
  key.shadow.camera.updateProjectionMatrix();

  const rim = new DirectionalLight('#ffffff', 1.5);
  rim.position.set(-4.5, 3.2, -5.5);
  const fill = new HemisphereLight('#ffffff', '#d9cfc2', 0.5);

  return {
    environment,
    lights: [key, rim, fill],
    dispose() {
      environment.dispose();
      key.shadow.map?.dispose();
    },
  };
}
