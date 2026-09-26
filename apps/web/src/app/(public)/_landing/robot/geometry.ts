import { BufferGeometry, CatmullRomCurve3, Float32BufferAttribute, LatheGeometry, TubeGeometry, Vector2, Vector3 } from 'three';

/**
 * The robot's shapes, built at their real size from exact formulas.
 *
 * Every shell is a superquadric — a sphere pushed towards a box, which is what a moulded shell actually looks like —
 * with one exponent for its plan (seen from above) and one for its profile (seen from the front or the side), so a
 * head can be squarer face-on than it is in plan. Normals are the surface's analytic gradient rather than an average
 * of neighbouring faces, so the shading has no seam where the mesh wraps around and no facets on the broad, glossy
 * panels where reflections would give them away. Sizes are baked in rather than applied as a scale, so the details
 * drawn in the shaders (the face, the seams, the chest mark) are measured in undistorted units.
 */

/** |x/a|ᵖ and |z/c|ᵖ in plan, raised to q/p, plus |y/b|^q: the surface is where that sum is 1. */
export interface Superquadric {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  /** Exponent in plan (x–z). 2 is an ellipse; higher is squarer. */
  readonly p: number;
  /** Exponent face-on and in profile (x–y, z–y). */
  readonly q: number;
}

const pow = (v: number, e: number) => Math.abs(v) ** e;

/** Where a ray from the centre in direction `d` meets the surface. */
function onSurface(s: Superquadric, dx: number, dy: number, dz: number): [number, number, number] {
  const plan = pow(dx / s.a, s.p) + pow(dz / s.c, s.p);
  const k = (plan ** (s.q / s.p) + pow(dy / s.b, s.q)) ** (-1 / s.q);
  return [dx * k, dy * k, dz * k];
}

/** The outward normal at a point on the surface: the gradient of its defining function. */
function normalAt(s: Superquadric, x: number, y: number, z: number): [number, number, number] {
  const plan = pow(x / s.a, s.p) + pow(z / s.c, s.p);
  // At the poles the plan term vanishes with its gradient; the normal there is exactly ±Y.
  const f = plan > 1e-12 ? plan ** (s.q / s.p - 1) : 0;
  const gx = (f * Math.sign(x) * pow(x / s.a, s.p - 1)) / s.a;
  const gz = (f * Math.sign(z) * pow(z / s.c, s.p - 1)) / s.c;
  const gy = (Math.sign(y) * pow(y / s.b, s.q - 1)) / s.b;
  const len = Math.hypot(gx, gy, gz) || 1;
  return [gx / len, gy / len, gz / len];
}

/** The front of the surface (z ≥ 0) at `x`, `y`, or null where the surface does not reach. */
export function frontZ(s: Superquadric, x: number, y: number): number | null {
  const rest = (1 - pow(y / s.b, s.q)) ** (s.p / s.q) - pow(x / s.a, s.p);
  if (!(rest >= 0)) return null;
  return s.c * rest ** (1 / s.p);
}

