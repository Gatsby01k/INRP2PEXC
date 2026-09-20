import { expect, test } from '@playwright/test';
import { deskBaseUrl, surfacePorts } from '../harness/desk-server.ts';
import { FIXED_TIME, capture, closeFixtureDb, state } from './support.ts';

/**
 * The quote link, captured where it is actually read: on a phone, on the public host, with no session at all.
 *
 * `storageState: undefined` is the point of this file. The link must render for someone who has never signed in
 * — that is the whole premise of D-01 — and a baseline taken with a client cookie in the jar would not prove it.
 */
const PUBLIC = deskBaseUrl(surfacePorts(Number.parseInt(process.env.VISUAL_PORT ?? '3220', 10)).public);

test.use({
  storageState: { cookies: [], origins: [] },
  baseURL: PUBLIC,
  viewport: { width: 390, height: 844 },
  isMobile: false,
  deviceScaleFactor: 1,
});
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
});

test.afterAll(async () => {
  await closeFixtureDb();
});

test('the quote as the link holder sees it', async ({ page }) => {
  await page.goto(`/q/${state().client.linkToken}`);
  await expect(page.getByLabel('Firm quote')).toBeVisible();
  await capture(page, 'link-quote-mobile');
});

test('the code step, which is the only way through', async ({ page }) => {
  await page.goto(`/q/${state().client.linkToken}`);
  await page.getByRole('button', { name: 'Accept quote' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
  await capture(page, 'link-verification-mobile');
});

/**
 * The public site, captured on the same phone viewport as the link.
 *
 * Two pages rather than six: the home page carries the hero, the actions and the steps, and one SEO page
 * carries the shape every other one shares. Capturing all six would make the baseline set six times more
 * expensive to re-record for one change to a shared header, and prove nothing the second page does not.
 */
test('the public home page as a stranger sees it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Buy & sell USDT in India' })).toBeVisible();
  await capture(page, 'public-home-mobile');
});

test('an SEO page, which every other one is shaped like', async ({ page }) => {
  await page.goto('/usdt-to-inr');
  await expect(page.getByRole('heading', { level: 1, name: 'USDT to INR' })).toBeVisible();
  await capture(page, 'public-usdt-to-inr-mobile');
});
