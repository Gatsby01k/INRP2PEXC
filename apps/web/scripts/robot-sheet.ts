import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { type LookAngles, type LookTarget, type Pose, REST_POSE, RobotBehaviour } from '../src/app/(public)/_landing/robot/behaviour.ts';
import type { RobotCue } from '../src/app/(public)/_landing/robot/cues.ts';

/**
 * Renders the robot's sheet: its rest pose and each of its five expressions, as stills.
 *
 *   pnpm --filter @inrp2p/web robot:sheet <folder>
 *
 * Every still is a real moment of the live robot, not a pose drawn for the occasion: the behaviour is run, the event
 * that starts each state is sent, and the pose it produces is taken after the same number of seconds each time — so
 * the sheet shows what a visitor sees, and changes when the robot does. The module and the masthead are placed where
 * they sit in the hero, so every look goes where it goes on the page. Rendered by the live robot's own scene, in
 * software WebGL (the same result on any machine), as WebP with transparency.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const ROBOT = path.join(APP, 'src/app/(public)/_landing/robot');
const SIZE = 1200;
const FRAME = 1 / 60;

const out = process.argv[2];
if (!out) throw new Error('usage: robot:sheet <folder>');
const OUT = path.resolve(process.cwd(), out);

/** Where things are, as seen from the robot's head in the hero: the module to its left (the visitor's right). */
const ANGLES: Record<LookTarget, LookAngles> = {
  viewer: { yaw: 0, pitch: -0.02 },
  panel: { yaw: 0.45, pitch: -0.08 },
  amount: { yaw: 0.42, pitch: 0.02 },
  toggle: { yaw: 0.4, pitch: 0.08 },
  rate: { yaw: 0.46, pitch: -0.12 },
  cta: { yaw: 0.44, pitch: -0.28 },
  entry: { yaw: 0.5, pitch: 0.32 },
};

/** A small seeded generator, so the sheet is the same sheet every time. */
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
function moment(cues: readonly { readonly at: number; readonly cue: RobotCue }[], seconds: number): Pose {
  const robot = new RobotBehaviour({ direction: 'SELL_USDT', random: seeded(3) });
  let time = 0;
  let pose = REST_POSE;
  const run = (until: number) => {
    while (time < until - 1e-9) {
      time += FRAME;
      pose = robot.update({ time, dt: FRAME, focus: 'none', angles: (t) => ANGLES[t] });
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

/** Typing an amount: a keystroke every fifth of a second for as long as asked. */
const typing = (seconds: number) => Array.from({ length: Math.round(seconds / 0.2) }, (_, i) => ({ at: i * 0.2, cue: { kind: 'value' } as const }));

const SHEET: Record<string, Pose> = {
  rest: REST_POSE,
  welcome: moment([{ at: 0, cue: { kind: 'engage' } }], 0.75),
  // Between two passes of the reading band, so the eyes are shown narrowed and even.
  verifying: moment(typing(1.4), 1.25),
  waiting: moment([{ at: 0, cue: { kind: 'wait', on: true } }], 2.05),
  success: moment([{ at: 0, cue: { kind: 'submitted' } }], 1.4),
  alert: moment([{ at: 0, cue: { kind: 'problem' } }], 1.5),
};

const root = mkdtempSync(path.join(tmpdir(), 'inrp2p-robot-sheet-'));
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
        canvas.style.cssText = 'display:block;width:${SIZE}px;height:${SIZE}px';
        document.body.replaceChildren(canvas);
        const scene = new RobotScene({
          canvas,
          scope: null,
          direction: 'SELL_USDT',
          still: true,
          pose,
          // Read in the same task as the draw, while the drawing buffer is still intact.
          onFirstFrame: () => {
            const image = canvas.toDataURL('image/webp', 0.9);
            queueMicrotask(() => scene.dispose());
            resolve(image);
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
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
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
