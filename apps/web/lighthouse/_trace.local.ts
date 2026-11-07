// Throwaway: the same measurement as run.ts, keeping each run's LHR and trace. Never committed.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import lighthouse from 'lighthouse';
import { chromium } from '@playwright/test';
import { deskBaseUrl, startDesk, surfacePorts } from '../harness/desk-server.ts';
import { CLIENT_AUTH_SECRET, OPERATOR_AUTH_SECRET, VISUAL_CUSTODY_PROVIDER, VISUAL_FIELD_KEYS, seedVisual } from '../visual/world.ts';

const OUT = process.env.TRACE_OUT!;
mkdirSync(OUT, { recursive: true });
const RUNS = Number.parseInt(process.env.LIGHTHOUSE_RUNS ?? '3', 10);
const CHROME = process.env.LIGHTHOUSE_CHROME ?? chromium.executablePath();
const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0'];
async function launchChrome() {
  const proc = spawn(CHROME, [...CHROME_FLAGS, '--user-data-dir=/tmp/inrp2p-lighthouse-profile', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no port\n${buffer}`)), 30_000);
    const onData = (d: Buffer) => { buffer += d.toString(); const m = buffer.match(/ws:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(Number.parseInt(m[1]!, 10)); } };
    proc.stderr.on('data', onData); proc.stdout.on('data', onData);
  });
  return { port, kill: () => proc.kill('SIGTERM') };
}
const adminUrl = process.env.TEST_DATABASE_URL!;
const base = Number.parseInt(process.env.LIGHTHOUSE_PORT ?? '3340', 10);
const ports = surfacePorts(base);
const state = await seedVisual(adminUrl);
const stop = await startDesk({ port: base, databaseUrl: state.databaseUrl, operatorAuthSecret: OPERATOR_AUTH_SECRET, clientAuthSecret: CLIENT_AUTH_SECRET, surfaces: ['public'], fieldKeys: VISUAL_FIELD_KEYS, custodyProvider: VISUAL_CUSTODY_PROVIDER, label: 'lh' });
try {
  const url = `${deskBaseUrl(ports.public)}/`;
  for (let i = 1; i <= RUNS; i++) {
    const chrome = await launchChrome();
    try {
      const run = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error', formFactor: 'mobile', screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } });
      if (!run) throw new Error('none');
      writeFileSync(`${OUT}/lhr-${i}.json`, JSON.stringify(run.lhr));
      writeFileSync(`${OUT}/trace-${i}.json`, JSON.stringify((run.artifacts as any).Trace ?? (run.artifacts as any).traces?.defaultPass ?? {}));
      const a = run.lhr.audits;
      console.log(`run ${i}: perf ${Math.round(run.lhr.categories.performance!.score! * 100)} FCP ${a['first-contentful-paint']!.displayValue} LCP ${a['largest-contentful-paint']!.displayValue} TBT ${a['total-blocking-time']!.displayValue} SI ${a['speed-index']!.displayValue} TTI ${a['interactive']?.displayValue} CLS ${a['cumulative-layout-shift']!.displayValue}`);
    } finally { chrome.kill(); }
  }
} finally { await stop(); }
process.exit(0);
