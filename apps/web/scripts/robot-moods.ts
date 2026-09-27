import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { type LookAngles, type LookTarget, type Pose, REST_POSE, RobotBehaviour } from '../src/app/(public)/_landing/robot/behaviour.ts';
import type { RobotMood } from '../src/app/(public)/_landing/robot/cues.ts';

/**
 * Renders the workspace's still robots: one per mood, shown wherever the live robot does not run — a phone, reduced
 * motion, Save-Data, software-only WebGL — so the robot still shows the state of record there.
 *
 *   pnpm --filter @inrp2p/web robot:moods
 *
 * Every still is a real moment of the live robot held in that mood, taken after the same number of seconds each
 * time, with the page to its left as it stands in the workspace (mirrored). Rendered by the live robot's own scene
 * in software WebGL (the same result on any machine) and written as WebP with transparency, next to the component
 * that shows them. Re-run after any change to the robot's shape, materials, lighting, framing or held states, and
 * commit the images it writes.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const ROBOT = path.join(APP, 'src/app/(public)/_landing/robot');
const OUT = path.join(APP, 'src/app/(client)/_assistant/stills');
const RENDER_SIZE = 1200;
const SIZE = 640;
const FRAME = 1 / 60;

/** Where things are, as seen from the robot's head in the workspace: the page to its right (the visitor's left). */
const ANGLES: Record<LookTarget, LookAngles> = {
  viewer: { yaw: 0, pitch: -0.02 },
  panel: { yaw: -0.45, pitch: -0.1 },
  amount: { yaw: -0.42, pitch: -0.02 },
  toggle: { yaw: -0.4, pitch: 0.08 },
  rate: { yaw: -0.42, pitch: -0.06 },
  cta: { yaw: -0.42, pitch: -0.28 },
  entry: { yaw: 0, pitch: 0.32 },
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

/** The pose `seconds` after a settled robot is told the page is in `mood`. */
function held(mood: RobotMood, seconds: number): Pose {
  const robot = new RobotBehaviour({ direction: 'SELL_USDT', mirror: true, random: seeded(3) });
  let time = 0;
  let pose = REST_POSE;
  const run = (until: number) => {
    while (time < until - 1e-9) {
      time += FRAME;
      pose = robot.update({ time, dt: FRAME, focus: 'none', angles: (t) => ANGLES[t] });
    }
  };
  run(3);
  robot.cue({ kind: 'mood', mood }, time);
  run(time + seconds);
  return pose;
}

/** Each mood once its arrival has passed, so the still is the state as it holds — not the moment it began. */
const MOODS: Record<RobotMood, Pose> = {
  none: REST_POSE,
  ready: held('ready', 4),
  waiting: held('waiting', 2.05),
  focused: held('focused', 2.5),
  // Between two passes of the reading band, so the eyes are shown narrowed and even.
  verifying: held('verifying', 1.25),
  success: held('success', 6),
  alert: held('alert', 3),
};

const root = mkdtempSync(path.join(tmpdir(), 'inrp2p-robot-moods-'));
writeFileSync(
  path.join(root, 'index.html'),
  `<!doctype html>
<html>
  <body style="margin:0;background:transparent">
    <script type="module">
      import { RobotScene } from '/@fs${path.join(ROBOT, 'scene.ts')}';
      const poses = ${JSON.stringify(MOODS)};
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
      window.moods = images;
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
  await page.waitForFunction(() => 'moods' in window, null, { timeout: 240_000 });
  if (failures.length) throw new Error(`the robot did not render cleanly:\n${failures.join('\n')}`);
  const images = await page.evaluate(() => (window as unknown as { moods: Record<string, string> }).moods);
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
