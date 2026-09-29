import { CanvasTexture, Color, DoubleSide, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';

/**
 * The market's price, in the sky: one figure the storm condenses into, never the same two frames running — until the
 * robot's ring closes round it and it stops. Set in the brand's typeface, in the site's ink.
 */

const WIDTH = 2048;
const HEIGHT = 512;

export class Price {
  readonly mesh: Mesh;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicMaterial;
  private shown = '';

  constructor() {
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.generateMipmaps = true;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.anisotropy = 8;
    this.material = new MeshBasicMaterial({ map: this.texture, color: new Color('#121317'), transparent: true, depthWrite: false, side: DoubleSide, fog: false });
    // A card four times as wide as it is tall; one unit tall.
    this.mesh = new Mesh(new PlaneGeometry(4, 1), this.material);
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }

  /** The figure the market shows at a moment: a new one twelve times a second. */
  static moving(t: number): string {
    const tick = Math.floor(t * 12);
    const h = Math.sin(tick * 12.9898) * 43758.5453;
    const f = h - Math.floor(h);
    return (98.5 + f * 6).toFixed(2);
  }

  /** Shows `value` (a figure such as "102.00"), at `opacity`. */
  show(value: string, opacity: number): void {
    this.mesh.visible = opacity > 0.001;
    this.material.opacity = opacity;
    if (value === this.shown) return;
    this.shown = value;
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#fff';
    ctx.font = '600 360px Geist';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.letterSpacing = '-8px';
    // Every figure on the same advance (tabular), so a changing price never changes width or shifts.
    const figure = Math.max(...[...'0123456789'].map((d) => ctx.measureText(d).width));
    const glyphs = [...`₹${value}`].map((ch) => ({ ch, width: /\d/.test(ch) ? figure : ctx.measureText(ch).width }));
    let x = WIDTH / 2 - glyphs.reduce((sum, g) => sum + g.width, 0) / 2;
    for (const g of glyphs) {
      ctx.fillText(g.ch, x + g.width / 2, HEIGHT * 0.74);
      x += g.width;
    }
    this.texture.needsUpdate = true;
  }
}
