import { expect, test } from '@playwright/test';
import { deskBaseUrl, surfacePorts } from '../harness/desk-server.ts';
import { CLIENT_AUTH_FILE, TRADER_AUTH_FILE } from './auth.ts';
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
  await expect(page.getByRole('region', { name: 'Firm quote', exact: true })).toBeVisible();
  await capture(page, 'client-exchange-quote');
});

test('trade: accepted, waiting for the client’s USDT', async ({ page }) => {
  await page.goto(`/trades/${state().tradeRefs.awaitingDeposit}`);
  await expect(page.getByLabel('Trade progress')).toBeVisible();
  await expect(page.getByText(/Send exactly/)).toBeVisible();
  await capture(page, 'client-trade-awaiting-usdt');
});

test('trade: a BUY waiting for the client’s rupees (ADR 0018)', async ({ page }) => {
  await page.goto(`/trades/${state().tradeRefs.awaitingInr}`);
  await expect(page.getByRole('heading', { name: /^Pay ₹/ })).toBeVisible();
  await expect(page.getByText('Pay only from your own account.')).toBeVisible();
  await capture(page, 'client-trade-awaiting-inr');
});

test('trade: P2P, the seller’s USDT in escrow, the client pays the seller (ADR 0019)', async ({ page }) => {
  await page.goto(`/trades/${state().tradeRefs.p2pBuy}`);
  await expect(page.getByRole('heading', { name: /Pay .* to the seller/ }).first()).toBeVisible();
  await capture(page, 'client-trade-p2p-pay');
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
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible();
  await capture(page, 'client-history');
});

test('destinations: where the money is allowed to go', async ({ page }) => {
  await page.goto('/destinations');
  await expect(page.getByRole('heading', { name: 'Bank & wallets', exact: true })).toBeVisible();
  await capture(page, 'client-destinations');
});

test('notifications', async ({ page }) => {
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
  await capture(page, 'client-notifications');
});

/** A client of the exchange that also deals with an independent desk (ADR 0020): its desks, and one desk's ticket. */
test('desks: the independent desks a client deals with', async ({ page }) => {
  await page.goto('/desks');
  await expect(page.getByRole('heading', { name: 'Desks', exact: true })).toBeVisible();
  await expect(page.getByText('Konkan Liquidity')).toBeVisible();
  await capture(page, 'client-desks');
});

test('a desk: its prices, the amount, where the money lands, and its deals with the client', async ({ page }) => {
  await page.goto(`/desks/${state().desk.handle}?direction=SELL_USDT&fixed=BASE&amount=1000`);
  await expect(page.getByRole('button', { name: 'Get a firm price' })).toBeVisible();
  await capture(page, 'client-desk-ticket');
});

test('traders: the application, as a client of the exchange sees it (TD-23)', async ({ page }) => {
  await page.goto('/traders/apply');
  await expect(page.getByRole('heading', { name: 'Become a trader', exact: true })).toBeVisible();
  await capture(page, 'client-trader-apply');
});

/** The trader's own pages, under the trader's own session: a company that provides INR and has no Exchange (TD-23). */
test.describe('traders', () => {
  test.use({ storageState: TRADER_AUTH_FILE });

  test('home: capacity, rate and the order in progress', async ({ page }) => {
    await page.goto('/traders');
    await expect(page.getByRole('heading', { name: 'Traders', exact: true })).toBeVisible();
    await expect(page.getByText(state().trader.orderRef).first()).toBeVisible();
    await capture(page, 'client-traders');
  });

  test('orders', async ({ page }) => {
    await page.goto('/traders/orders');
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
    await capture(page, 'client-trader-orders');
  });

  test('an order waiting on the trader’s INR', async ({ page }) => {
    await page.goto(`/traders/orders/${state().trader.orderRef}`);
    await expect(page.getByRole('heading', { name: state().trader.orderRef, exact: true })).toBeVisible();
    await capture(page, 'client-trader-order');
  });

  test('a P2P sell: its USDT in escrow, the buyer paying (ADR 0019)', async ({ page }) => {
    await page.goto(`/traders/orders/${state().trader.sellOrderRef}`);
    await expect(page.getByRole('heading', { name: state().trader.sellOrderRef, exact: true })).toBeVisible();
    await capture(page, 'client-trader-order-escrow');
  });

  test('the Security Reserve', async ({ page }) => {
    await page.goto('/traders/reserve');
    await expect(page.getByRole('heading', { name: 'Security Reserve', exact: true })).toBeVisible();
    await capture(page, 'client-trader-reserve');
  });

  test('settlement details', async ({ page }) => {
    await page.goto('/traders/settlement');
    await expect(page.getByRole('heading', { name: 'New settlement details', exact: true })).toBeVisible();
    await capture(page, 'client-trader-settlement');
  });
});

/**
 * The same trader's own desk (ADR 0020), live: two deals waiting on it, a client holding its price, a link waiting, two
 * people on its team. Captured from the desk's own session, on the widths a desk works at — and Today on a phone.
 */
test.describe('desk', () => {
  test.use({ storageState: TRADER_AUTH_FILE });

  test('today: what waits on the desk, its turnover, its prices and what it can fill', async ({ page }) => {
    await page.goto('/desk');
    await expect(page.getByRole('heading', { name: 'Waiting on you' })).toBeVisible();
    await expect(page.getByText('Pay Meera Textiles')).toBeVisible();
    await capture(page, 'client-desk-today');
  });

  test('deals: open, with what each waits for', async ({ page }) => {
    await page.goto('/desk/deals');
    await expect(page.getByRole('heading', { name: 'Deals', exact: true })).toBeVisible();
    await expect(page.getByText('Bharat Digital')).toBeVisible();
    await capture(page, 'client-desk-deals');
  });

  test('a deal: the desk owes the client its rupees', async ({ page }) => {
    await page.goto(`/desk/deals/${state().desk.payDealRef}`);
    await expect(page.getByRole('heading', { name: 'Meera Textiles', exact: true })).toBeVisible();
    await capture(page, 'client-desk-deal');
  });

  test('prices: both sides, with what a client gets and what the desk keeps', async ({ page }) => {
    await page.goto('/desk/prices');
    await expect(page.getByRole('heading', { name: 'Prices live' })).toBeVisible();
    await capture(page, 'client-desk-prices');
  });

  test('clients', async ({ page }) => {
    await page.goto('/desk/clients');
    await expect(page.getByRole('heading', { name: 'Clients', exact: true })).toBeVisible();
    await capture(page, 'client-desk-clients');
  });

  test('team', async ({ page }) => {
    await page.goto('/desk/team');
    await expect(page.getByText('ravi@konkanliquidity.test')).toBeVisible();
    await capture(page, 'client-desk-team');
  });

  test('page: as clients see it, and taking deals', async ({ page }) => {
    await page.goto('/desk/settings');
    await expect(page.getByRole('heading', { name: 'Taking deals' })).toBeVisible();
    await capture(page, 'client-desk-page');
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: false });

    test('today', async ({ page }) => {
      await page.goto('/desk');
      await expect(page.getByRole('heading', { name: 'Waiting on you' })).toBeVisible();
      await capture(page, 'client-desk-today-mobile');
    });
  });
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
