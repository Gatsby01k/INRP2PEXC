import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import lighthouse from 'lighthouse';
import { chromium } from '@playwright/test';
import { deskBaseUrl, startDesk, surfacePorts } from '../harness/desk-server.ts';
import { CLIENT_AUTH_SECRET, OPERATOR_AUTH_SECRET, VISUAL_CUSTODY_PROVIDER, VISUAL_FIELD_KEYS, seedVisual } from '../visual/world.ts';

/**
 * The quote link's mobile budget (IMPLEMENTATION_PLAN Phase 7 exit).
 *
 * This page is the product for someone who has never signed in: a message arrives, they open it on a phone,
 * probably on mobile data, and a firm price is counting down while it loads. A slow page here is not a polish
 * problem — it is a quote the client could not accept in time. So the budget is measured against the **built**
 * page on a real device profile, not asserted in a review.
 *
 * SEO is measured and printed but not gated: a private quote is deliberately `noindex`, which Lighthouse scores
 * as a failure. Gating on it would mean either lying about the page or making it indexable.
 */
const THRESHOLDS: Record<string, number> = { performance: 90, accessibility: 90, 'best-practices': 90 };
const REPORTED_ONLY = ['seo'];

/**
 * The browser to measure in. Named explicitly, in this order, because "whatever Chrome the machine has" is how a
 * performance number stops being comparable between two runs: the pinned Playwright Chromium is the same build
 * the pixel baselines are taken with.
 */
function chromePath(): string {
  const named = process.env.LIGHTHOUSE_CHROME ?? process.env.CHROME_PATH;
  if (named) return named;
  const preinstalled = '/opt/pw-browsers/chromium';
  if (existsSync(preinstalled)) return preinstalled;
  return chromium.executablePath();
}

const CHROME = chromePath();
const CHROME_FLAGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0'];

async function launchChrome(): Promise<{ port: number; kill: () => void }> {
  const proc = spawn(CHROME, [...CHROME_FLAGS, '--user-data-dir=/tmp/inrp2p-lighthouse-profile', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Chrome did not report a debugging port.\n${buffer}`)), 30_000);
    const onData = (d: Buffer) => {
      buffer += d.toString();
      const match = buffer.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number.parseInt(match[1]!, 10));
      }
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    proc.once('exit', (code) => reject(new Error(`Chrome exited with ${code}\n${buffer}`)));
  });
  return { port, kill: () => proc.kill('SIGTERM') };
}

const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
const port = Number.parseInt(process.env.LIGHTHOUSE_PORT ?? '3240', 10);
const ports = surfacePorts(port);

const state = await seedVisual(adminUrl);
const stop = await startDesk({
  port,
  databaseUrl: state.databaseUrl,
  operatorAuthSecret: OPERATOR_AUTH_SECRET,
  clientAuthSecret: CLIENT_AUTH_SECRET,
  surfaces: ['public'],
  fieldKeys: VISUAL_FIELD_KEYS,
  custodyProvider: VISUAL_CUSTODY_PROVIDER,
  label: 'lighthouse',
});

const url = `${deskBaseUrl(ports.public)}/q/${state.client.linkToken}`;
const failures: string[] = [];
const chrome = await launchChrome();
try {
  // Lighthouse's own mobile defaults: a mid-tier phone, throttled network and CPU. Changing them would make the
  // number easier and meaningless.
  const run = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error', formFactor: 'mobile', screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } });
  if (!run) throw new Error('lighthouse returned no result');
  const categories = run.lhr.categories;
  for (const [id, category] of Object.entries(categories)) {
    const score = Math.round((category.score ?? 0) * 100);
    const threshold = THRESHOLDS[id];
    const verdict = threshold === undefined ? (REPORTED_ONLY.includes(id) ? 'reported only' : 'not gated') : score >= threshold ? 'ok' : `BELOW ${threshold}`;
    console.log(`${category.title.padEnd(16)} ${String(score).padStart(3)}  ${verdict}`);
    if (threshold !== undefined && score < threshold) failures.push(`${category.title} ${score} < ${threshold}`);
  }
  if (failures.length) {
    // The slowest audits are what a person needs to act on, so print them rather than only the score.
    const worst = Object.values(run.lhr.audits)
      .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== 'informative')
      .slice(0, 8)
      .map((a) => `  ${a.title}: ${a.displayValue ?? ''}`);
    console.error(`\nquote link mobile budget not met at ${url}\n${failures.map((f) => `  ${f}`).join('\n')}\n${worst.join('\n')}`);
  }
} finally {
  chrome.kill();
  await stop();
}

process.exit(failures.length ? 1 : 0);
