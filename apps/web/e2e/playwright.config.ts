import { defineConfig, devices } from '@playwright/test';
import { deskBaseUrl, surfacePorts } from '../harness/desk-server.ts';

/**
 * End-to-end run of the operator product (IMPLEMENTATION_PLAN Phase 6 exit). It drives the **built** app against
 * a real PostgreSQL database — the same migrations, the same commands, the same authorization — because a desk
 * that works against mocks proves nothing about money.
 *
 * `TEST_DATABASE_URL` points at a server where the run may create its own database. The world is seeded and the
 * desk started by `global-setup.ts`, in that order, so the app never connects to a database about to be dropped.
 */
const PORT = Number.parseInt(process.env.E2E_PORT ?? '3210', 10);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: deskBaseUrl(surfacePorts(PORT).desk),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desk', testMatch: /(demo|finance|keyboard)\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    // The client product is opened on a phone: the quote link arrives by message, and the trade is followed from
    // the same device. Running it on a real mobile device profile is the point, not a detail of the profile.
    { name: 'client-mobile', testMatch: /client\.spec\.ts/, use: { ...devices['Pixel 7'] } },
  ],
});
