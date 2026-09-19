import { defineConfig, devices } from '@playwright/test';
import { AUTH_FILE } from './auth.ts';
import { SCREENSHOT_DIR, SELF_CHECK, UPDATE_REQUESTED } from './environment.ts';

/**
 * Pixel baselines for the **built** operator product (IMPLEMENTATION_PLAN Phase 6 exit). The component gallery
 * proves the parts look right; this proves the pages an operator actually works look right — a panel that
 * overflows, a column that collapses at 1440px or a figure that wraps mid-number is a regression no behavioural
 * test would catch.
 *
 * Compare-only unless an intentional update is requested via `UPDATE_VISUALS=1`, and only ever inside the
 * canonical environment (`docs/VISUAL_BASELINES.md`).
 */
const PORT = Number.parseInt(process.env.VISUAL_PORT ?? '3220', 10);

if (!UPDATE_REQUESTED && process.argv.some((a) => a === '-u' || a.startsWith('--update-snapshots'))) {
  throw new Error('Use UPDATE_VISUALS=1 (canonical environment only) instead of --update-snapshots.');
}

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  forbidOnly: Boolean(process.env.CI),
  // 'none' is the rule: a missing or different baseline fails. A self-check writes its own scratch captures on
  // the first pass so a second pass can prove they are reproducible; it never touches the committed baselines.
  updateSnapshots: UPDATE_REQUESTED ? 'all' : SELF_CHECK ? 'missing' : 'none',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report-visual' }], ['./metadata-reporter.ts']],
  snapshotPathTemplate: `${SCREENSHOT_DIR}/{arg}{ext}`,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixelRatio: 0.002, threshold: 0.2 },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    // One signed-in session for the whole suite (see auth.ts): the desk rate-limits repeated verification.
    storageState: AUTH_FILE,
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
});
