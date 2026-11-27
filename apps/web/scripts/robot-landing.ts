import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { type LookAngles, type LookTarget, type Pose, REST_POSE, RobotBehaviour } from '../src/app/(public)/_landing/robot/behaviour.ts';
import type { RobotCue, RobotFocus } from '../src/app/(public)/_landing/robot/cues.ts';

/**
 * Renders the home page's still robots: the moments its sections show the robot in — worried in a deal done in a
 * chat, delighted by one done here, waving goodbye at the end, winking beside the questions.
 *
 *   pnpm --filter @inrp2p/web robot:landing
 *
 * Written as WebP with transparency next to the sections that show them (`_landing/robot/stills`). Re-run after any
 * change to the robot's shape, materials, lighting, framing or expressions, and commit the images it writes.
 *
 * Every still but the wink is a real moment of the live robot: the behaviour is run, the event that starts each
 * moment is sent, and the pose it produces is taken after the same number of seconds each time. Rendered by the live
 * robot's own scene, in software WebGL (the same result on any machine), and scaled down.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const ROBOT = path.join(APP, 'src/app/(public)/_landing/robot');
const RENDER_SIZE = 1200;
const SIZE = 640;
const FRAME = 1 / 60;
const OUT = path.join(ROBOT, 'stills');

/** Where things are, as seen from the robot's head in the hero: the module to its left (the visitor's right). */
const ANGLES: Record<LookTarget, LookAngles> = {
  viewer: { yaw: 0, pitch: -0.02 },
  panel: { yaw: 0.45, pitch: -0.08 },
  amount: { yaw: 0.42, pitch: 0.02 },
  toggle: { yaw: 0.4, pitch: 0.08 },
  rate: { yaw: 0.46, pitch: -0.12 },
  cta: { yaw: 0.44, pitch: -0.28 },
  entry: { yaw: 0.5, pitch: 0.32 },
  pointer: { yaw: 0.2, pitch: -0.05 },
  title: { yaw: -0.5, pitch: 0.12 },
  reading: { yaw: 0.05, pitch: -0.3 },
  exit: { yaw: 0.1, pitch: 0.34 },
};

/** A small seeded generator, so the stills are the same stills every time. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The pose `seconds` after `cues` are sent — each at its own offset — to a robot that has settled at rest. */
function moment(cues: readonly { readonly at: number; readonly cue: RobotCue }[], seconds: number, focus: RobotFocus = 'none'): Pose {
  const robot = new RobotBehaviour({ direction: 'SELL_USDT', random: seeded(3), playful: false });
  let time = 0;
  let pose = REST_POSE;
  const run = (until: number) => {
    while (time < until - 1e-9) {
      time += FRAME;
      pose = robot.update({ time, dt: FRAME, focus: time > 3 ? focus : 'none', angles: (t) => ANGLES[t] });
    }
  };
  run(3);
  const start = time;
  for (const { at, cue } of cues) {
    run(start + at);
    robot.cue(cue, time);
  }
  run(start + seconds);
  return pose;
}

const SHEET: Record<string, Pose> = {
  // Concern: the tip lit, the head tilted away — a deal gone wrong in a chat.
  worried: moment([{ at: 0, cue: { kind: 'problem' } }], 1.6),
  // Delight: hearts, a deal done here.
  love: moment([{ at: 0, cue: { kind: 'submitted' } }], 1.4),
  // Goodbye: mid-wave, smiling.
  wave: moment([{ at: 0, cue: { kind: 'engage' } }], 0.95),
  // A wink beside the questions.
  wink: { ...REST_POSE, wink: 1, headRoll: 0.08, headYaw: -0.05 },
};

const root = mkdtempSync(path.join(tmpdir(), 'inrp2p-robot-landing-'));
writeFileSync(
  path.join(root, 'index.html'),
  `<!doctype html>
<html>
  <body style="margin:0;background:transparent">
    <script type="module">
      import { RobotScene } from '/@fs${path.join(ROBOT, 'scene.ts')}';
      const poses = ${JSON.stringify(SHEET)};
      const draw = (pose) => new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'display:block;width:${RENDER_SIZE}px;height:${RENDER_SIZE}px';
        document.body.replaceChildren(canvas);
        const scene = new RobotScene({
          canvas,
          scope: null,
          direction: 'SELL_USDT',
          still: true,
          pose,
          // Scaled down in the same task as the draw, while the drawing buffer is still intact.
          onFirstFrame: () => {
            const out = document.createElement('canvas');
            out.width = ${SIZE};
            out.height = ${SIZE};
            const ctx = out.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(canvas, 0, 0, ${SIZE}, ${SIZE});
            queueMicrotask(() => scene.dispose());
            resolve(out.toDataURL('image/webp', 0.9));
          },
        });
      });
      const images = {};
      for (const [name, pose] of Object.entries(poses)) images[name] = await draw(pose);
      window.sheet = images;
    </script>
  </body>
</html>`,
);

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { port: 0, host: '127.0.0.1', fs: { allow: [REPO, root] } },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('vite did not report a port');

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: RENDER_SIZE, height: RENDER_SIZE }, deviceScaleFactor: 1 });
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') failures.push(m.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.waitForFunction(() => 'sheet' in window, null, { timeout: 240_000 });
  if (failures.length) throw new Error(`the robot did not render cleanly:\n${failures.join('\n')}`);
  const images = await page.evaluate(() => (window as unknown as { sheet: Record<string, string> }).sheet);
  mkdirSync(OUT, { recursive: true });
  for (const [name, data] of Object.entries(images)) {
    if (!data.startsWith('data:image/webp;base64,')) throw new Error(`no WebP for ${name}`);
    const file = path.join(OUT, `robot-${name}.webp`);
    const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
    writeFileSync(file, bytes);
    console.log(`${path.relative(process.cwd(), file)}  ${Math.round(bytes.length / 1024)} KB`);
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
