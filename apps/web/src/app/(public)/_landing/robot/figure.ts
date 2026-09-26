import { type BufferGeometry, CylinderGeometry, Group, type Material, Mesh, TorusGeometry } from 'three';
import type { Pose } from './behaviour.ts';
import { superellipsoid, turned } from './geometry.ts';
import { accentMaterial, armMaterial, graphiteMaterial, headMaterial, shellMaterial, torsoMaterial } from './materials.ts';

/**
 * The robot: a moulded shell with a glass visor, built from a handful of exact shapes.
 *
 * The rig is three pivots — hips, neck, head — because that is where a body actually bends. Breathing and weight
 * shifts turn the whole figure from the hips; a look is shared between neck and head; the face is drawn by the
 * visor shader and moved by uniforms, never by moving geometry. Units are the shell's own: the head is about
 * 1.36 wide, and the world origin is the centre of the head at rest.
 */

/** Where the head sits when the figure is at rest; looks are measured from here. */
export const HEAD_CENTRE = { x: 0, y: 0, z: 0 } as const;

/**
 * At rest the body is turned a few degrees towards the quote module while the face stays on the visitor — a
 * presenter's stance. The neck takes the turn back out, so a look lands exactly where the behaviour aimed it.
 */
const BODY_TURN = 0.07;

/** How far the arms hang away from the chest at rest. */
const ARM_SPREAD = 0.07;

/** Height of the chest's pivot above the hips: the lower chest, where the plate's side seams begin. */
const CHEST_PIVOT = 1.0;

export interface Figure {
  readonly root: Group;
  apply(pose: Pose): void;
  dispose(): void;
}

