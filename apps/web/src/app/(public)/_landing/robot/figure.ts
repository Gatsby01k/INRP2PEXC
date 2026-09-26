import { type BufferGeometry, CylinderGeometry, DataTexture, Group, type Material, Mesh, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector3 } from 'three';
import { COLOR } from '@inrp2p/ui/tokens';
import type { Pose } from './behaviour.ts';
import { type Outline, type Superquadric, frontBead, frontPanel, frontZ, superellipsoid, superquadric, sweptBand, tapered, turned } from './geometry.ts';
import { beaconMaterial, emblemMaterial, graphiteMaterial, headMaterial, lightMaterial, orangeMaterial, shellMaterial, torsoMaterial, visorMaterial } from './materials.ts';

/**
 * The robot: a moulded ceramic shell, a glass visor with the face behind it, a headset, and the brand's mark on
 * its chest — built from a handful of exact shapes.
 *
 * The rig is four pivots — hips, chest, neck, head — because that is where a body actually bends. Breathing and
 * weight shifts turn the whole figure from the hips; the chest takes up a fraction of every look; a look is shared
 * between neck and head; the face is drawn by the visor's shader and moved by uniforms, never by moving geometry.
 * Units are the shell's own: the head is 1.6 wide, and the world origin is the centre of the head at rest.
 */

/** Where the head sits when the figure is at rest; looks are measured from here. */
export const HEAD_CENTRE = { x: 0, y: 0, z: 0 } as const;

/** The head: squarer face-on than in plan, so the visor has a broad front to sit on and the sides still turn. */
export const HEAD: Superquadric = { a: 0.8, b: 0.64, c: 0.64, p: 3, q: 3.4 };

/** The visor's outline on the front of the head: most of the face, a little below its centre. */
export const VISOR: Outline = { cx: 0, cy: -0.02, w: 0.62, h: 0.465, m: 3.6 };

/**
 * At rest the body is turned a few degrees towards the quote module while the face stays on the visitor — a
 * presenter's stance. The neck takes the turn back out, so a look lands exactly where the behaviour aimed it.
 */
const BODY_TURN = 0.07;

/** How far the arms hang away from the body at rest. */
const ARM_SPREAD = 0.05;

/** The hips, well below the frame; the chest's pivot above them; the shoulder line, where the collar sits. */
const HIPS_Y = -2.1;
const CHEST_PIVOT = 1.0;
const SHOULDER_Y = -0.93;
/** The neck's base above the shoulder line, and the head's nodding pivot above that: just under the head. */
const NECK_BASE = 0.02;
const NOD_PIVOT = 0.2;

/** The torso: broader at the shoulders than at the waist, and shallower than it is wide. */
const TORSO: Superquadric = { a: 0.62, b: 0.7, c: 0.44, p: 2.4, q: 3.1 };
const TORSO_TAPER = 0.17;
/** The torso's centre, and where the chest mark sits on it, in the chest's frame. */
const TORSO_Y = -0.62;
const MARK_Y = -0.3;

export interface Figure {
  readonly root: Group;
  apply(pose: Pose): void;
  dispose(): void;
}

