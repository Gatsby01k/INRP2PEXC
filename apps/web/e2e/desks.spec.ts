import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Browser, type BrowserContext, type Page, devices, expect, test } from '@playwright/test';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { DESK, DESKS_OTP_SINK, type DeskWorld, createDeskWorld } from './desk-world.ts';
import { pressUntilFocused } from './support.ts';
import { totpFor } from './world.ts';

/**
 * A desk's deals, both ways, from both screens (ADR 0020, stage 1's release). A trader runs its own exchange: it sends a
 * new client a link, the client signs up on its phone and sells USDT on it; the same client then buys USDT on the
 * desk's own page. Every move a person makes is made in the browser — the desk at its desk, the client on its phone;
 * only what the chain and the worker do happens here, in the same order they would.
 */
test.describe.configure({ mode: 'serial' });

const CLIENT = { email: 'treasury@meeratextiles.test', legalName: 'Meera Textiles Private Limited', name: 'Meera Textiles' } as const;
const PORT = Number.parseInt(process.env.E2E_DESKS_PORT ?? '3220', 10);

let w: DeskWorld;
let desk: Page;
let phone: Page;
let contexts: BrowserContext[] = [];

async function codes(email: string): Promise<string[]> {
  const lines = (await readFile(DESKS_OTP_SINK, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l) as { email: string; otp: string }).filter((m) => m.email === email).map((m) => m.otp);
}

