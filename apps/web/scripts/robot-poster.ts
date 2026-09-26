import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

/**
 * Renders the robot's still images: what the hero shows on first paint, before the live robot has loaded, and
 * instead of it for reduced motion, Save-Data and browsers that can only draw WebGL in software.
 *
 *   pnpm --filter @inrp2p/web poster:robot
 *
 * The images are rendered by the live robot's own scene code in its rest pose, so the hand-over from still to
 * live cannot be seen — which only stays true if this is re-run after any change to the robot's shape,
 * materials, lighting or framing. Commit the images it writes.
 *
 * It renders once, large, in software WebGL (the same result on any machine), and scales down in the browser.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const ROBOT = path.join(APP, 'src/app/(public)/_landing/robot');
const OUT = path.join(ROBOT, 'poster');
const RENDER_SIZE = 1600;
const SIZES = [1600, 1080, 720] as const;

const root = mkdtempSync(path.join(tmpdir(), 'inrp2p-robot-poster-'));
writeFileSync(
  path.join(root, 'index.html'),
  `<!doctype html>
<html>
  <body style="margin:0;background:transparent">
    <canvas id="robot" style="display:block;width:${RENDER_SIZE}px;height:${RENDER_SIZE}px"></canvas>
    <script type="module">
      import { RobotScene } from '/@fs${path.join(ROBOT, 'scene.ts')}';
      const canvas = document.getElementById('robot');
      const encode = () => {
        const images = {};
        for (const size of ${JSON.stringify(SIZES)}) {
          const out = document.createElement('canvas');
          out.width = size;
          out.height = size;
          const ctx = out.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(canvas, 0, 0, size, size);
          images[size] = out.toDataURL('image/webp', 0.86);
        }
        return images;
      };
      new RobotScene({
        canvas,
        scope: null,
        direction: 'SELL_USDT',
        still: true,
        // Read in the same task as the draw, while the drawing buffer is still intact.
        onFirstFrame: () => { window.poster = encode(); },
      });
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
  await page.waitForFunction(() => 'poster' in window, null, { timeout: 120_000 });
  if (failures.length) throw new Error(`the robot did not render cleanly:\n${failures.join('\n')}`);
  const images = await page.evaluate(() => (window as unknown as { poster: Record<string, string> }).poster);
  mkdirSync(OUT, { recursive: true });
  for (const size of SIZES) {
    const data = images[size];
    if (!data?.startsWith('data:image/webp;base64,')) throw new Error(`no WebP at ${size}px`);
    const file = path.join(OUT, `robot-${size}.webp`);
    const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
    writeFileSync(file, bytes);
    console.log(`${path.relative(REPO, file)}  ${Math.round(bytes.length / 1024)} KB`);
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(root, { recursive: true, force: true });
}
