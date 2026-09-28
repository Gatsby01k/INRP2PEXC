import { FRAME, type Framing, type Shot, inOut, progress } from './timeline.ts';

/**
 * The film's camera: a long lens over the page, as a product is photographed — it frames, pushes and cuts, and
 * never tilts, orbits or drifts for its own sake.
 *
 * A camera is the page point at the centre of the frame and how much it is enlarged. The interface layer is moved by
 * a CSS transform; the robot is drawn by its own scene exactly where that transform would put its stage (`place`),
 * rendered at full resolution rather than enlarged, so a close-up of the chest mark is as sharp as a wide shot.
 * Framings are measured from the page as laid out, never typed in: move the product and the shots follow it.
 */
export interface Camera {
  readonly cx: number;
  readonly cy: number;
  readonly z: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Where things are on the page, in page pixels, as laid out at the moment being drawn. */
export interface Layout {
  /** The hero's robot stage: a square, the robot's own framing inside it (antenna to mid-chest). */
  readonly robot: { readonly x: number; readonly y: number; readonly size: number };
  /** The chest mark's arcs at rest: centre and centre-line radius. */
  readonly mark: { readonly x: number; readonly y: number; readonly r: number };
  /** The product column (the quote slot), and the firm rate within it when there is one. */
  readonly column: Rect;
  readonly rate: Rect | null;
}

const { width: W, height: H } = FRAME;
const WIDE: Camera = { cx: W / 2, cy: H / 2, z: 1 };

/** The camera for a named framing of the page. */
export function framing(name: Framing, l: Layout): Camera {
  const { x, y, size } = l.robot;
  const at = (fx: number, fy: number) => ({ cx: x + fx * size, cy: y + fy * size });
  switch (name) {
    case 'wide':
    case 'hero':
      return WIDE;
    case 'eyes':
      // The visor across most of the frame: the three dots, and nothing else yet.
      return { ...at(0.5, 0.405), z: (0.64 * W) / (0.5 * size) };
    case 'face':
      return { ...at(0.5, 0.4), z: (0.86 * H) / (0.62 * size) };
    case 'bust':
      // Antenna to the chest mark and a little below it: the whole of the robot the page ever shows.
      return { ...at(0.5, 0.52), z: H / (0.98 * size) };
    case 'chest':
      // The mark and its bezel a third of the frame's height.
      return { cx: l.mark.x, cy: l.mark.y, z: 80 / l.mark.r };
    case 'chestMacro':
      // The arcs' centre line at 27% of the frame's height: where the logo's own arcs will stand after the cut.
      return { cx: l.mark.x, cy: l.mark.y, z: (0.27 * H) / l.mark.r };
    case 'rate': {
      const r = l.rate ?? l.column;
      return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 - 48, z: (0.56 * W) / r.w };
    }
    case 'two': {
      // The robot, antenna to the page's edge, and the product beside it, top to bottom: both, as large as fits.
      const left = x + 0.13 * size;
      const right = l.column.x + l.column.w + 40;
      const top = Math.min(y + 0.015 * size, l.column.y - 28);
      const bottom = H;
      const z = Math.min(W / (right - left), H / (bottom - top));
      return { cx: (left + right) / 2, cy: bottom - H / 2 / z, z };
    }
  }
}

/** The camera at `t` within a shot: held, pushed slowly in, or moved from one framing to another. */
export function cameraAt(shot: Shot, t: number, l: Layout): Camera {
  const from = framing(shot.framing, l);
  if (shot.moveTo) {
    const to = framing(shot.moveTo, l);
    const p = progress(t, shot.moveFrom ?? shot.from, shot.to, inOut);
    // Position moves evenly on the page; enlargement moves evenly in its ratio, as a lens's focal length is felt.
    return { cx: from.cx + (to.cx - from.cx) * p, cy: from.cy + (to.cy - from.cy) * p, z: from.z * (to.z / from.z) ** p };
  }
  if (shot.push) {
    const p = progress(t, shot.from, shot.to, (v) => v);
    return { ...from, z: from.z * (1 + (shot.push - 1) * p) };
  }
  return from;
}

/** The CSS transform that puts `c` on screen: the camera's point at the frame's centre, enlarged by its factor. */
export function transformOf(c: Camera): string {
  return `translate(${W / 2 - c.cx * c.z}px, ${H / 2 - c.cy * c.z}px) scale(${c.z})`;
}

/** Where a page rectangle lands in the frame under `c`. */
export function onScreen(c: Camera, r: { x: number; y: number; w: number; h: number }): Rect {
  return { x: W / 2 + (r.x - c.cx) * c.z, y: H / 2 + (r.y - c.cy) * c.z, w: r.w * c.z, h: r.h * c.z };
}
