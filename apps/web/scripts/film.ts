import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from '@playwright/test';
import { createServer } from 'vite';

/**
 * "Three Arcs", the flagship film (`apps/web/film`): previewed in a browser, or rendered to a video file.
 *
 *   pnpm --filter @inrp2p/web film:preview                       # a local page with the film, a scrubber and sound
 *   pnpm --filter @inrp2p/web film:render -- --out three-arcs.mp4 # every frame, the soundtrack, encoded
 *   pnpm --filter @inrp2p/web film:stills -- --at 3,9.5,20.5 --out stills  # chosen moments, as PNGs
 *
 * Rendering draws the film one frame at a time, in software WebGL (the same result on any machine), with the robot
 * moved exactly as far as each frame asks: a slow frame is the same frame. It photographs each, renders the
 * soundtrack offline in the same page, and encodes both with ffmpeg as H.264 and AAC — `FFMPEG` names the binary
 * when it is not on the PATH. `--from` and `--to` (seconds) render a part; `--frames <dir>` keeps the stills.
 */
const APP = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(APP, '../..');
const FILM = path.join(APP, 'film');

const [mode = 'preview', ...rest] = process.argv.slice(2).filter((a) => a !== '--');
const option = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const server = await createServer({
  root: FILM,
  configFile: false,
  logLevel: 'error',
  // The app compiles its JSX with Next; here Vite does, with React's automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: { alias: { 'node:crypto': path.join(FILM, 'node-crypto.ts') } },
  server: {
    port: mode === 'preview' ? Number(option('port') ?? 5178) : 0,
    host: '127.0.0.1',
    fs: { allow: [REPO] },
    // A render is a fixed snapshot of the source: an edit saved mid-render must not reload the page under it.
    ...(mode === 'preview' ? {} : { hmr: false, watch: null }),
  },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === 'string') throw new Error('vite did not report a port');
const origin = `http://127.0.0.1:${address.port}`;

if (mode === 'preview') {
  console.log(`Three Arcs: ${origin}/  (the stage alone: ${origin}/film.html)`);
} else if (mode === 'render' || mode === 'stills') {
  try {
    await (mode === 'render' ? render() : stills());
  } finally {
    await server.close();
  }
} else {
  await server.close();
  throw new Error(`unknown mode "${mode}": preview, render or stills`);
}

/** The film's page in software WebGL at 1920 × 1080, loaded and ready, with anything it reports as an error collected. */
async function open(browser: Browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') failures.push(m.text());
  });
  await page.goto(`${origin}/film.html`);
  await page.waitForFunction(() => 'film' in window, null, { timeout: 120_000 });
  await page.evaluate(() => window.film.ready);
  if (failures.length) throw new Error(`the film did not load cleanly:\n${failures.join('\n')}`);
  return { page, failures };
}

function launch() {
  return chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
}

async function stills(): Promise<void> {
  const out = path.resolve(option('out') ?? 'film-stills');
  const times = (option('at') ?? '0').split(',').map(Number).sort((a, b) => a - b);
  mkdirSync(out, { recursive: true });
  const browser = await launch();
  try {
    const { page, failures } = await open(browser);
    for (const t of times) {
      await page.evaluate((at) => window.film.seek(at), t);
      const file = path.join(out, `t${t.toFixed(2).padStart(5, '0')}.png`);
      await page.screenshot({ path: file, animations: 'allow', caret: 'initial' });
      if (failures.length) throw new Error(`the film failed at ${t} s:\n${failures.join('\n')}`);
      console.log(path.relative(process.cwd(), file));
    }
  } finally {
    await browser.close();
  }
}

async function render(): Promise<void> {
  const out = path.resolve(option('out') ?? path.join(REPO, 'three-arcs.mp4'));
  const keep = option('frames');
  const frames = keep ? path.resolve(keep) : mkdtempSync(path.join(tmpdir(), 'inrp2p-film-'));
  mkdirSync(frames, { recursive: true });
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';

  const browser = await launch();
  let encodedOk = false;
  try {
    const { page, failures } = await open(browser);
    const { duration, fps } = await page.evaluate(() => ({ duration: window.film.duration, fps: window.film.fps }));
    const first = Math.round(Number(option('from') ?? 0) * fps);
    const last = Math.round(Number(option('to') ?? duration) * fps);
    const started = Date.now();
    for (let i = first; i < last; i++) {
      await page.evaluate((t) => window.film.seek(t), i / fps);
      await page.screenshot({ path: path.join(frames, `${String(i - first).padStart(5, '0')}.png`), animations: 'allow', caret: 'initial' });
      if ((i - first) % fps === 0) {
        const done = i - first + 1;
        const per = (Date.now() - started) / done / 1000;
        console.log(`frame ${i}/${last}  ${(i / fps).toFixed(1)} s  ${per.toFixed(2)} s/frame  ~${Math.round((per * (last - i)) / 60)} min left`);
      }
      if (failures.length) throw new Error(`the film failed at ${(i / fps).toFixed(2)} s:\n${failures.join('\n')}`);
    }

    const wav = await page.evaluate(() => window.film.soundtrack());
    const sound = path.join(frames, 'soundtrack.wav');
    writeFileSync(sound, Buffer.from(wav, 'base64'));

    const offset = (first / fps).toFixed(3);
    const encoded = spawnSync(
      ffmpeg,
      [
        '-y',
        '-loglevel', 'error',
        '-framerate', String(fps),
        '-i', path.join(frames, '%05d.png'),
        '-ss', offset,
        '-t', ((last - first) / fps).toFixed(3),
        '-i', sound,
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '14',
        '-pix_fmt', 'yuv420p',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'aac',
        '-b:a', '256k',
        '-movflags', '+faststart',
        '-shortest',
        out,
      ],
      { stdio: 'inherit' },
    );
    if (encoded.status !== 0) throw new Error(`ffmpeg failed (set FFMPEG to an ffmpeg with libx264); the frames are in ${frames}`);
    encodedOk = true;
    console.log(`${path.relative(process.cwd(), out)}  ${last - first} frames at ${fps} fps`);
  } finally {
    await browser.close();
    // The frames are kept when anything failed, so a long render is not lost to an encoder that was missing.
    if (!keep && encodedOk) rmSync(frames, { recursive: true, force: true });
  }
}