export function superquadric(s: Superquadric, widthSegments = 128, heightSegments = 96): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let iy = 0; iy <= heightSegments; iy++) {
    const v = iy / heightSegments;
    const phi = v * Math.PI;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const u = ix / widthSegments;
      const theta = u * Math.PI * 2;
      const [x, y, z] = onSurface(s, -Math.cos(theta) * Math.sin(phi), Math.cos(phi), Math.sin(theta) * Math.sin(phi));
      positions.push(x, y, z);
      normals.push(...normalAt(s, x, y, z));
      uvs.push(u, 1 - v);
    }
  }

  const row = widthSegments + 1;
  for (let iy = 0; iy < heightSegments; iy++) {
    for (let ix = 0; ix < widthSegments; ix++) {
      const p = iy * row + ix;
      const q = p + row;
      if (iy !== 0) indices.push(p, q, p + 1);
      if (iy !== heightSegments - 1) indices.push(p + 1, q, q + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geometry;
}

/** A superellipsoid, |x/a|ⁿ + |y/b|ⁿ + |z/c|ⁿ = 1: a superquadric with one exponent throughout. */
export const superellipsoid = (a: number, b: number, c: number, n: number, widthSegments = 96, heightSegments = 72): BufferGeometry =>
  superquadric({ a, b, c, p: n, q: n }, widthSegments, heightSegments);

/**
 * Tapers a shape in x as it rises: its half-width is scaled by `1 + taper · y / height` at height y, so a torso can
 * be broader at the shoulders than at the waist. Normals are carried through the deformation exactly (the inverse
 * transpose of its Jacobian), so the analytic shading survives it.
 */
export function tapered(geometry: BufferGeometry, taper: number, height: number): BufferGeometry {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const f = 1 + (taper * y) / height;
    const df = taper / height;
    position.setX(i, x * f);
    const nx = normal.getX(i);
    const ny = normal.getY(i);
    const nz = normal.getZ(i);
    const tx = nx / f;
    const ty = ny - (x * df * nx) / f;
    const len = Math.hypot(tx, ty, nz) || 1;
    normal.setXYZ(i, tx / len, ty / len, nz / len);
  }
  position.needsUpdate = true;
  normal.needsUpdate = true;
  return geometry;
}

/** A squircle outline, |x/w|ᵐ + |y/h|ᵐ = 1, around a centre. */
export interface Outline {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly m: number;
}

/** The point at angle `t` on an outline, scaled by `s` from its centre. */
export function outlinePoint(o: Outline, t: number, s = 1): [number, number] {
  const c = Math.cos(t);
  const n = Math.sin(t);
  return [o.cx + s * o.w * Math.sign(c) * pow(c, 2 / o.m), o.cy + s * o.h * Math.sign(n) * pow(n, 2 / o.m)];
}

/** How far out along its own shape a point is: 0 at the centre, 1 on the outline. */
export const outlineRadius = (o: Outline, x: number, y: number): number => (pow((x - o.cx) / o.w, o.m) + pow((y - o.cy) / o.h, o.m)) ** (1 / o.m);

/**
 * A panel that lies on the front of a shell inside an outline, standing `lift(r)` proud of it at outline radius r:
 * a visor that follows the head's own curvature, domed a little more than the shell and rolled down at its edge.
 * Rings crowd towards the edge, where the roll happens. Normals come from the panel's height field.
 */
export function frontPanel(shell: Superquadric, outline: Outline, lift: (r: number) => number, rings = 48, around = 192): BufferGeometry {
  const height = (x: number, y: number) => (frontZ(shell, x, y) ?? 0) + lift(Math.min(outlineRadius(outline, x, y), 1));
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const e = 1e-4;

  // The centre, then rings out to the outline.
  positions.push(outline.cx, outline.cy, height(outline.cx, outline.cy));
  normals.push(...panelNormal(height, outline.cx, outline.cy, e));
  uvs.push(0.5, 0.5);
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    const r = 1 - (1 - t) ** 2;
    for (let j = 0; j < around; j++) {
      const [x, y] = outlinePoint(outline, (j / around) * Math.PI * 2, r);
      positions.push(x, y, height(x, y));
      normals.push(...panelNormal(height, x, y, e));
      uvs.push(0.5 + (x - outline.cx) / (2 * outline.w), 0.5 + (y - outline.cy) / (2 * outline.h));
    }
  }
  for (let j = 0; j < around; j++) indices.push(0, 1 + j, 1 + ((j + 1) % around));
  for (let i = 1; i < rings; i++) {
    const a = 1 + (i - 1) * around;
    const b = a + around;
    for (let j = 0; j < around; j++) {
      const j1 = (j + 1) % around;
      indices.push(a + j, b + j, b + j1, a + j, b + j1, a + j1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return geometry;
}

function panelNormal(height: (x: number, y: number) => number, x: number, y: number, e: number): [number, number, number] {
  const dx = (height(x + e, y) - height(x - e, y)) / (2 * e);
  const dy = (height(x, y + e) - height(x, y - e)) / (2 * e);
  const len = Math.hypot(dx, dy, 1);
  return [-dx / len, -dy / len, 1 / len];
}

/** A round bead laid along an outline on the front of a shell, `rise` proud of it: a gasket around a visor. */
export function frontBead(shell: Superquadric, outline: Outline, radius: number, rise: number, samples = 256): TubeGeometry {
  const points: Vector3[] = [];
  for (let j = 0; j < samples; j++) {
    const [x, y] = outlinePoint(outline, (j / samples) * Math.PI * 2);
    points.push(new Vector3(x, y, (frontZ(shell, x, y) ?? 0) + rise));
  }
  return new TubeGeometry(new CatmullRomCurve3(points, true, 'centripetal'), samples * 2, radius, 16, true);
}

/**
 * A band swept along a path that lies in a plane of constant z: flat across its width (along z), thin across its
 * thickness (away from the path's centre of curvature), with a squircle section so its edges are rounded. The ends
 * are left open; they finish inside whatever the band is fixed to.
 */
export function sweptBand(path: readonly Vector3[], halfThickness: number, halfWidth: number, m = 4, around = 32): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const section = Array.from({ length: around }, (_, j) => {
    const phi = (j / around) * Math.PI * 2;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const u = halfThickness * Math.sign(c) * pow(c, 2 / m);
    const v = halfWidth * Math.sign(s) * pow(s, 2 / m);
    const nu = (Math.sign(u) * pow(u / halfThickness, m - 1)) / halfThickness;
    const nv = (Math.sign(v) * pow(v / halfWidth, m - 1)) / halfWidth;
    const len = Math.hypot(nu, nv) || 1;
    return { u, v, nu: nu / len, nv: nv / len };
  });
  path.forEach((p, i) => {
    const prev = path[Math.max(i - 1, 0)]!;
    const next = path[Math.min(i + 1, path.length - 1)]!;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    // The in-plane normal, away from the centre of curvature for a path that runs anticlockwise.
    const nx = ty / tl;
    const ny = -tx / tl;
    for (const { u, v, nu, nv } of section) {
      positions.push(p.x + nx * u, p.y + ny * u, p.z + v);
      normals.push(nx * nu, ny * nu, nv);
    }
  });
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * around + j;
      const b = (i + 1) * around + j;
      const c = i * around + ((j + 1) % around);
      const d = (i + 1) * around + ((j + 1) % around);
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geometry;
}

/**
 * A turned part — a profile of `[radius, height]` points revolved around Y — with each corner of the profile
 * replaced by a small fillet, because a machined part has no perfectly sharp edge and a render of one does.
 * The profile keeps the part's outside on its right, as a lathe tool would travel: out across the bottom, up an
 * outer wall, in across the top (and down an inner wall, for a ring). Run the other way, its faces point inwards.
 */
export function turned(profile: readonly (readonly [number, number])[], fillet = 0.008, segments = 72): LatheGeometry {
  const points: Vector2[] = [];
  profile.forEach(([r, h], i) => {
    const prev = profile[i - 1];
    const next = profile[i + 1];
    if (!prev || !next || fillet <= 0) {
      points.push(new Vector2(r, h));
      return;
    }
    // Cut the corner at `fillet` along each edge and round it with a quadratic arc through the corner.
    const toPrev = new Vector2(prev[0] - r, prev[1] - h);
    const toNext = new Vector2(next[0] - r, next[1] - h);
    const cutPrev = Math.min(fillet, toPrev.length() / 2);
    const cutNext = Math.min(fillet, toNext.length() / 2);
    const a = new Vector2(r, h).addScaledVector(toPrev.normalize(), cutPrev);
    const b = new Vector2(r, h).addScaledVector(toNext.normalize(), cutNext);
    for (let s = 0; s <= 4; s++) {
      const t = s / 4;
      const mt = 1 - t;
      points.push(new Vector2(mt * mt * a.x + 2 * mt * t * r + t * t * b.x, mt * mt * a.y + 2 * mt * t * h + t * t * b.y));
    }
  });
  return new LatheGeometry(points, segments);
}
