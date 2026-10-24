import { type Page, type Request, expect, test } from '@playwright/test';
import { signIn, state } from './support.ts';

/**
 * Moving around the desk (performance). Two promises, each checked against the built app:
 *
 * 1. A click is answered at once, whatever the server is doing. The rail's pill moves and the section's shape is drawn
 *    on the click; the page arrives into it. Checked with the server's answer held back on purpose, so a router that
 *    waits for the server before showing anything fails here however fast the server happens to be.
 * 2. Every section arrives within a budget, with one request to the server per click. The budget is generous — it
 *    catches the regressions that cost seconds (a check that reaches a far database, a read per row), not milliseconds.
 */

const SECTIONS: readonly string[] = ['Exceptions', 'Orders', 'Rates', 'INR accounts', 'USDT treasury', 'Network budget', 'Traders', 'Desks', 'Clients', 'P&L', 'Revenue', 'System health', 'Desk'];

/**
 * A click to content, at most. React holds a revealed page back until the loading shape has been on screen for
 * 300 ms (so it never flashes), so even an instant answer takes about that long; the rest is headroom for CI.
 */
const SECTION_BUDGET_MS = 1500;

const rail = (page: Page, label: string) => page.getByRole('navigation', { name: 'Desk sections' }).locator(`a[title^="${label} (g then"]`);
const heading = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true });
const isNavigation = (r: Request) => Boolean(r.headers()['rsc']) && !r.headers()['next-router-prefetch'];

test('the desk answers a click at once and every section arrives within its budget', async ({ page }) => {
  test.slow();
  const s = state();
  await signIn(page, s.owner);
  await page.waitForLoadState('networkidle');

  await test.step('a section opens on the click, before the server has answered', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/rates\?_rsc=/, async (route) => {
      if (isNavigation(route.request())) await held;
      await route.continue();
    });

    const clicked = Date.now();
    await rail(page, 'Rates').click();
    await expect(page.getByLabel('Loading')).toBeVisible();
    await expect(rail(page, 'Rates')).toHaveAttribute('aria-current', 'page');
    const answered = Date.now() - clicked;
    // The server has not been asked yet (the request is held): what the operator saw came from the click alone.
    expect(answered).toBeLessThan(500);
    await expect(heading(page, 'Rates')).toHaveCount(0);

    release();
    await expect(heading(page, 'Rates')).toBeVisible();
    await expect(page.getByLabel('Loading')).toHaveCount(0);
    await page.unroute(/\/rates\?_rsc=/);
  });

  await test.step('a tab keeps the page on screen and says it took the click', async () => {
    await rail(page, 'Orders').click();
    await expect(heading(page, 'Orders')).toBeVisible();
    await page.waitForLoadState('networkidle');

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/orders\?.*_rsc=/, async (route) => {
      if (isNavigation(route.request())) await held;
      await route.continue();
    });
    const tabs = page.getByRole('navigation', { name: 'Trade state' });
    await tabs.getByRole('link', { name: /^All/ }).click();
    // Only the page's query changed: the figures stay until the new ones are read, and no loading shape replaces them.
    await expect(tabs.getByRole('link', { name: /^All/ }).locator('[class*="linkPending"]')).toBeVisible();
    await expect(heading(page, 'Orders')).toBeVisible();
    await expect(page.getByLabel('Loading')).toHaveCount(0);

    release();
    await expect(tabs.getByRole('link', { name: /^All/ })).toHaveAttribute('aria-current', 'page');
    await page.unroute(/\/orders\?.*_rsc=/);
  });

  await test.step('every section, one request each, within the budget', async () => {
    const timings: Record<string, number> = {};
    for (const section of SECTIONS) {
      await page.waitForLoadState('networkidle');
      const navigations: string[] = [];
      const onRequest = (r: Request) => {
        if (isNavigation(r)) navigations.push(r.url());
      };
      page.on('request', onRequest);
      const clicked = Date.now();
      await rail(page, section).click();
      await expect(heading(page, section)).toBeVisible();
      timings[section] = Date.now() - clicked;
      page.off('request', onRequest);
      expect(navigations, `${section}: one request to the server for one click`).toHaveLength(1);
    }
    test.info().annotations.push({ type: 'section timings (ms)', description: JSON.stringify(timings) });
    for (const [section, ms] of Object.entries(timings)) expect(ms, `${section} took ${ms} ms`).toBeLessThan(SECTION_BUDGET_MS);
  });
});
