/**
 * Canonical visual-baseline environment (docs/VISUAL_BASELINES.md).
 *
 * Pixel baselines are only comparable when captured by the same browser build, OS, CPU architecture,
 * font stack and rasteriser. The canonical environment is the official Playwright image for the pinned
 * Playwright version, run as linux/amd64 — both in CI and for every intentional baseline update.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

export const SCREENSHOT_DIR = path.resolve(import.meta.dirname, '__screenshots__');
export const METADATA_FILE = path.join(SCREENSHOT_DIR, 'ENVIRONMENT.json');

export function playwrightVersion(): string {
  const pkg = path.resolve(import.meta.dirname, '..', 'node_modules', '@playwright', 'test', 'package.json');
  return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

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

export function readMetadata(): BaselineMetadata | null {
  return existsSync(METADATA_FILE) ? (JSON.parse(readFileSync(METADATA_FILE, 'utf8')) as BaselineMetadata) : null;
}

export const UPDATE_REQUESTED = process.env.UPDATE_VISUALS === '1';
