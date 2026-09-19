import { expect, test } from '@playwright/test';
import { FIXED_TIME, capture, closeFixtureDb, expireStepUp, openPanel, state } from './support.ts';

/**
 * The operator validation list, captured from the **built** pages (IMPLEMENTATION_PLAN Phase 6 exit).
 *
 * Every capture is a state the fixture world was driven into by real commands, so a baseline can only change
 * when the product changes. The suite runs serially in one signed-in browser, because signing in is part of the
 * product and re-doing it eleven times proves nothing.
 */
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
});

test.afterAll(async () => {
  await closeFixtureDb();
});

test('desk: operational strip and grouped queue', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Operational status')).toBeVisible();
  await expect(page.getByTestId('desk-queue')).toBeVisible();
  await capture(page, 'operator-desk');
});

test('desk: trade context panel', async ({ page }) => {
  const s = state();
  await openPanel(page, `trade:${s.trades.awaitingPayout}`, 'payout');
  await expect(page.getByTestId('payout-panel')).toBeVisible();
  await capture(page, 'operator-trade-panel');
});

test('desk: payout panel on a direct route, with the payer selector', async ({ page }) => {
  const s = state();
  await openPanel(page, `trade:${s.trades.directRoute}`, 'payout');
  const panel = page.getByTestId('payout-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('radiogroup', { name: 'Pay from' })).toBeVisible();
  await capture(page, 'operator-payout-direct-route');
});

test('desk: blocking exception', async ({ page }) => {
  const s = state();
  await openPanel(page, `trade:${s.trades.shortPaid}`, 'exception');
  await expect(page.getByTestId('exception-panel')).toBeVisible();
  await capture(page, 'operator-exception');
});

test('orders', async ({ page }) => {
  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'Orders' })).toBeVisible();
  await capture(page, 'operator-orders');
});

test('rates and route positions', async ({ page }) => {
  await page.goto('/rates');
  await expect(page.getByTestId('route-positions')).toBeVisible();
  await capture(page, 'operator-rates');
});

test('inr accounts', async ({ page }) => {
  await page.goto('/inr');
  await expect(page.getByRole('heading', { name: 'INR' })).toBeVisible();
  await capture(page, 'operator-inr');
});

test('usdt treasury, deposit pool and scanner state', async ({ page }) => {
  await page.goto('/usdt');
  await expect(page.getByRole('heading', { name: 'USDT' })).toBeVisible();
  await expect(page.getByText(/Scanner at block/)).toBeVisible();
  await capture(page, 'operator-usdt');
});

test('clients', async ({ page }) => {
  await page.goto('/clients');
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
  await capture(page, 'operator-clients');
});

test('command bar', async ({ page }) => {
  const s = state();
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(bar).toBeVisible();
  // The whole reference: the bar matches a trade by its exact ref, and a client by the start of their name.
  await page.keyboard.type(s.tradeRefs.completed);
  await expect(bar.getByRole('option').first()).toBeVisible();
  await capture(page, 'operator-command-bar', bar);
});

test('step-up dialog', async ({ page }) => {
  const s = state();
  await expireStepUp();
  await openPanel(page, `trade:${s.trades.awaitingPayout}`, 'payout');
  const legs = page.getByTestId('legs');
  await expect(legs).toBeVisible();
  await legs.getByRole('button', { name: /^Confirm/ }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Verify to continue' });
  await expect(dialog).toBeVisible();
  await capture(page, 'operator-step-up', dialog);
});