/** The gateway's own sign-in, on whatever page it is: the address, then the code it sent — the next one, never an old one. */
async function enterGateway(page: Page, email: string): Promise<void> {
  const before = (await codes(email)).length;
  // A field typed into before the page hydrates is lost to it: wait until React owns the field, then type.
  const field = page.getByLabel('Email', { exact: true });
  await expect.poll(() => field.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__react'))), { timeout: 20_000 }).toBe(true);
  await field.fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  let code = '';
  for (let i = 0; i < 50 && !code; i++) {
    const all = await codes(email);
    if (all.length > before) code = all.at(-1)!;
    else await new Promise((r) => setTimeout(r, 100));
  }
  expect(code, `a sign-in code for ${email}`).not.toBe('');
  await page.getByLabel('Verification code').fill(code);
}

/** The trade the client's phone is on, by the reference in its address — the one the client was taken to. */
async function tradeOnPhone(direction: 'SELL_USDT' | 'BUY_USDT') {
  const ref = phone.url().match(/\/trades\/(IX-[0-9-]+)/)?.[1];
  expect(ref, `a trade page, not ${phone.url()}`).toBeTruthy();
  const trade = await w.db.selectFrom('trade').select(['id', 'ref', 'direction']).where('ref', '=', ref!).executeTakeFirstOrThrow();
  expect(trade.direction).toBe(direction);
  return trade;
}

async function phoneContext(browser: Browser) {
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
  return browser.newContext({ ...pixel });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  w = await createDeskWorld(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres', PORT);
  const deskContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const phoneCtx = await phoneContext(browser);
  contexts = [deskContext, phoneCtx];
  desk = await deskContext.newPage();
  phone = await phoneCtx.newPage();

});

// The run's own pages are not Playwright's `page`: on a failure, what each screen showed is attached by hand.
test.afterEach(async ({ browserName: _ }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const [name, page] of [['desk', desk], ['phone', phone]] as const) {
    if (!page || page.isClosed()) continue;
    await testInfo.attach(`${name} — ${page.url()}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  }
});

test.afterAll(async () => {
  await Promise.all(contexts.map((c) => c.close()));
  await w?.stop();
});

test('the desk signs in and sends a new client a deal link', async () => {
  // Two screens in one browser: a page behind the other never hydrates, so whoever acts next comes to the front first —
  // as a person picks up the device they act on.
  await desk.bringToFront();
  await desk.goto(`${w.appUrl}/sign-in?next=${encodeURIComponent('/desk')}`);
  await enterGateway(desk, DESK.email);
  await expect(desk.getByRole('heading', { name: DESK.name, level: 1 })).toBeVisible();
  await expect(desk.getByText('Live', { exact: true }).first()).toBeVisible();

  await desk.getByRole('button', { name: 'New deal' }).click();
  const sheet = desk.getByRole('dialog');
  await sheet.getByText('Sells USDT', { exact: true }).click();
  await sheet.getByLabel('Amount in USDT').fill('1000');
  await expect(sheet.getByLabel('Rate, ₹ per USDT')).toHaveValue('101.80');
  await sheet.getByLabel('Who it is for').fill('Meera, WhatsApp');
  await sheet.getByRole('button', { name: 'Create link' }).click();
  await expect(sheet.getByText('Your link is ready')).toBeVisible();
});

let linkToken = '';

test('the client opens the link on its phone, signs up, adds its bank account and takes the deal', async () => {
  // The token is never stored, only its hash: the desk's screen is the one place the link is, as it is for the desk.
  const share = await desk.getByRole('dialog').getByRole('link', { name: 'Telegram' }).getAttribute('href');
  const linkUrl = new URL(share!).searchParams.get('url')!;
  expect(linkUrl.startsWith(`${w.linkUrl}/d/`)).toBe(true);
  linkToken = linkUrl.slice(`${w.linkUrl}/d/`.length);

  await phone.bringToFront();
  await phone.goto(linkUrl);
  await expect(phone.getByText(DESK.name).first()).toBeVisible();
  await expect(phone.getByText('₹101,800', { exact: false }).first()).toBeVisible();
  await phone.getByRole('link', { name: 'Sign in and take this deal' }).click();

  await expect(phone).toHaveURL(/\/sign-in/);
  await enterGateway(phone, CLIENT.email);

  // A new address opens its account first, then comes back to the deal it came for.
  await expect(phone).toHaveURL(/\/open-account/);
  await phone.getByText('Company', { exact: true }).first().click();
  await phone.getByLabel('Company name').fill(CLIENT.legalName);
  await phone.getByRole('button', { name: 'Open account' }).click();
  await expect(phone).toHaveURL(new RegExp(`/d/${linkToken}`));

  // Its first bank account, on the email code it just signed in with — nothing more to set up.
  await phone.getByRole('button', { name: 'Add bank account' }).click();
  const add = phone.getByRole('dialog');
  await add.getByLabel('Account holder').fill(CLIENT.legalName);
  await add.getByLabel('IFSC').fill('HDFC0000240');
  await add.getByLabel('Bank', { exact: true }).fill('HDFC Bank');
  await add.getByLabel('Account number', { exact: true }).fill('50200061234570');
  await add.getByLabel('Account number again').fill('50200061234570');
  await add.getByRole('button', { name: 'Review' }).click();
  await add.getByRole('button', { name: 'Add bank account' }).click();
  await expect(add.getByText('HDFC Bank •••• 4570 is on your account')).toBeVisible();
  await add.getByRole('button', { name: 'Back to your deal' }).click();
  await expect(add).toBeHidden();

  await phone.getByRole('button', { name: 'Take this deal' }).click();
  await phone.getByRole('button', { name: /^Accept at/ }).click();
  await expect(phone).toHaveURL(/\/trades\/IX-/);
});

test('the client’s USDT reaches the escrow, the desk pays the rupees, and the client releases it', async () => {
  const trade = await tradeOnPhone('SELL_USDT');
  const econ = await w.db.selectFrom('trade_economics').select(['base_minor', 'route_base_minor', 'platform_fee_base_minor', 'network_fee_base_minor']).where('trade_id', '=', trade.id).executeTakeFirstOrThrow();
  // 0.25% of the client's 1,000 USDT is INRP2P's; the desk receives the rest less the deal's network — GasFree's activation,
  // the payout and the sweep, 4.5 USDT (ADR 0022).
  expect(econ.platform_fee_base_minor).toBe(2_500_000n);
  expect(econ.network_fee_base_minor).toBe(4_500_000n);
  expect(econ.route_base_minor).toBe(997_500_000n - 4_500_000n);

  const deposit = await w.db.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select('d.address').where('a.trade_id', '=', trade.id).executeTakeFirstOrThrow();
  await expect(phone.getByText(deposit.address).first()).toBeVisible();
  await w.sendUsdt(encodeTronAddress(randomBytes(20)), deposit.address, '1000');

  // The desk's move: pay the client's own account, and give the bank's reference.
  await desk.bringToFront();
  await desk.goto(`${w.appUrl}/desk`);
  await desk.getByRole('link', { name: new RegExp(`Pay ${CLIENT.name}`) }).click();
  await expect(desk.getByText(CLIENT.legalName).first()).toBeVisible();
  await expect(desk.getByText('50200061234570')).toBeVisible();
  // ₹1,01,800 is over UPI's limit: IMPS is suggested, with its thirty minutes (ADR 0023).
  await expect(desk.getByRole('radio', { name: /IMPS/ })).toHaveAttribute('aria-checked', 'true');
  await expect(desk.getByRole('radiogroup', { name: 'How you pay' }).getByRole('radio', { name: /UPI/ })).toBeDisabled();
  await desk.getByLabel(/reference \(UTR\)/).fill('412345678901');
  await desk.getByRole('checkbox', { name: /I sent/ }).check();
  await desk.getByRole('button', { name: 'I’ve paid' }).click();
  await expect(desk.getByText(/waiting for|checking|confirm/i).first()).toBeVisible();

  // The client's move: the rupees are in, from the desk's own account. It can ask the desk in the deal's chat first.
  await phone.bringToFront();
  await phone.reload();
  await phone.getByLabel('Message the buyer').fill('Checking my bank app now');
  await phone.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(phone.getByText('Checking my bank app now')).toBeVisible();
  await phone.getByLabel('Sender’s name, as your bank shows it').fill(DESK.legalName);
  await phone.getByRole('checkbox').check();
  await phone.getByRole('button', { name: /^Release [\d,.]+ USDT$/ }).click();
  // The release recorded before the worker turns: a click returns before its server action does.
  await expect(phone.getByRole('button', { name: /^Release [\d,.]+ USDT$/ })).toBeHidden();

  // The worker's signer pays the desk from the escrow; the fee stays at the deal's address.
  const before = w.chain.balanceOf(w.deskWalletAddress);
  expect(await w.settle(trade.id)).toBe('COMPLETED');
  expect(w.chain.balanceOf(w.deskWalletAddress) - before).toBe(econ.route_base_minor);
  // Paid by one GasFree permit, its network (activation and the transfer, 3 USDT) out of the deal's allowance: left at the
  // address are INRP2P's fee and the sweep's own network. No TRX ever reached it.
  expect(w.chain.balanceOf(deposit.address)).toBe(2_500_000n + (econ.network_fee_base_minor ?? 0n) - 3_000_000n);
  expect(await w.db.selectFrom('gasfree_permit as p').innerJoin('chain_send as s', 's.id', 'p.send_id').select(['p.status', 'p.fee_minor']).where('s.trade_id', '=', trade.id).execute())
    .toEqual([{ status: 'CONFIRMED', fee_minor: 3_000_000n }]);
  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText('Completed', { exact: false }).first()).toBeVisible();
});

test('the same client buys USDT on the desk’s page: the desk funds the escrow, the client pays, the desk releases it', async () => {
  await phone.bringToFront();
  await phone.goto(`${w.linkUrl}/${DESK.handle}`);
  await expect(phone.getByRole('heading', { name: DESK.name, level: 1 })).toBeVisible();
  await phone.getByRole('button', { name: /Buy USDT/ }).click();
  await phone.getByLabel(/in USDT/).fill('500');
  await phone.getByRole('link', { name: `Buy with ${DESK.name}` }).click();

  await expect(phone).toHaveURL(new RegExp(`/desks/${DESK.handle}`));
  await phone.getByRole('button', { name: 'Add wallet' }).click();
  const add = phone.getByRole('dialog');
  const wallet = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
  await add.getByLabel('Wallet address').fill(wallet);
  await add.getByLabel('Name').fill('Treasury wallet');
  await add.getByRole('button', { name: 'Review' }).click();
  await add.getByRole('button', { name: 'Add wallet' }).click();
  await add.getByRole('button', { name: 'Back to your deal' }).click();
  await expect(add).toBeHidden();
  await phone.getByRole('button', { name: 'Get a firm price' }).click();
  await phone.getByRole('button', { name: /^Accept at/ }).click();
  await expect(phone).toHaveURL(/\/trades\/IX-/);

  const trade = await tradeOnPhone('BUY_USDT');
  const econ = await w.db.selectFrom('trade_economics').select(['route_base_minor', 'platform_fee_base_minor', 'network_fee_base_minor']).where('trade_id', '=', trade.id).executeTakeFirstOrThrow();
  // The client's 500 USDT, the 0.25% fee, and the deal's network on GasFree.
  expect(econ.platform_fee_base_minor).toBe(1_250_000n);
  expect(econ.route_base_minor).toBe(501_250_000n + 4_500_000n);

  // The desk's move: its USDT, and INRP2P's fee, into the deal's escrow from its registered wallet.
  await desk.bringToFront();
  await desk.goto(`${w.appUrl}/desk`);
  await desk.getByRole('link', { name: new RegExp(`Fund the escrow for ${CLIENT.name}`) }).click();
  await desk.getByRole('button', { name: 'Show the escrow address' }).click();
  const escrowOf = async () => (await w.db.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .innerJoin('route_obligation as o', 'o.id', 'a.route_obligation_id')
    .select('d.address').where('o.trade_id', '=', trade.id).executeTakeFirst())?.address ?? '';
  await expect.poll(escrowOf).not.toBe('');
  const escrow = await escrowOf();
  await expect(desk.getByText(escrow).first()).toBeVisible();
  await w.sendUsdt(w.deskWalletAddress, escrow, Money.ofMinor(econ.route_base_minor!, 'USDT').toDecimalString());

  // The client's move: pay the desk's account, from its own, and say so.
  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText(DESK.legalName).first()).toBeVisible();
  // ₹51,300 goes by UPI first: a tap opens the UPI app on the desk's own verified UPI ID — never an address made up from
  // its account (ADR 0029) — and the client is told the name its app must show.
  const upiLink = phone.getByRole('link', { name: 'Pay in UPI app' });
  await expect(upiLink).toHaveAttribute('href', /^upi:\/\/pay\?pa=rahulotc%40okaxis&pn=Rahul%20OTC%20LLP&am=51300\.00/);
  await expect(upiLink).not.toHaveAttribute('href', /\.npci/);
  await expect(phone.getByText(DESK.upi).first()).toBeVisible();
  await phone.getByLabel(/reference \(UTR\)/).fill('598765432109');
  // ADR 0030: paying a UPI ID, the client says its app showed the desk's name — "I've paid" waits for it.
  await phone.getByRole('checkbox', { name: /I sent/ }).check();
  await expect(phone.getByRole('button', { name: 'I’ve paid' })).toBeDisabled();
  await phone.getByRole('checkbox', { name: /My UPI app shows Rahul OTC LLP/ }).check();
  await phone.getByRole('button', { name: 'I’ve paid' }).click();

  // The desk's move: the rupees are in, from the client's own account. Each deal has its own chat: the last deal's words are not here.
  await desk.bringToFront();
  await desk.reload();
  await expect(desk.getByText('Checking my bank app now')).toBeHidden();
  await desk.getByLabel('Sender’s name, as your bank shows it').fill(CLIENT.legalName);
  await desk.getByRole('checkbox').check();
  await desk.getByRole('button', { name: 'Release the escrow' }).click();
  await expect(desk.getByRole('button', { name: 'Release the escrow' })).toBeHidden();

  expect(await w.settle(trade.id)).toBe('COMPLETED');
  expect(w.chain.balanceOf(wallet)).toBe(500_000_000n);
  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText('Completed', { exact: false }).first()).toBeVisible();
});

test('the desk sees both deals done, and its turnover and INRP2P’s fees from the books', async () => {
  await desk.bringToFront();
  await desk.goto(`${w.appUrl}/desk/deals?tab=done`);
  await expect(desk.getByText(CLIENT.legalName)).toHaveCount(2);
  await desk.goto(`${w.appUrl}/desk`);
  const kpi = (label: string) => desk.locator('div', { has: desk.getByText(label, { exact: true }) }).last();
  await expect(kpi('Deals completed')).toContainText('2');
  await expect(kpi('Volume')).toContainText('1,500');
  await expect(kpi('INRP2P fees')).toContainText('3.75');
});

/** INRP2P's own operator, on the desk: the same sign-in as anyone's — password, then authenticator. */
async function signInOperator(page: Page): Promise<void> {
  await page.goto(`${w.deskUrl}/sign-in`);
  await page.getByLabel('Work email').fill(w.operator.email);
  await page.getByLabel('Password').fill(w.operator.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(await totpFor(w.operator.totpSecret));
  await page.getByRole('button', { name: 'Verify and open the desk' }).click();
  await expect(page.getByRole('heading', { name: 'Desk', exact: true })).toBeVisible();
}

let operatorPage: Page;

test('INRP2P’s desk sees what both deals earned — in USDT, from the ledger — and nothing of a bank account it does not have', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  operatorPage = await context.newPage();
  await signInOperator(operatorPage);
  const nav = operatorPage.getByRole('navigation').first();
  await expect(nav.getByRole('link', { name: 'INR accounts' })).toHaveCount(0);
  await expect(operatorPage.getByText('Route rates')).toHaveCount(0);
  // 0.25% of 1,000 USDT and of 500, and what each deal carried for its network and has not used: 1.50 USDT, for its sweep.
  await expect(operatorPage.getByText('Earned today')).toBeVisible();
  await expect(operatorPage.locator('div', { has: operatorPage.getByText('Earned today', { exact: true }) }).last()).toContainText('6.75 USDT');

  await operatorPage.goto(`${w.deskUrl}/pnl`);
  await expect(operatorPage.getByTestId('ledger-check')).toContainText('Ledger and trades agree on what completed deals posted: +3.75 USDT');
  const done = await w.db.selectFrom('trade').select('ref').where('lifecycle_state', '=', 'COMPLETED').execute();
  for (const t of done) await expect(operatorPage.getByRole('link', { name: t.ref })).toBeVisible();

  // A deal's record: its escrow and its rupees as they stood, and nothing for the desk to move.
  await operatorPage.goto(`${w.deskUrl}/orders/${done[0]!.ref}`);
  await expect(operatorPage.getByTestId('p2p-escrow')).toBeVisible();
  await expect(operatorPage.getByTestId('p2p-rupees')).toBeVisible();
  await expect(operatorPage.getByRole('button', { name: /Reserve & create leg|Create leg|Mark sent/ })).toHaveCount(0);
});

test('a person prices a request by keyboard alone: the rate, a trader, then the quote; the client sends its USDT within its time', async () => {
  const page = operatorPage;
  await page.bringToFront();
  const client = await w.db.selectFrom('client').select(['id']).where('legal_name', '=', CLIENT.legalName).executeTakeFirstOrThrow();
  await page.goto(`${w.deskUrl}/clients/${client.id}`);
  await pressUntilFocused(page, page.getByTestId('new-request').getByLabel('Amount (USDT)'));
  await page.keyboard.type('1000');
  await pressUntilFocused(page, page.getByRole('button', { name: 'Create request and quote' }));
  await page.keyboard.press('Enter');

  // Nothing can be quoted before a trader holds the order; the rate comes first, because the order is sized at it.
  const quote = page.getByTestId('quote-panel');
  await expect(quote).toBeVisible();
  await expect(quote.getByText('then route the request to a trader')).toBeVisible();
  await pressUntilFocused(page, quote.getByLabel('Client rate (INR per USDT)'));
  await page.keyboard.type('100.20');
  await pressUntilFocused(page, quote.getByRole('button', { name: 'Route to a trader' }));
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('trader-section')).toContainText('offered — waiting for the trader');

  const order = await w.db.selectFrom('trader_order').select('ref').where('status', '=', 'OFFERED').executeTakeFirstOrThrow();
  await w.acceptOrder(order.ref);
  await page.reload();

  // The trader's rate is ₹101.20 and the client's ₹100.20: about 9.88 USDT of margin, 4.50 of it GasFree's. The rate is
  // the order's now, already in the field; computed by the function the command uses, not typed.
  const economics = page.getByTestId('quote-economics');
  await expect(economics).toContainText('Trader’s rate');
  await expect(economics).toContainText('Net margin');
  await expect(economics).toContainText('−4.50 USDT');
  await expect(economics).toContainText(/\+5\.\d+ USDT/);
  await pressUntilFocused(page, quote.getByLabel('Client rate (INR per USDT)'));
  await page.keyboard.press('Tab');
  await page.keyboard.press('q');
  await expect(page.getByTestId('quote-link')).toBeVisible();

  await phone.bringToFront();
  await phone.goto(`${w.appUrl}/exchange`);
  await phone.getByRole('button', { name: /^Accept/ }).click();
  await expect(phone).toHaveURL(/\/trades\/IX-/);
  await tradeOnPhone('SELL_USDT');
  await expect(phone.getByRole('timer').filter({ hasText: 'Send within' })).toBeVisible();
});
