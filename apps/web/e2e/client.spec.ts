import { type Page, expect, test } from '@playwright/test';
import { maskEmail } from '../src/app/sign-in/access.ts';
import {
  acceptanceCodeFor,
  appBaseUrl,
  clientSignInCode,
  clientSignInCodeCount,
  clientSendsUsdt,
  deskPaysOut,
  deliverNotifications,
  deskSendsQuoteWithLink,
  linkBaseUrl,
  signInAsClient,
  state,
  tradeIdForRef,
  tradeState,
} from './support.ts';

/**
 * Phase 7 exit: one client, one phone, from the link arriving to the trade settled.
 *
 * The whole point of the client product is that a person with a phone and a message can act on a price and then
 * watch their money arrive. So this runs on a mobile device profile, against the built app, across all three
 * surfaces the product actually has — the link on the public host, the trade on the client host — and it never
 * takes a short cut through a command the browser would not have run.
 */
test.describe.configure({ mode: 'serial' });

let tradeRef = '';

test('a quote link is a price and a challenge, never an authorization', async ({ page }) => {
  const quote = await deskSendsQuoteWithLink({ amount: '1000', clientRate: '100.000000' });

  await page.goto(`${linkBaseUrl()}/q/${quote.token}`);
  await expect(page.getByText(`Private quote ${quote.quoteRef}`)).toBeVisible();
  // The figures the desk committed to, and not one figure more: no route rate, no margin, no provider.
  await expect(page.getByText('₹100,000', { exact: false }).first()).toBeVisible();
  await assertNothingOfTheDesk(page);

  // Opening the link changed nothing.
  expect(await quoteStatus(quote.quoteId)).toBe('SENT');

  await page.getByRole('button', { name: 'Accept quote' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();

  // A wrong code is refused, and the message says nothing about which half was wrong.
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('Code')).toBeVisible();
  await page.getByLabel('Code').fill('000000');
  await page.getByRole('button', { name: 'Confirm & accept' }).click();
  await expect(page.getByText('The code is invalid or has expired.')).toBeVisible();
  expect(await quoteStatus(quote.quoteId)).toBe('SENT');

  // The real code, from the product's own delivery path.
  const code = await acceptanceCodeFor(quote.quoteId);
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Confirm & accept' }).click();
  await expect(page.getByRole('heading', { name: 'Accepted' })).toBeVisible();

  expect(await quoteStatus(quote.quoteId)).toBe('ACCEPTED');
  tradeRef = (await page.getByText(/IX-\d{6}-\d{4}/).first().textContent())?.match(/IX-\d{6}-\d{4}/)?.[0] ?? '';
  expect(tradeRef).toMatch(/^IX-\d{6}-\d{4}$/);
});

test('“Not now” on the link is a local dismissal and nothing else (D-15)', async ({ page }) => {
  const quote = await deskSendsQuoteWithLink({ amount: '250', clientRate: '100.000000' });
  await page.goto(`${linkBaseUrl()}/q/${quote.token}`);
  await page.getByRole('button', { name: 'Not now' }).click();

  await expect(page.getByRole('heading', { name: 'Put aside' })).toBeVisible();
  await expect(page.getByText('Nothing has been sent to the desk')).toBeVisible();
  // The quote is untouched, which is the whole point: a client who thinks they declined, and has not, is a
  // client the desk will chase.
  expect(await quoteStatus(quote.quoteId)).toBe('SENT');

  // And the link still works afterwards — the dismissal was in the browser, not in the exchange.
  await page.getByRole('button', { name: 'Back to the quote' }).click();
  await expect(page.getByRole('button', { name: 'Accept quote' })).toBeVisible();
});

/**
 * The workspace gateway, on the phone the client product is built for: the access surface is the page, the robot is
 * left out altogether, and the code step happens on the same surface. Real codes from the product's own delivery
 * path, and a refusal that says the same thing whatever was wrong.
 */
test('a client signs in on their phone: the surface first, no robot, and the code on the same surface', async ({ page }) => {
  const email = state().acceptorEmail;
  const robot: string[] = [];
  page.on('request', (request) => {
    if (/\/robot-\d+\.[^/]*\.webp/.test(request.url())) robot.push(request.url());
  });
  const before = await clientSignInCodeCount(email);
  await page.goto(`${appBaseUrl()}/sign-in`);
  await expect(page.getByRole('heading', { level: 1, name: 'Enter the desk.' })).toBeVisible();

  // The field and its action are in the upper half of the screen, clear of where the keyboard opens.
  const field = page.getByLabel('Work email');
  const continueButton = page.getByRole('button', { name: 'Continue' });
  const height = page.viewportSize()!.height;
  expect((await continueButton.boundingBox())!.y + 52, 'the action above the keyboard').toBeLessThan(height * 0.7);
  await expect(field).toHaveAttribute('autocomplete', 'username');
  await expect(field).toHaveAttribute('inputmode', 'email');

  await field.fill('treasury');
  await continueButton.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Enter your full work email' })).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');

  await field.fill(email);
  await continueButton.click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await expect(page.getByText(maskEmail(email), { exact: true })).toBeVisible();
  await expect(page.getByText(/^Resend in 00:\d\d$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use another email' })).toBeVisible();

  // One field under the six cells: the keyboard's own code suggestion, a paste and a screen reader all use it.
  const code = page.getByLabel('Verification code');
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(code).toHaveAttribute('inputmode', 'numeric');

  // A complete code is checked at once. A wrong one is refused next to the cells and nowhere else.
  const real = await clientSignInCode(email, before);
  await code.fill(real === '000000' ? '111111' : '000000');
  await expect(page.getByRole('alert').filter({ hasText: /That code wasn.t accepted/ })).toBeVisible();
  await expect(code).toHaveAttribute('aria-invalid', 'true');

  // The real one, entered in one go with the space an email puts in it, is taken whole.
  await code.fill(`${real.slice(0, 3)} ${real.slice(3)}`);
  await expect(page.getByRole('heading', { name: 'Exchange', exact: true })).toBeVisible();

  expect(robot, 'a phone signing in fetches no robot').toEqual([]);
});

test('the client follows that trade to completion on their phone', async ({ page }) => {
  const s = state();
  await signInAsClient(page, s.acceptorEmail);

  await page.goto(`${appBaseUrl()}/trades/${tradeRef}`);
  await expect(page.getByText(tradeRef).first()).toBeVisible();
  // Before the USDT arrives the screen's job is to say exactly where to send it.
  await expect(page.getByText(/Send exactly|USDT/).first()).toBeVisible();

  const tradeId = await tradeIdForRef(tradeRef);
  await clientSendsUsdt(tradeId, '1000');
  await page.reload();
  await expect(page.getByText('Confirmed')).toBeVisible();

  await deskPaysOut(tradeId, '60000.00');
  await page.reload();
  await expect(page.getByText('₹40,000', { exact: false }).first()).toBeVisible();

  await deskPaysOut(tradeId, '40000.00');
  expect(await tradeState(tradeId)).toBe('COMPLETED');
  await page.reload();
  await expect(page.getByText('Completed', { exact: false }).first()).toBeVisible();
});

test('the client sees it in their history and their inbox, and nothing of the desk’s', async ({ page }) => {
  await signInAsClient(page, state().acceptorEmail);

  await page.goto(`${appBaseUrl()}/history`);
  await expect(page.getByText(tradeRef)).toBeVisible();

  await deliverNotifications();
  await page.goto(`${appBaseUrl()}/notifications`);
  await expect(page.getByRole('listitem').filter({ hasText: tradeRef }).filter({ hasText: 'Trade complete' })).toBeVisible();
  await assertNothingOfTheDesk(page);
});

/**
 * What a client page may not say.
 *
 * Asserted against what the page **shows**, not its HTML: a framework's own payload is full of words like
 * "parallelRouterKey", and a check that trips over those would be abandoned within a week. The figures are the
 * sharper half — the seeded route rate and the route's name are facts about how the desk sourced the other side
 * of the trade, and a client must never be able to read either one off their own screen (SECURITY §5).
 */
async function assertNothingOfTheDesk(page: Page): Promise<void> {
  const shown = await page.locator('body').innerText();
  expect(shown, 'desk vocabulary on a client screen').not.toMatch(/\b(route|margin|spread|provider|custody|dealer|obligation|liquidity|suspense)\b/i);
  expect(shown, 'the route rate on a client screen').not.toMatch(/104[.,]2/);
  expect(shown, 'the route name on a client screen').not.toMatch(/Mumbai OTC/i);
}

test('the client host refuses what belongs to the desk, and the public host refuses the client product', async ({ page }) => {
  // The desk's own pages are not served to a client session; the app host has no desk on it.
  const desk = await page.request.get(`${appBaseUrl()}/orders`, { maxRedirects: 0 });
  expect([307, 308, 401, 404]).toContain(desk.status());

  // The public host publishes the quote link and nothing else — not even the sign-in page.
  const signIn = await page.request.get(`${linkBaseUrl()}/sign-in`, { maxRedirects: 0 });
  expect(signIn.status()).toBe(401);
});

async function quoteStatus(quoteId: string): Promise<string> {
  const { appDb } = await import('./support.ts');
  const row = await appDb().selectFrom('quote').select('status').where('id', '=', quoteId).executeTakeFirstOrThrow();
  return row.status;
}
