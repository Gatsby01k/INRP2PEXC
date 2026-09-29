import { Color, ExtrudeGeometry, Mesh, MeshStandardMaterial, Path, Shape, Vector2 } from 'three';
import { FLOOR_Y } from './world.ts';

/**
 * The rate, set in the ground: the held figure in the brand's typeface and orange, solid, at the scale of a building.
 *
 * Geist ships to the site as woff2, which nothing here can read as outlines, so the figure is set by the browser
 * itself — on a large canvas, exactly as the page sets it — and its edges are traced back into outlines (marching
 * squares at the half-coverage line, between pixels, so the curves stay smooth), then extruded with a small bevel.
 */

const FONT_PX = 520;
const PAD = 8;

export interface MonumentOptions {
  /** The figure, e.g. "₹102.00". */
  readonly text: string;
  /** Height of its figures, in world units. */
  readonly height: number;
  /** How deep it stands. */
  readonly depth: number;
  /** Where the centre of its base stands. */
  readonly x: number;
  readonly z: number;
}

export class Monument {
  readonly mesh: Mesh;
  /** Its footprint and height in the world, for anything that has to go round it. */
  readonly box: { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number; readonly top: number };

  constructor({ text, height, depth, x, z }: MonumentOptions) {
    const { loops, bounds } = trace(text);
    const figureHeight = bounds.maxY - bounds.minY;
    const s = height / figureHeight;
    const cx = (bounds.minX + bounds.maxX) / 2;
    // Canvas y runs down; the world's runs up, and the base sits on the plain.
    const toWorld = (p: Vector2) => new Vector2((p.x - cx) * s, (bounds.maxY - p.y) * s);
    const shapes = nest(loops.map((l) => l.map(toWorld)));
    const bevel = height * 0.012;
    const geometry = new ExtrudeGeometry(shapes, { depth: depth - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 1 });
    geometry.translate(0, 0, -(depth - bevel * 2) / 2);
    const face = new MeshStandardMaterial({ color: new Color('#F04E23'), roughness: 0.42, metalness: 0 });
    const side = new MeshStandardMaterial({ color: new Color('#D8431C'), roughness: 0.55, metalness: 0 });
    this.mesh = new Mesh(geometry, [face, side]);
    this.mesh.position.set(x, FLOOR_Y + bevel, z);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    const width = (bounds.maxX - bounds.minX) * s;
    this.box = { x0: x - width / 2, x1: x + width / 2, z0: z - depth / 2, z1: z + depth / 2, top: FLOOR_Y + height };
  }
}

