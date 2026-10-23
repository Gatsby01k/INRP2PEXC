import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type Browser, type BrowserContext, type Page, devices, expect, test } from '@playwright/test';
import { encodeTronAddress } from '@inrp2p/kernel';
import { DESK, DESKS_OTP_SINK, type DeskWorld, createDeskWorld } from './desk-world.ts';

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
  const field = page.getByLabel('Work email');
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
  const econ = await w.db.selectFrom('trade_economics').select(['base_minor', 'route_base_minor', 'platform_fee_base_minor']).where('trade_id', '=', trade.id).executeTakeFirstOrThrow();
  // 0.25% of the client's 1,000 USDT is INRP2P's; the desk receives the rest.
  expect(econ.platform_fee_base_minor).toBe(2_500_000n);
  expect(econ.route_base_minor).toBe(997_500_000n);

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
  await desk.getByLabel('Bank reference (UTR)').fill('412345678901');
  await desk.getByRole('button', { name: 'I have paid' }).click();
  await expect(desk.getByText(/waiting for|checking|confirm/i).first()).toBeVisible();

  // The client's move: the rupees are in, from the desk's own account.
  await phone.bringToFront();
  await phone.reload();
  await phone.getByLabel('Sender’s name, as your bank shows it').fill(DESK.legalName);
  await phone.getByRole('checkbox').check();
  await phone.getByRole('button', { name: 'Release the escrow' }).click();

  // The worker's signer pays the desk from the escrow; the fee stays at the deal's address.
  const before = w.chain.balanceOf(w.deskWalletAddress);
  expect(await w.settle(trade.id)).toBe('COMPLETED');
  expect(w.chain.balanceOf(w.deskWalletAddress) - before).toBe(997_500_000n);
  expect(w.chain.balanceOf(deposit.address)).toBe(2_500_000n);
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
  const econ = await w.db.selectFrom('trade_economics').select(['route_base_minor', 'platform_fee_base_minor']).where('trade_id', '=', trade.id).executeTakeFirstOrThrow();
  expect(econ.platform_fee_base_minor).toBe(1_250_000n);
  expect(econ.route_base_minor).toBe(501_250_000n);

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
  await w.sendUsdt(w.deskWalletAddress, escrow, '501.25');

  // The client's move: pay the desk's account, from its own, and say so.
  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText(DESK.legalName).first()).toBeVisible();
  await expect(phone.getByText('74130211980057').first()).toBeVisible();
  await phone.getByLabel(/reference \(UTR\)/).fill('598765432109');
  await phone.getByRole('checkbox').check();
  await phone.getByRole('button', { name: 'I’ve paid' }).click();

  // The desk's move: the rupees are in, from the client's own account.
  await desk.bringToFront();
  await desk.reload();
  await desk.getByLabel('Sender’s name, as your bank shows it').fill(CLIENT.legalName);
  await desk.getByRole('checkbox').check();
  await desk.getByRole('button', { name: 'Release the escrow' }).click();

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
