import { BufferGeometry, Float32BufferAttribute, LatheGeometry, Vector2 } from 'three';

/**
 * A superellipsoid, |x/a|ⁿ + |y/b|ⁿ + |z/c|ⁿ = 1, built at its real size.
 *
 * This is the robot's one primitive shape: a sphere pushed towards a cube, which is what a moulded shell
 * actually looks like. Normals are the surface's analytic gradient rather than an average of neighbouring faces,
 * so the shading has no seam where the mesh wraps around and no facets on the broad, glossy panels where
 * reflections would give them away. The size is baked in rather than applied as a scale, so the surface
 * details drawn in the shaders (the visor, the seams, the chest mark) are measured in undistorted units.
 */
export function superellipsoid(a: number, b: number, c: number, n: number, widthSegments = 96, heightSegments = 72): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const pow = (v: number, e: number) => Math.abs(v) ** e;

  for (let iy = 0; iy <= heightSegments; iy++) {
    const v = iy / heightSegments;
    const phi = v * Math.PI;
    for (let ix = 0; ix <= widthSegments; ix++) {
      const u = ix / widthSegments;
      const theta = u * Math.PI * 2;
      const dx = -Math.cos(theta) * Math.sin(phi);
      const dy = Math.cos(phi);
      const dz = Math.sin(theta) * Math.sin(phi);
      // Push the unit-sphere direction out (or in) until it meets the unit superellipsoid.
      const k = (pow(dx, n) + pow(dy, n) + pow(dz, n)) ** (-1 / n);
      const x = dx * k;
      const y = dy * k;
      const z = dz * k;
      positions.push(x * a, y * b, z * c);
      // ∇F of the scaled surface; at the poles the tangential terms vanish and the normal is exactly ±Y.
      const gx = (Math.sign(x) * pow(x, n - 1)) / a;
      const gy = (Math.sign(y) * pow(y, n - 1)) / b;
      const gz = (Math.sign(z) * pow(z, n - 1)) / c;
      const len = Math.hypot(gx, gy, gz) || 1;
      normals.push(gx / len, gy / len, gz / len);
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

/**
 * A turned part — a profile of `[radius, height]` points revolved around Y — with each corner of the profile
 * replaced by a small fillet, because a machined part has no perfectly sharp edge and a render of one does.
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
