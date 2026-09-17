import { defineConfig, devices } from '@playwright/test';

import { UPDATE_REQUESTED } from './environment.ts';

const PORT = 6007;

// Compare-only unless an intentional update is requested via UPDATE_VISUALS=1 (docs/VISUAL_BASELINES.md).
if (!UPDATE_REQUESTED && process.argv.some((a) => a === '-u' || a.startsWith('--update-snapshots'))) {
  throw new Error('Use UPDATE_VISUALS=1 (canonical environment only) instead of --update-snapshots.');
}

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  globalSetup: './global-setup.ts',
  updateSnapshots: UPDATE_REQUESTED ? 'all' : 'none',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report' }], ['./metadata-reporter.ts']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixelRatio: 0.002, threshold: 0.2 },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: {
    command: `node serve.ts`,
    cwd: import.meta.dirname,
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
