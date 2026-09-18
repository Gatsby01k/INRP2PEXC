import { type Page, expect, test } from '@playwright/test';
import { acceptAsClient, clientSendsUsdt, expireStepUp, latestSentQuoteId, noStepUp, realizedMargin, signIn, state, stepUp, tradeState } from './support.ts';

/**
 * The Phase 6 demo scenario, end to end: 100,000 USDT sold at ₹102.00 against a ₹104.20 route, settled to the
 * client in two INR legs, completing with ₹220,000 of realized margin (launch checklist).
 *
 * Everything an operator does happens through the operator UI. The two steps the operator product must never do
 * are done the way the real world does them: the **client** accepts their own quote (D-01), and the **chain**
 * delivers the USDT, discovered by the Phase 5 scanner.
 */
test('the demo scenario, driven through the operator UI', async ({ page }) => {
  const s = state();
  test.slow();
  await signIn(page, s.owner);

  // 1. A dealer opens the request for the client and prices it.
  await page.goto(`/clients/${s.clientId}`);
  await expect(page.getByRole('heading', { name: s.clientName })).toBeVisible();
  await page.getByTestId('new-request').getByLabel('Amount (USDT)').fill('100000');
  await page.getByTestId('new-request').getByLabel('Target rate (optional)').fill('102');
  await page.getByRole('button', { name: 'Create request and quote' }).click();

  const quotePanel = page.getByTestId('quote-panel');
  await expect(quotePanel).toBeVisible();
  await expect(quotePanel.getByText('100000.000000 USDT')).toBeVisible();
  await quotePanel.getByLabel('Client rate (INR per USDT)').fill('102');

  // The margin is computed by the desk from the kernel's own economics, never typed (FI-02).
  await expect(quotePanel.getByText('+₹220,000')).toBeVisible();
  await quotePanel.getByRole('button', { name: /Send (counter|quote)/ }).click();
  await expect(page.getByTestId('quote-link')).toBeVisible();

  // 2. The client accepts their own quote, which opens the trade and assigns the deposit address.
  const quoteId = await latestSentQuoteId(s.clientId);
  const trade = await acceptAsClient(quoteId);
  expect(await tradeState(trade.tradeId)).toBe('AWAITING_FIRST_LEG');

  // 3. The client sends the USDT; the scanner detects and confirms it.
  await clientSendsUsdt(trade.tradeId, '100000');
  expect(await tradeState(trade.tradeId)).toBe('FIRST_LEG_CONFIRMED');

  // 4. The desk sees the trade waiting for a payout and opens its panel.
  await page.goto('/');
  const queue = page.getByTestId('desk-queue');
  await expect(queue.getByText('USDT confirmed')).toBeVisible();
  await queue.getByRole('button', { name: /Create payout/ }).click();

  const panel = page.getByTestId('payout-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('₹10,200,000').first()).toBeVisible();

  // 5. First leg: ₹6,000,000 against the exchange account's capacity. The sign-in verification is aged out
  // first, so confirming money out has to be re-verified (SECURITY §2.1).
  await expireStepUp();
  await payLeg(page, '6000000', s.owner);
  await expect(page.getByTestId('payout-panel').getByText('₹6,000,000').first()).toBeVisible();

  // 6. Second leg clears the rest — no second prompt, because that verification is still inside its window —
  // and the trade completes with its margin realized.
  await payLeg(page, '4200000', null);
  await expect.poll(async () => tradeState(trade.tradeId), { timeout: 20_000 }).toBe('COMPLETED');
  expect(await realizedMargin()).toBe('220000.00');

  // 7. The completed trade has left the queue and is visible in Orders.
  await page.goto('/orders?state=COMPLETED');
  await expect(page.getByText(trade.tradeRef)).toBeVisible();
});

/**
 * Create → send → record the bank reference → confirm, all through the panel. `who` is the operator expected to
 * be asked to re-verify; `null` asserts the desk did not ask.
 */
async function payLeg(page: Page, amount: string, who: ReturnType<typeof state>['owner'] | null): Promise<void> {
  const panel = page.getByTestId('payout-panel');
  await panel.getByTestId('new-leg').getByLabel('Amount').fill(amount);
  await panel.getByRole('button', { name: 'Reserve & create leg' }).click();

  const legs = page.getByTestId('legs');
  await expect(legs).toBeVisible();
  await legs.getByRole('button', { name: 'Mark sent' }).last().click();

  const utr = `IX${Date.now().toString(36).toUpperCase()}${amount.slice(0, 4)}`;
  await legs.getByLabel('UTR / reference').last().fill(utr);
  await legs.getByRole('button', { name: 'Save UTR' }).last().click();

  // The button carries its keyboard hint in the accessible name ("Confirm ⧗"), so anchor on the verb.
  await legs.getByRole('button', { name: /^Confirm/ }).last().click();
  if (who) await stepUp(page, who);
  else await noStepUp(page);
}
