import { expect, test } from '@playwright/test';
import { deskBaseUrl, surfacePorts } from '../harness/desk-server.ts';
import { CLIENT_AUTH_FILE } from './auth.ts';
import { FIXED_TIME, capture, closeFixtureDb, state } from './support.ts';

/**
 * The client validation list, captured from the **built** pages (IMPLEMENTATION_PLAN Phase 7 exit).
 *
 * Same fixture world and same canonical environment as the operator list, on the client surface and under a
 * session the product itself issued. Every state was driven there by real commands, so a baseline can only move
 * when the product moves.
 */
const APP = deskBaseUrl(surfacePorts(Number.parseInt(process.env.VISUAL_PORT ?? '3220', 10)).app);

test.use({ storageState: CLIENT_AUTH_FILE, baseURL: APP });
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
});

test.afterAll(async () => {
  await closeFixtureDb();
});

test('exchange: the firm quote, counting down', async ({ page }) => {
  await page.goto('/exchange');
  await expect(page.getByRole('heading', { name: 'Exchange', exact: true })).toBeVisible();
  await expect(page.getByLabel('Firm quote')).toBeVisible();
  await capture(page, 'client-exchange-quote');
});

test('trade: accepted, waiting for the client’s USDT', async ({ page }) => {
  await page.goto(`/trades/${state().tradeRefs.awaitingDeposit}`);
  await expect(page.getByLabel('Trade progress')).toBeVisible();
  await expect(page.getByText(/Send exactly/)).toBeVisible();
  await capture(page, 'client-trade-awaiting-usdt');
});

test('trade: funded, INR going out', async ({ page }) => {
  await page.goto(`/trades/${state().tradeRefs.awaitingPayout}`);
  await expect(page.getByRole('region', { name: 'INR settlement' })).toBeVisible();
  await capture(page, 'client-trade-settling');
});

test('trade: settled in full', async ({ page }) => {
  await page.goto(`/trades/${state().tradeRefs.completed}`);
  await expect(page.getByLabel('Trade progress')).toBeVisible();
  await capture(page, 'client-trade-completed');
});

test('history', async ({ page }) => {
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await capture(page, 'client-history');
});

test('accounts: where the money is allowed to go', async ({ page }) => {
  await page.goto('/accounts');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await capture(page, 'client-accounts');
});

test('notifications', async ({ page }) => {
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await capture(page, 'client-notifications');
});

/*
 * There is deliberately **no** page baseline for the settlement receipt.
 *
 * Every capture in this suite asserts that all of its text is drawn in the bundled Geist (VISUAL_BASELINES §4),
 * which is what makes a page baseline reproducible on another machine. The receipt is the one document that must
 * not depend on a bundled font: it is printed, saved and reopened on machines this system will never see, so it
 * asks for the system's own sans-serif and fetches nothing. Capturing it here would either fail that rule or
 * force the rule to be loosened for every page.
 *
 * What the receipt needs proving about is proved where it can be: `packages/reporting/test/print.unit.test.ts`
 * checks the grayscale-safe palette, the contrast of every ink against both papers, the print stylesheet, and
 * that the document fetches no image, font or stylesheet at all.
 */
