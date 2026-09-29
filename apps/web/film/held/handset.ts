import { CanvasTexture, Color, ExtrudeGeometry, Group, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PlaneGeometry, Shape, SRGBColorSpace } from 'three';

/**
 * A phone lying face up on the plain at dusk, when the money arrives: a real object in the robot's world — a
 * graphite body that catches the evening, a black screen that wakes with the bank's message. Its lock
 * screen is drawn in the brand's typeface; the message slides down from the top as a phone's does.
 */

/** The body, in world units: a modern phone's proportions. */
const W = 0.74;
const H = 1.56;
const T = 0.07;
const RADIUS = 0.11;
/** The screen's canvas, at the phone's aspect. */
const PX = { w: 1020, h: 2150 } as const;

export interface HandsetMessage {
  readonly date: string;
  readonly time: string;
  readonly sender: string;
  readonly body: string;
}

export class Handset {
  readonly group = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly texture: CanvasTexture;
  private readonly screen: MeshBasicMaterial;
  private readonly message: HandsetMessage;
  private drawn = '';

  constructor(message: HandsetMessage) {
    this.message = message;
    const outline = rounded(W, H, RADIUS);
    const body = new Mesh(
      new ExtrudeGeometry(outline, { depth: T - 0.02, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 3, curveSegments: 12 }),
      new MeshPhysicalMaterial({ color: new Color('#2a2b30'), metalness: 0.7, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
    );
    body.castShadow = true;
    this.canvas.width = PX.w;
    this.canvas.height = PX.h;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.anisotropy = 8;
    // The screen emits its own light: unlit, and a touch over 1 so its whites survive the frame's tone mapping.
    this.screen = new MeshBasicMaterial({ map: this.texture, color: new Color(1.25, 1.25, 1.25), toneMapped: true });
    const inset = 0.022;
    const screen = new Mesh(new PlaneGeometry(W - inset * 2, H - inset * 2), this.screen);
    screen.position.z = T + 0.001;
    this.group.add(body, screen);
  }

  /** The screen at a moment: `wake` 0 → 1 as it lights; `inbound` 0 → 1 as the message slides in. */
  show(wake: number, inbound: number): void {
    const key = `${wake.toFixed(3)}|${inbound.toFixed(3)}`;
    if (key === this.drawn) return;
    this.drawn = key;
    const ctx = this.canvas.getContext('2d')!;
    const { w, h } = PX;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 130);
    ctx.clip();
    // The lock screen: near black, a warm glow rising from the bottom, dimmed until the phone wakes.
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0e0d0f');
    bg.addColorStop(0.65, '#161315');
    bg.addColorStop(1, '#3a2419');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = wake;
    ctx.fillStyle = 'rgba(242, 239, 233, 0.82)';
    ctx.textAlign = 'center';
    ctx.font = '500 50px Geist';
    ctx.fillText(this.message.date, w / 2, 250);
    ctx.fillStyle = '#f2efe9';
    ctx.font = '600 250px Geist';
    ctx.letterSpacing = '-8px';
    ctx.fillText(this.message.time, w / 2, 500);
    ctx.letterSpacing = '0px';
    // The bank's message, sliding down into place.
    if (inbound > 0) {
      const y = 600 - (1 - inbound) * 90;
      ctx.globalAlpha = wake * inbound;
      const x = 44;
      const bw = w - 88;
      const bh = 300;
      ctx.fillStyle = 'rgba(58, 58, 64, 0.94)';
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, 56);
      ctx.fill();
      ctx.fillStyle = '#4a4b52';
      ctx.beginPath();
      ctx.roundRect(x + 40, y + 44, 96, 96, 24);
      ctx.fill();
      ctx.strokeStyle = '#f2efe9';
      ctx.lineWidth = 7;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.roundRect(x + 62, y + 70, 52, 36, 8);
      ctx.moveTo(x + 76, y + 106);
      ctx.lineTo(x + 70, y + 120);
      ctx.lineTo(x + 90, y + 106);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#f2efe9';
      ctx.font = '600 44px Geist';
      ctx.fillText(this.message.sender, x + 168, y + 88);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(242, 239, 233, 0.6)';
      ctx.font = '400 40px Geist';
      ctx.fillText('now', x + bw - 40, y + 88);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(242, 239, 233, 0.95)';
      ctx.font = '400 43px Geist';
      wrap(ctx, this.message.body, x + 168, y + 150, bw - 168 - 40, 56);
    }
    ctx.restore();
    this.texture.needsUpdate = true;
  }
}

function rounded(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Words set in lines no wider than `width`. */
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, leading: number): void {
  let line = '';
  let row = 0;
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) {
      ctx.fillText(line, x, y + row * leading);
      line = word;
      row++;
    } else line = next;
  }
  if (line) ctx.fillText(line, x, y + row * leading);
}