/** The figure's outlines, traced from the page's own rendering of it, in canvas pixels. */
function trace(text: string): { loops: Vector2[][]; bounds: { minX: number; maxX: number; minY: number; maxY: number } } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const font = `600 ${FONT_PX}px Geist`;
  ctx.font = font;
  ctx.letterSpacing = `${-FONT_PX * 0.02}px`;
  const metrics = ctx.measureText(text);
  const w = Math.ceil(metrics.width + PAD * 2 + FONT_PX * 0.1);
  const h = Math.ceil(FONT_PX * 1.25 + PAD * 2);
  canvas.width = w;
  canvas.height = h;
  ctx.font = font;
  ctx.letterSpacing = `${-FONT_PX * 0.02}px`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, PAD + FONT_PX * 0.05, PAD + FONT_PX * 0.98);
  const data = ctx.getImageData(0, 0, w, h).data;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : data[(y * w + x) * 4 + 3]! / 255);
  const T = 0.5;

  // Marching squares: each cell's crossing edges joined by a segment; the segments linked into closed loops. Edges
  // are keyed on a grid shifted by one, so the empty border round the canvas has keys too.
  const stride = w + 2;
  const vertical = (h + 2) * stride;
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const c = (at(x, y) > T ? 8 : 0) | (at(x + 1, y) > T ? 4 : 0) | (at(x + 1, y + 1) > T ? 2 : 0) | (at(x, y + 1) > T ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const X = x + 1;
      const Y = y + 1;
      const top = Y * stride + X;
      const bottom = (Y + 1) * stride + X;
      const left = vertical + Y * stride + X;
      const right = vertical + Y * stride + X + 1;
      const centre = (at(x, y) + at(x + 1, y) + at(x + 1, y + 1) + at(x, y + 1)) / 4 > T;
      switch (c) {
        case 1: case 14: link(left, bottom); break;
        case 2: case 13: link(bottom, right); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(top, left); break;
        case 5: if (centre) { link(top, left); link(bottom, right); } else { link(top, right); link(left, bottom); } break;
        case 10: if (centre) { link(top, right); link(left, bottom); } else { link(top, left); link(bottom, right); } break;
      }
    }
  }
  /** Where the half-coverage line crosses an edge, in canvas pixels. */
  const position = (key: number): Vector2 => {
    const horizontal = key < vertical;
    const k = horizontal ? key : key - vertical;
    const x = (k % stride) - 1;
    const y = Math.floor(k / stride) - 1;
    const a = at(x, y);
    const b = horizontal ? at(x + 1, y) : at(x, y + 1);
    const f = (T - a) / (b - a);
    return horizontal ? new Vector2(x + f, y) : new Vector2(x, y + f);
  };

  const loops: Vector2[][] = [];
  const used = new Set<number>();
  for (const start of links.keys()) {
    if (used.has(start)) continue;
    const loop: Vector2[] = [];
    let prev = -1;
    let cur = start;
    for (let guard = 0; guard < 1_000_000; guard++) {
      used.add(cur);
      loop.push(position(cur));
      const next = links.get(cur)!.find((n) => n !== prev && !(n === start && loop.length < 3));
      if (next === undefined || next === start) break;
      prev = cur;
      cur = next;
    }
    if (loop.length >= 8) loops.push(simplify(loop, 0.35));
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const l of loops) {
    for (const p of l) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { loops, bounds: { minX, maxX, minY, maxY } };
}

/** Ramer–Douglas–Peucker on a closed loop: drops points that lie within `tolerance` of the line through their neighbours. */
function simplify(loop: Vector2[], tolerance: number): Vector2[] {
  const keep = new Uint8Array(loop.length);
  const stack: [number, number][] = [[0, loop.length - 1]];
  keep[0] = 1;
  keep[loop.length - 1] = 1;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = loop[a]!;
    const B = loop[b]!;
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let far = 0;
    for (let i = a + 1; i < b; i++) {
      const P = loop[i]!;
      const d = Math.abs((P.x - A.x) * dy - (P.y - A.y) * dx) / len;
      if (d > far) {
        far = d;
        worst = i;
      }
    }
    if (worst >= 0 && far > tolerance) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return loop.filter((_, i) => keep[i]);
}

/** Outlines into shapes: a loop inside an odd number of others is a hole in the smallest one around it. */
function nest(loops: Vector2[][]): Shape[] {
  const inside = (p: Vector2, poly: Vector2[]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  const area = (poly: Vector2[]) => {
    let s = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += (poly[j]!.x - poly[i]!.x) * (poly[j]!.y + poly[i]!.y);
    return Math.abs(s / 2);
  };
  const info = loops.map((l, i) => {
    const around = loops.map((o, j) => (j !== i && inside(l[0]!, o) ? j : -1)).filter((j) => j >= 0);
    return { loop: l, around, area: area(l) };
  });
  const shapes = new Map<number, Shape>();
  info.forEach((o, i) => {
    if (o.around.length % 2 === 0) shapes.set(i, new Shape(o.loop));
  });
  info.forEach((o) => {
    if (o.around.length % 2 === 0) return;
    const parent = o.around.filter((j) => shapes.has(j)).sort((a, b) => info[a]!.area - info[b]!.area)[0];
    if (parent !== undefined) shapes.get(parent)!.holes.push(new Path(o.loop));
  });
  return [...shapes.values()];
}
