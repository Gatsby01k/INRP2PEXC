import { expect, test } from '@playwright/test';
import { acceptAsClient, clientSendsUsdt, expireStepUp, latestSentQuoteId, pressUntilFocused, signInWithKeyboard, state, stepUp, tradeState } from './support.ts';

/**
 * Quote → payout without ever touching the pointer (IMPLEMENTATION_PLAN Phase 6 exit, UX_FLOWS §6). A dealer
 * works this desk all day; if a step of the money path can only be reached with a mouse, the desk is slower than
 * the phone call it replaces.
 *
 * Nothing here is clicked. Focus moves with Tab and the arrow keys, rows and buttons are activated with Enter or
 * Space, the queue's row hotkeys open panels, and ⌘K finds a trade by reference.
 */
test('quote to payout, keyboard only', async ({ page }) => {
  const s = state();
  test.slow();
  await signInWithKeyboard(page, s.owner);

  // A request to price, created from the client page — reached by keyboard, filled by keyboard.
  await page.goto(`/clients/${s.clientId}`);
  await pressUntilFocused(page, page.getByTestId('new-request').getByLabel('Amount (USDT)'));
  await page.keyboard.type('25000');
  await page.keyboard.press('Tab');
  await page.keyboard.type('102');
  await pressUntilFocused(page, page.getByRole('button', { name: 'Create request and quote' }));
  await page.keyboard.press('Enter');

  // The quote builder: type the rate, leave the field, and use the Q the button advertises.
  const quote = page.getByTestId('quote-panel');
  await expect(quote).toBeVisible();
  await pressUntilFocused(page, quote.getByLabel('Client rate (INR per USDT)'));
  await page.keyboard.press('Control+a');
  await page.keyboard.type('102');
  await expect(quote.getByText('+₹55,000')).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('q');
  await expect(page.getByTestId('quote-link')).toBeVisible();

  // The client accepts and the chain delivers — neither is the operator's to do.
  const trade = await acceptAsClient(await latestSentQuoteId(s.clientId));
  await clientSendsUsdt(trade.tradeId, '25000');

  // ⌘K finds the trade by its reference; Enter opens it.
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(bar).toBeVisible();
  await page.keyboard.type(trade.tradeRef);
  await expect(bar.getByText(trade.tradeRef).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/orders\\?trade=${trade.tradeId}`));
  await expect(page.getByText(trade.tradeRef).first()).toBeVisible();

  // Back on the desk, the row's own hotkey opens the settlement panel.
  await page.goto('/');
  // Queue rows are identified by subject, so a request, its quote and the trade it becomes stay distinct.
  const row = page.locator(`tr[data-row][data-row-id="trade:${trade.tradeId}"]`);
  await pressUntilFocused(page, row);
  await page.keyboard.press('p');

  const panel = page.getByTestId('payout-panel');
  await expect(panel).toBeVisible();

  // One leg for the whole obligation: amount, reserve, mark sent, reference, confirm — all by keyboard.
  await pressUntilFocused(page, panel.getByTestId('new-leg').getByLabel('Amount'));
  await page.keyboard.type('2550000');
  await pressUntilFocused(page, panel.getByRole('button', { name: 'Reserve & create leg' }));
  await page.keyboard.press('Enter');

  const legs = page.getByTestId('legs');
  await pressUntilFocused(page, legs.getByRole('button', { name: 'Mark sent' }).last());
  await page.keyboard.press('Enter');

  await pressUntilFocused(page, legs.getByLabel('UTR / reference').last());
  await page.keyboard.type(`IXKB${Date.now().toString(36).toUpperCase()}`);
  await pressUntilFocused(page, legs.getByRole('button', { name: 'Save UTR' }).last());
  await page.keyboard.press('Enter');

  await expireStepUp();
  await pressUntilFocused(page, legs.getByRole('button', { name: /^Confirm/ }).last());
  await page.keyboard.press('Enter');
  await stepUp(page, s.owner, { keyboard: true });

  await expect.poll(async () => tradeState(trade.tradeId), { timeout: 20_000 }).toBe('COMPLETED');
});