export function buildFigure(): Figure {
  const head = headMaterial();
  const torso = torsoMaterial();
  const shell = shellMaterial();
  const graphite = graphiteMaterial();
  const accent = accentMaterial();
  const arms = armMaterial();
  const materials: Material[] = [head.material, torso.material, arms.material, shell, graphite, accent];
  const geometries: BufferGeometry[] = [];
  const keep = <G extends BufferGeometry>(g: G): G => {
    geometries.push(g);
    return g;
  };

  const mesh = (geometry: BufferGeometry, material: Material, shadows = true): Mesh => {
    const m = new Mesh(geometry, material);
    m.castShadow = shadows;
    m.receiveShadow = shadows;
    return m;
  };

  // Arms are fins from the same family of shapes as the head and chest: one continuous shell each, no elbows
  // to explain, hung just clear of the chest.
  const fin = keep(superellipsoid(0.17, 0.57, 0.25, 2.3, 64, 96));

  // Hips: the pivot for breathing and weight, just below the frame.
  const hips = new Group();
  hips.position.set(0, -2.6, 0);

  // Chest: the upper torso's own pivot, at the lower chest. It carries the shoulders, arms and neck, and turns a
  // fraction of every look a beat after the neck, so a turn of the head reaches down into the body.
  const chest = new Group();
  chest.position.set(0, CHEST_PIVOT, 0);
  hips.add(chest);

  const body = mesh(keep(superellipsoid(0.9, 1.15, 0.55, 3.2, 128, 96)), torso.material);
  body.position.set(0, 0.75 - CHEST_PIVOT, 0);
  const collar = mesh(keep(new TorusGeometry(0.228, 0.048, 24, 96)), graphite);
  collar.position.set(0, 1.87 - CHEST_PIVOT, 0);
  collar.rotation.x = Math.PI / 2;
  chest.add(body, collar);

  const armPivots: { readonly group: Group; readonly side: -1 | 1 }[] = [];
  for (const side of [-1, 1] as const) {
    const arm = new Group();
    arm.position.set(1.03 * side, 1.54 - CHEST_PIVOT, 0);
    arm.rotation.z = ARM_SPREAD * side;
    const limb = mesh(fin, arms.material);
    limb.position.y = -0.53;
    arm.add(limb);
    chest.add(arm);
    armPivots.push({ group: arm, side });
  }

  // Neck: carries a third of every look, arriving a moment after the head.
  const neck = new Group();
  neck.position.set(0, 1.88 - CHEST_PIVOT, 0);
  neck.add(
    mesh(
      keep(
        turned([
          [0, 0],
          [0.2, 0],
          [0.205, 0.05],
          [0.18, 0.066],
          [0.205, 0.082],
          [0.205, 0.132],
          [0.18, 0.148],
          [0.205, 0.164],
          [0.2, 0.26],
          [0, 0.26],
        ], 0.006),
      ),
      graphite,
    ),
  );
  chest.add(neck);

  const headPivot = new Group();
  headPivot.position.set(0, 0.22, 0);
  neck.add(headPivot);
  const skull = new Group();
  skull.position.set(0, 0.5, 0);
  headPivot.add(skull);
  skull.add(mesh(keep(superellipsoid(0.68, 0.56, 0.6, 3, 128, 96)), head.material));

  const earShell = keep(
    turned([
      [0.142, 0.052],
      [0.16, 0.07],
      [0.212, 0.078],
      [0.238, 0.058],
      [0.246, 0.02],
      [0.24, -0.04],
      [0.13, -0.04],
    ], 0.01),
  );
  const earCore = keep(new CylinderGeometry(0.146, 0.146, 0.1, 64));
  const earRing = keep(new TorusGeometry(0.152, 0.011, 16, 96));
  for (const side of [-1, 1] as const) {
    const ear = new Group();
    ear.position.set(0.645 * side, 0, 0);
    ear.rotation.z = -side * (Math.PI / 2);
    const core = mesh(earCore, graphite);
    core.position.y = 0.02;
    const ring = mesh(earRing, accent, false);
    ring.position.y = 0.071;
    ring.rotation.x = Math.PI / 2;
    ear.add(mesh(earShell, shell), core, ring);
    skull.add(ear);
  }

  const root = new Group();
  root.rotation.y = BODY_TURN;
  root.add(hips);

  return {
    root,
    apply(pose) {
      const load = pose.load;
      hips.rotation.set(pose.torsoPitch, pose.torsoYaw, pose.torsoRoll);
      // The load cycle, barely: scaling from the hips lifts the shoulders and head with it by a hair.
      hips.scale.set(1 + 0.002 * load, 1 + 0.003 * load, 1 + 0.005 * load);
      chest.rotation.set(pose.chestPitch, pose.chestYaw, pose.chestRoll);
      // The neck is set in the world, not on the body: it takes out whatever the hips and chest have turned, so
      // the look lands exactly where the behaviour aimed while the body moves beneath it — the way a precise
      // instrument holds its sensor on target. Yaw first, then pitch: the order a look is made in, so a turned
      // head still nods about its own axis. The neck carries its own, trailing share of the look; the head the rest.
      const bodyPitch = pose.torsoPitch + pose.chestPitch;
      const bodyYaw = BODY_TURN + pose.torsoYaw + pose.chestYaw;
      const bodyRoll = pose.torsoRoll + pose.chestRoll;
      neck.rotation.set(-pose.neckPitch - bodyPitch, pose.neckYaw - bodyYaw, pose.headRoll * 0.3 + pose.neckRoll - bodyRoll, 'YXZ');
      headPivot.rotation.set(-(pose.headPitch - pose.neckPitch), pose.headYaw - pose.neckYaw, pose.headRoll * 0.7, 'YXZ');
      // The arms hang from the shoulders and trail the body: sideways as one when it rolls, fore-and-aft as one
      // when it leans, and in opposition when the chest turns. They open a hair with the load (mirrored).
      for (const { group, side } of armPivots) {
        group.rotation.set(pose.armPitch + pose.armTwist * side, 0, ARM_SPREAD * side + pose.armSwing + 0.003 * load * side);
      }
      head.face.uGaze.value.set(pose.gazeX, pose.gazeY);
      head.face.uEyeOpen.value = pose.eyeOpen;
      head.face.uEyeGain.value = pose.eyeGain;
      torso.mark.uArcGlow.value.set(pose.arcGlow[0], pose.arcGlow[1], pose.arcGlow[2]);
      torso.mark.uHubGlow.value = pose.hubGlow;
      accent.emissiveIntensity = pose.accentGlow;
      arms.glow.value = pose.accentGlow;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
