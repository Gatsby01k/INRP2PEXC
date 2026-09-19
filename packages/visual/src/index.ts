import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from '@playwright/test';

/**
 * The canonical visual-baseline environment and the guard that enforces it (`docs/VISUAL_BASELINES.md`).
 *
 * Pixel baselines are only comparable when captured by the same browser build, OS, CPU architecture, font stack
 * and rasteriser. There is exactly one canonical environment, defined here once so that every pixel suite — the
 * component gallery and the built operator pages — is held to the same line and cannot drift apart.
 */
export const CANONICAL = {
  image: 'mcr.microsoft.com/playwright:v1.56.1-noble',
  platform: 'linux',
  arch: 'x64',
  playwright: '1.56.1',
  chromium: '141.0.7390.37',
} as const;

export interface VisualEnvironment {
  image: string | null;
  platform: string;
  arch: string;
  playwright: string;
  chromium: string;
}

export interface BaselineMetadata extends VisualEnvironment {
  recordedAt: string;
  gitSha: string | null;
  runUrl: string | null;
  baselines: number;
}

/** Recording is requested only by `UPDATE_VISUALS=1`; `--update-snapshots` is refused by each config. */
export const UPDATE_REQUESTED = process.env.UPDATE_VISUALS === '1';

/**
 * A development aid, never a gate: captures into a scratch directory outside the committed baselines so a suite
 * can be written and its states checked on an ordinary machine. It is refused under CI, and what it produces is
 * not a baseline and is never compared against one.
 */
export const SELF_CHECK = process.env.VISUAL_SELFCHECK === '1' && !process.env.CI;

export const HOW =
  'See docs/VISUAL_BASELINES.md: compare/update only inside the canonical image (CI job "visual" / "visual-pages", workflow "Visual baselines (canonical update)", or the repo\'s docker.sh).';

/**
 * `VISUAL_ENV_IMAGE` is set by the CI job / docker script that runs inside the image. It is only trusted
 * together with the image's own marker: browsers preinstalled at /ms-playwright.
 */
export function detectImage(): string | null {
  const declared = process.env.VISUAL_ENV_IMAGE ?? null;
  return declared && existsSync('/ms-playwright') ? declared : null;
}

export function mismatches(env: VisualEnvironment, against: VisualEnvironment = CANONICAL): string[] {
  return (Object.keys(CANONICAL) as Array<keyof VisualEnvironment>)
    .filter((k) => env[k] !== against[k])
    .map((k) => `${k}: expected ${String(against[k])}, got ${String(env[k])}`);
}

/** The Playwright the suite actually runs, resolved from the suite's own directory rather than assumed. */
export function playwrightVersion(fromDir: string): string {
  const resolve = createRequire(path.join(fromDir, 'noop.js')).resolve;
  return (JSON.parse(readFileSync(resolve('@playwright/test/package.json'), 'utf8')) as { version: string }).version;
}

export async function currentEnvironment(fromDir: string): Promise<VisualEnvironment> {
  const browser = await chromium.launch();
  try {
    return { image: detectImage(), platform: process.platform, arch: process.arch, playwright: playwrightVersion(fromDir), chromium: browser.version() };
  } finally {
    await browser.close();
  }
}

export const metadataFile = (screenshotDir: string): string => path.join(screenshotDir, 'ENVIRONMENT.json');

export function readMetadata(screenshotDir: string): BaselineMetadata | null {
  const file = metadataFile(screenshotDir);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as BaselineMetadata) : null;
}

const pngCount = (dir: string): number => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).length : 0);

export function writeMetadata(screenshotDir: string, env: VisualEnvironment): void {
  const server = process.env.GITHUB_SERVER_URL;
  const runUrl =
    server && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const meta: BaselineMetadata = {
    ...env,
    recordedAt: new Date().toISOString(),
    gitSha: process.env.GITHUB_SHA ?? process.env.VISUAL_GIT_SHA ?? null,
    runUrl,
    baselines: pngCount(screenshotDir),
  };
  writeFileSync(metadataFile(screenshotDir), `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Refuses to compare or record pixels anywhere but the canonical environment, and refuses to record at all
 * except through the deliberate update path. Every pixel suite calls this from its global setup.
 *
 * Returns the environment it verified, so a reporter can record it with the baselines.
 */
export async function guardVisualRun(opts: { suite: string; screenshotDir: string; fromDir: string }): Promise<VisualEnvironment | null> {
  if (SELF_CHECK) {
    // Loud, because a self-check proves the suite runs — never that the baselines are right.
    console.warn(
      `\n[${opts.suite}] VISUAL SELF-CHECK: capturing outside the canonical environment.\n` +
        `  These images are NOT baselines and are never compared against the committed ones.\n  ${HOW}\n`,
    );
    return null;
  }

  const env = await currentEnvironment(opts.fromDir);
  const envProblems = mismatches(env);
  if (envProblems.length) {
    throw new Error(`Visual suite "${opts.suite}" refused: not the canonical baseline environment.\n  ${envProblems.join('\n  ')}\n${HOW}`);
  }

  if (UPDATE_REQUESTED) {
    // Ordinary pushes and pull requests are compare-only; only a manual dispatch (or a local docker run) may record.
    const event = process.env.GITHUB_EVENT_NAME;
    if (process.env.CI && event !== 'workflow_dispatch') {
      throw new Error(`UPDATE_VISUALS=1 is not allowed for GitHub event "${event ?? 'unknown'}". ${HOW}`);
    }
    return env;
  }

  const meta = readMetadata(opts.screenshotDir);
  if (!meta) {
    throw new Error(`No canonical baselines for "${opts.suite}": ${metadataFile(opts.screenshotDir)} is missing. ${HOW}`);
  }
  const metaProblems = mismatches(meta, CANONICAL);
  if (metaProblems.length) {
    throw new Error(`Committed baselines for "${opts.suite}" were not recorded in the canonical environment.\n  ${metaProblems.join('\n  ')}\n${HOW}`);
  }
  const pngs = pngCount(opts.screenshotDir);
  if (pngs !== meta.baselines) {
    throw new Error(`Baseline count ${pngs} does not match ENVIRONMENT.json (${meta.baselines}) for "${opts.suite}"; baselines were changed outside the canonical update path. ${HOW}`);
  }
  return env;
}