export function buildFigure(): Figure {
  const head = headMaterial(VISOR, -0.2);
  const visor = visorMaterial();
  const torso = torsoMaterial(new Vector3(0, MARK_Y - TORSO_Y, 0.206));
  const shell = shellMaterial();
  const graphite = graphiteMaterial();
  const orange = orangeMaterial();
  const beacon = beaconMaterial();
  const glowMaterial = new SpriteMaterial({ map: glowTexture(), color: COLOR['brand-primary'], transparent: true, depthWrite: false, opacity: 0 });
  const light = lightMaterial();
  const emblem = emblemMaterial();
  const materials: Material[] = [head, visor.material, torso, shell, graphite, orange, beacon.material, glowMaterial, light, emblem.material];
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

  // Hips: the pivot for breathing and weight, well below the frame.
  const hips = new Group();
  hips.position.set(0, HIPS_Y, 0);

  // Chest: the upper torso's own pivot. It carries the shoulders, arms and neck, and turns a fraction of every look
  // a beat after the neck, so a turn of the head reaches down into the body.
  const chest = new Group();
  chest.position.set(0, CHEST_PIVOT, 0);
  hips.add(chest);

  // The shoulder line, in the chest's frame.
  const shoulders = SHOULDER_Y - HIPS_Y - CHEST_PIVOT;
  const body = mesh(keep(tapered(superquadric(TORSO, 160, 120), TORSO_TAPER, TORSO.b)), torso);
  body.position.set(0, shoulders + TORSO_Y, 0);
  const collar = mesh(keep(new TorusGeometry(0.175, 0.032, 24, 96)), graphite);
  collar.position.set(0, shoulders + 0.028, 0);
  collar.rotation.x = Math.PI / 2;
  chest.add(body, collar);

  // The mark, set into the chest where the shell faces the visitor, square to the surface there.
  const markY = shoulders + MARK_Y;
  const localY = MARK_Y - TORSO_Y;
  const z0 = frontZ(TORSO, 0, localY) ?? TORSO.c;
  const slope = ((frontZ(TORSO, 0, localY + 1e-3) ?? z0) - (frontZ(TORSO, 0, localY - 1e-3) ?? z0)) / 2e-3;
  const mark = new Group();
  mark.position.set(0, markY, z0);
  mark.rotation.x = Math.PI / 2 - Math.atan(-slope);
  mark.add(
    mesh(keep(turned([[0, -0.07], [0.178, -0.07], [0.176, 0.006], [0.155, 0.014], [0.1, 0.02], [0, 0.022]], 0.004, 96)), emblem.material),
    mesh(keep(turned([[0.206, -0.07], [0.206, 0.006], [0.198, 0.016], [0.184, 0.016], [0.176, 0.004], [0.176, -0.07]], 0.003, 96)), graphite),
  );
  chest.add(mark);

  // Shoulders: a graphite socket in each side of the body, and an arm hung from it, close in and just clear of the
  // shell, a little behind the chest's front.
  const armShell = keep(superellipsoid(0.135, 0.43, 0.145, 2.3, 72, 72));
  const socket = keep(turned([[0, -0.05], [0.118, -0.05], [0.122, 0.0], [0.112, 0.022], [0, 0.026]], 0.008, 64));
  const armPivots: { readonly group: Group; readonly side: -1 | 1 }[] = [];
  for (const side of [-1, 1] as const) {
    const arm = new Group();
    arm.position.set(0.765 * side, shoulders - 0.16, -0.03);
    arm.rotation.z = ARM_SPREAD * side;
    const joint = mesh(socket, graphite);
    joint.position.x = -0.1 * side;
    joint.rotation.z = -side * (Math.PI / 2);
    const limb = mesh(armShell, shell);
    limb.position.set(0, -0.31, 0);
    arm.add(joint, limb);
    chest.add(arm);
    armPivots.push({ group: arm, side });
  }

  // Neck: carries a third of every look, arriving a moment after the head.
  const neck = new Group();
  neck.position.set(0, shoulders + NECK_BASE, 0);
  neck.add(
    mesh(
      keep(
        turned([
          [0, 0],
          [0.15, 0],
          [0.155, 0.05],
          [0.137, 0.066],
          [0.155, 0.082],
          [0.155, 0.13],
          [0.137, 0.146],
          [0.155, 0.162],
          [0.15, 0.36],
          [0, 0.36],
        ], 0.006),
      ),
      graphite,
    ),
  );
  chest.add(neck);

  const headPivot = new Group();
  headPivot.position.set(0, NOD_PIVOT, 0);
  neck.add(headPivot);
  // The head's centre is the world origin at rest.
  const skull = new Group();
  skull.position.set(0, HEAD_CENTRE.y - (SHOULDER_Y + NECK_BASE + NOD_PIVOT), 0);
  headPivot.add(skull);
  skull.add(mesh(keep(superquadric(HEAD, 192, 144)), head));

  // The visor: glass standing a little proud of the shell and domed a little more than it, rolled down at its
  // edge into a graphite gasket.
  const lift = (r: number) => (0.011 + 0.014 * (1 - r * r)) * (1 - smooth(0.93, 1, r)) + 0.002;
  skull.add(mesh(keep(frontPanel(HEAD, VISOR, lift, 56, 256)), visor.material, false));
  skull.add(mesh(keep(frontBead(HEAD, VISOR, 0.0135, 0.004, 320)), graphite, false));

  // The headset: an ear cup either side — graphite collar, orange cup, a ring of light around a ceramic cap —
  // and a slim band over the crown between them.
  const cupCollar = keep(turned([[0, -0.07], [0.268, -0.07], [0.272, 0.0], [0.268, 0.02], [0.25, 0.028], [0, 0.028]], 0.006, 96));
  const cup = keep(turned([[0, 0], [0.25, 0], [0.252, 0.03], [0.246, 0.074], [0.232, 0.098], [0.212, 0.108], [0.198, 0.106], [0.198, 0.09], [0, 0.09]], 0.006, 96));
  // A dark channel between the cup's rim and the cap, for the ring of light to sit in.
  const channel = keep(turned([[0, 0.08], [0.2, 0.08], [0.2, 0.1], [0, 0.1]], 0.004, 96));
  const cap = keep(turned([[0, 0.09], [0.158, 0.09], [0.158, 0.11], [0.14, 0.121], [0.08, 0.13], [0, 0.132]], 0.006, 96));
  const ring = keep(new TorusGeometry(0.178, 0.0075, 16, 128));
  for (const side of [-1, 1] as const) {
    const ear = new Group();
    ear.position.set(0.785 * side, -0.04, 0);
    ear.rotation.z = -side * (Math.PI / 2);
    const lit = mesh(ring, light, false);
    lit.position.y = 0.1;
    lit.rotation.x = Math.PI / 2;
    ear.add(mesh(cupCollar, graphite), mesh(cup, orange), mesh(channel, graphite), mesh(cap, shell), lit);
    skull.add(ear);
  }
  skull.add(mesh(keep(sweptBand(headbandPath(HEAD, 0.085, -0.1), 0.024, 0.05)), graphite));

  // The antenna: a ceramic collar, a graphite stem, and a tip of frosted ceramic that is the robot's status light —
  // white at rest, orange and glowing when it is asking for attention.
  const antenna = new Group();
  antenna.position.set(0, HEAD.b - 0.004, -0.02);
  const stem = mesh(keep(new CylinderGeometry(0.015, 0.017, 0.2, 32)), graphite);
  stem.position.y = 0.12;
  const tip = mesh(keep(new SphereGeometry(0.058, 48, 32)), beacon.material);
  tip.position.y = 0.25;
  const halo = new Sprite(glowMaterial);
  halo.position.y = 0.25;
  halo.scale.setScalar(0.32);
  halo.visible = false;
  antenna.add(mesh(keep(turned([[0, -0.03], [0.072, -0.03], [0.072, 0.0], [0.062, 0.018], [0.036, 0.028], [0, 0.03]], 0.006, 64)), shell), stem, tip, halo);
  skull.add(antenna);

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
      const face = visor.face;
      face.uGaze.value.set(pose.gazeX, pose.gazeY);
      face.uEyeOpen.value = pose.eyeOpen;
      face.uEyeGain.value = pose.eyeGain;
      face.uSmile.value = pose.smile;
      face.uLid.value = pose.lid;
      face.uTilt.value = pose.lidTilt;
      face.uSquint.value = pose.squint;
      face.uScan.value = pose.scan;
      face.uScanAt.value = pose.scanAt;
      face.uDots.value = pose.dots;
      face.uDotLevel.value.set(pose.dotLevel[0], pose.dotLevel[1], pose.dotLevel[2]);
      emblem.mark.uArcGlow.value.set(pose.arcGlow[0], pose.arcGlow[1], pose.arcGlow[2]);
      emblem.mark.uHubGlow.value = pose.hubGlow;
      light.emissiveIntensity = pose.accentGlow;
      beacon.set(pose.beacon);
      glowMaterial.opacity = Math.min(pose.beacon, 1) * 0.3;
      halo.visible = pose.beacon > 1e-3;
    },
    dispose() {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      glowMaterial.map?.dispose();
    },
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * The headband's centre line: the head's own silhouette, face-on, held `clearance` off it and set `z` back from
 * the face, from one ear cup over the crown to the other. Its ends finish inside the cups.
 */
function headbandPath(s: Superquadric, clearance: number, z: number): Vector3[] {
  const points: Vector3[] = [];
  const from = 0.1;
  for (let i = 0; i <= 160; i++) {
    const t = from + (i / 160) * (Math.PI - 2 * from);
    const c = Math.cos(t);
    const n = Math.sin(t);
    const x = s.a * Math.sign(c) * Math.abs(c) ** (2 / s.q);
    const y = s.b * Math.sign(n) * Math.abs(n) ** (2 / s.q);
    const gx = (Math.sign(x) * Math.abs(x / s.a) ** (s.q - 1)) / s.a;
    const gy = (Math.sign(y) * Math.abs(y / s.b) ** (s.q - 1)) / s.b;
    const len = Math.hypot(gx, gy) || 1;
    points.push(new Vector3(x + (clearance * gx) / len, y + (clearance * gy) / len, z));
  }
  return points;
}

/** A soft round falloff, white at the centre and clear at the edge: the light around the antenna's tip. */
function glowTexture(): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.max(0, 1 - r) ** 2.2;
      data.set([255, 255, 255, Math.round(a * 255)], (y * size + x) * 4);
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.needsUpdate = true;
  return texture;
}
