import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type Browser, type BrowserContext, type Page, devices, expect, test } from '@playwright/test';
import { base32 } from '@better-auth/utils/base32';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { HUMAN_OTP_SINK, type HumanWorld, TRADER, createHumanWorld } from './human-world.ts';
import { freshTotp, pressUntilFocused } from './support.ts';

/**
 * A deal as people make it (2026-11-08): a client signs up on its phone and secures its account, then buys and sells USDT
 * on the INRP2P exchange with a trader that is on its phone too. Every move a person makes is made in the browser — the
 * amounts typed, the bank's reference copied in, the receipt attached, the sender's name read off a bank app, a dispute
 * opened and answered, the operator's price and decision. Only the chain and the worker run here.
 *
 * Alongside, the run keeps a journal of who did each step — the client, the trader, INRP2P's operator, or the system — so
 * what still needs a person at INRP2P is counted, not guessed. It is printed at the end; HUMAN_SHOTS=<dir> also keeps a
 * screenshot of each screen a person acted on.
 */
test.describe.configure({ mode: 'serial' });

const CLIENT = { email: 'finance@kaveriexports.test', legalName: 'Kaveri Exports Private Limited', bank: 'HDFC Bank', ifsc: 'HDFC0000240', account: '50200078912346' } as const;
const PORT = Number.parseInt(process.env.E2E_HUMAN_PORT ?? '3230', 10);
const SHOTS = process.env.HUMAN_SHOTS ?? '';

type Who = 'CLIENT' | 'TRADER' | 'OPERATOR' | 'SYSTEM';
const journal: { deal: string; step: string; who: Who }[] = [];
const did = (deal: string, who: Who, step: string) => journal.push({ deal, step, who });

let w: HumanWorld;
let phone: Page;
let traderPhone: Page;
let operatorPage: Page | null = null;
let clientTotp = '';
let clientWallet = '';
const contexts: BrowserContext[] = [];
let shot = 0;

async function snap(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  shot += 1;
  await page.screenshot({ path: path.join(SHOTS, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true });
}

async function codes(email: string): Promise<string[]> {
  const lines = (await readFile(HUMAN_OTP_SINK, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l) as { email: string; otp: string }).filter((m) => m.email === email).map((m) => m.otp);
}

async function nextCode(email: string, before: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const all = await codes(email);
    if (all.length > before) return all.at(-1)!;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no sign-in code arrived for ${email}`);
}

/** The gateway's sign-in: the address, then the code it emailed — as a person types it in. */
async function signIn(page: Page, email: string): Promise<void> {
  const before = (await codes(email)).length;
  const field = page.getByLabel('Email', { exact: true });
  await expect.poll(() => field.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__react'))), { timeout: 20_000 }).toBe(true);
  await field.fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await page.getByLabel('Verification code').fill(await nextCode(email, before));
}

/** Whatever this screen asks to confirm a change with: the authenticator once there is one, else the emailed code. */
async function confirmIt(page: Page, scope: ReturnType<Page['getByRole']> | Page = page): Promise<void> {
  const totp = scope.getByLabel('Authenticator code');
  const email = scope.getByLabel('Code from your email');
  await expect(totp.or(email).first()).toBeVisible();
  if (await totp.isVisible()) {
    await totp.fill(await freshTotp(clientTotp));
  } else {
    const before = (await codes(CLIENT.email)).length;
    const send = scope.getByRole('button', { name: /Send|Email me/ });
    if (await send.count()) await send.first().click();
    await email.fill(await nextCode(CLIENT.email, before));
  }
  await scope.getByRole('button', { name: /^(Confirm|Verify|Continue)/ }).last().click();
}

/** A bank's "payment successful" screen, as the payer's phone saves it: the receipt a person attaches. */
async function receiptPng(browser: Browser, input: { bank: string; amount: string; to: string; account: string; utr: string; rail: string }): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
  await page.setContent(`<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;background:#f4f6fb">
    <div style="background:#0b3d91;color:#fff;padding:22px 20px;font-size:18px;font-weight:600">${input.bank}</div>
    <div style="padding:28px 20px;text-align:center">
      <div style="width:64px;height:64px;border-radius:32px;background:#1a9e55;margin:0 auto;color:#fff;font-size:40px;line-height:64px">✓</div>
      <div style="font-size:15px;color:#555;margin-top:14px">${input.rail} transfer successful</div>
      <div style="font-size:34px;font-weight:700;margin-top:6px">₹${input.amount}</div>
    </div>
    <div style="background:#fff;margin:0 16px;border-radius:12px;padding:16px;font-size:14px;line-height:1.9">
      <div><b>To</b> ${input.to}</div><div><b>Account</b> ••••${input.account.slice(-4)}</div>
      <div><b>UTR / Ref no.</b> ${input.utr}</div><div><b>Date</b> ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</div>
    </div></body></html>`);
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return png;
}

/** The payer's side of the rupees, on whichever screen it is — the client's trade or the trader's order. */
async function payInr(page: Page, browser: Browser, input: { amount: string; payee: string; account: string; utr: string; fromBank: string }): Promise<void> {
  await expect(page.getByText(input.payee).first()).toBeVisible();
  await expect(page.getByText(input.account).first()).toBeVisible();
  await page.getByRole('radio', { name: /IMPS/ }).click();
  await page.getByLabel(/reference \(UTR\)/).fill(input.utr);
  await expect(page.getByText('Looks right.')).toBeVisible();
  const png = await receiptPng(browser, { bank: input.fromBank, amount: input.amount, to: input.payee, account: input.account, utr: input.utr, rail: 'IMPS' });
  await page.locator('label', { hasText: 'Attach the receipt' }).locator('input[type="file"]').setInputFiles({ name: `imps-${input.utr}.png`, mimeType: 'image/png', buffer: png });
  await expect(page.getByText(`imps-${input.utr}`)).toBeVisible();
  await page.getByRole('checkbox', { name: /I sent/ }).check();
  await snap(page, `pay-${input.utr}`);
  await page.getByRole('button', { name: 'I’ve paid' }).click();
  await expect(page.getByRole('button', { name: 'I’ve paid' })).toBeHidden();
}

/** The payee's side: the buyer's receipt is there to look at, but only its own bank's word releases the escrow. */
async function confirmInr(page: Page, input: { sender: string }): Promise<void> {
  const proof = page.getByRole('link', { name: 'Open the buyer’s receipt' });
  await expect(proof).toBeVisible();
  const served = await page.request.get(new URL((await proof.getAttribute('href'))!, page.url()).toString());
  expect(served.status()).toBe(200);
  expect(served.headers()['content-type']).toMatch(/^image\//);
  await snap(page, 'confirm-receipt');
  await page.getByLabel('Sender’s name, as your bank shows it').fill(input.sender);
  await page.getByRole('checkbox', { name: /credited|arrived|I see/ }).check();
  await page.getByRole('button', { name: 'Release the escrow' }).click();
  await expect(page.getByRole('button', { name: 'Release the escrow' })).toBeHidden();
}

async function tradeOnPhone(direction: 'SELL_USDT' | 'BUY_USDT') {
  const ref = phone.url().match(/\/trades\/(IX-[0-9-]+)/)?.[1];
  expect(ref, `a trade page, not ${phone.url()}`).toBeTruthy();
  const trade = await w.db.selectFrom('trade').select(['id', 'ref', 'direction']).where('ref', '=', ref!).executeTakeFirstOrThrow();
  expect(trade.direction).toBe(direction);
  return trade;
}

/** The address the trader's "Show the escrow address" issued — once its server action has. */
async function escrowOf(tradeId: string): Promise<string> {
  const read = async () => (await w.db.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .innerJoin('route_obligation as o', 'o.id', 'a.route_obligation_id').select('d.address').where('o.trade_id', '=', tradeId).executeTakeFirst())?.address ?? '';
  await expect.poll(read).not.toBe('');
  return read();
}

/** What the client pays or is paid for a trade, as the bank app's receipt shows it. */
async function rupeesOf(tradeId: string): Promise<string> {
  const e = await w.db.selectFrom('trade_economics').select('quote_inr_minor').where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
  return Money.ofMinor(e.quote_inr_minor, 'INR').toDecimalString();
}

/**
 * ADR 0028, on the trader's own phone: one side's rate set to follow the market by its margin, and its offer firm until it
 * turns it off — once, not per deal.
 */
async function followTheMarket(side: 'Buy USDT' | 'Sell USDT', margin: string, now: RegExp): Promise<void> {
  await traderPhone.bringToFront();
  await traderPhone.goto(`${w.appUrl}/traders`);
  const card = traderPhone.getByRole('region', { name: side, exact: true });
  await card.getByRole('button', { name: 'Edit' }).click();
  await card.locator('label', { hasText: 'Follow the market' }).click();
  await expect(card.getByRole('radio', { name: /Follow the market/ })).toBeChecked();
  await card.getByLabel('Your margin on the market').fill(margin);
  await expect(card.getByText(now)).toBeVisible();
  await card.getByLabel('Instant orders').selectOption({ label: 'On until I turn it off' });
  await snap(traderPhone, `trader-follows-the-market-${side.startsWith('Buy') ? 'buy' : 'sell'}`);
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('On until you turn it off')).toBeVisible();
  await expect(card.getByText(`Market ${margin.startsWith('-') ? '−' + margin.slice(1) : '+' + margin}%`)).toBeVisible();
}

async function orderOfTrade(tradeId: string) {
  return w.db.selectFrom('trader_order').select(['ref', 'base_minor']).where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
}

async function ask(direction: 'SELL_USDT' | 'BUY_USDT', amount: string): Promise<void> {
  await phone.bringToFront();
  await phone.goto(`${w.appUrl}/exchange`);
  const form = phone.getByRole('form', { name: 'Request a quote' });
  await form.getByRole('radio', { name: direction === 'BUY_USDT' ? 'Buy USDT' : 'Sell USDT' }).click();
  await form.getByLabel(direction === 'BUY_USDT' ? 'You receive' : 'You sell').fill(amount);
  await form.getByRole('button', { name: 'Request firm quote' }).click();
}

async function signInOperator(page: Page): Promise<void> {
  await page.goto(`${w.deskUrl}/sign-in`);
  await page.getByLabel('Work email').fill(w.operator.email);
  await page.getByLabel('Password').fill(w.operator.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(await freshTotp(w.operator.totpSecret));
  await page.getByRole('button', { name: 'Verify and open the desk' }).click();
  await expect(page.getByRole('heading', { name: 'Desk', exact: true })).toBeVisible();
}

async function operator(browser: Browser): Promise<Page> {
  if (operatorPage) return operatorPage;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  operatorPage = await context.newPage();
  await signInOperator(operatorPage);
  return operatorPage;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  w = await createHumanWorld(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres', PORT);
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
  for (const which of ['client', 'trader'] as const) {
    const context = await browser.newContext({ ...pixel });
    contexts.push(context);
    const page = await context.newPage();
    if (which === 'client') phone = page;
    else traderPhone = page;
  }
});

test.afterEach(async ({ browserName: _ }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  for (const [name, page] of [['client', phone], ['trader', traderPhone], ['operator', operatorPage]] as const) {
    if (!page || page.isClosed()) continue;
    await testInfo.attach(`${name} — ${page.url()}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  }
});

test.afterAll(async () => {
  if (journal.length > 0) {
    console.table(journal);
    const byWho = (deal: string) => Object.fromEntries((['CLIENT', 'TRADER', 'OPERATOR', 'SYSTEM'] as const).map((who) => [who, journal.filter((j) => j.deal === deal && j.who === who).length]));
    console.table([...new Set(journal.map((j) => j.deal))].map((deal) => ({ deal, ...byWho(deal) })));
  }
  await Promise.all(contexts.map((c) => c.close()));
  await w?.stop();
});

test('a client opens its account on its phone, secures it, and adds its bank account and wallet — no operator', async () => {
  const deal = 'onboarding';
  await phone.bringToFront();
  await phone.goto(`${w.appUrl}/sign-in`);
  await signIn(phone, CLIENT.email);
  await expect(phone).toHaveURL(/\/open-account/);
  await phone.getByText('Company', { exact: true }).first().click();
  await phone.getByLabel('Company name').fill(CLIENT.legalName);
  await phone.getByRole('button', { name: 'Open account' }).click();
  await expect(phone).toHaveURL(/\/exchange/);
  did(deal, 'CLIENT', 'signs up with an email code and opens its company account');

  // A second way to confirm changes: an authenticator app, its key typed in as a person who cannot scan would.
  await phone.getByRole('button', { name: 'Set up', exact: true }).click();
  // Telegram first where the bot is configured; an authenticator app either way.
  const instead = phone.getByRole('button', { name: 'Use an authenticator app instead' });
  await expect(instead.or(phone.getByRole('button', { name: 'Set up authenticator' })).first()).toBeVisible();
  if (await instead.isVisible()) await instead.click();
  await phone.getByRole('button', { name: 'Set up authenticator' }).click();
  if (await phone.getByRole('heading', { name: 'First, confirm it’s you' }).isVisible().catch(() => false)) await confirmIt(phone);
  const key = phone.locator('code').filter({ hasText: /^[A-Z2-7 ]{16,}$/ }).first();
  await expect(key).toBeVisible();
  // The app shows the key as base32, the way an authenticator wants it typed; the code is the secret it encodes.
  clientTotp = new TextDecoder().decode(base32.decode((await key.innerText()).replace(/\s+/g, '')));
  await snap(phone, 'authenticator-key');
  await phone.getByRole('button', { name: 'I’ve added it' }).click();
  const sheet = phone.getByRole('dialog');
  await sheet.getByRole('checkbox', { name: 'I’ve saved them somewhere safe' }).check();
  await sheet.getByRole('button', { name: 'Continue', exact: true }).click();
  await sheet.getByLabel('Authenticator code').fill(await freshTotp(clientTotp));
  await sheet.getByRole('button', { name: 'Turn on authenticator' }).click();
  await expect(phone.getByRole('button', { name: 'Turn on authenticator' })).toBeHidden();
  did(deal, 'CLIENT', 'turns on an authenticator app');

  // Where it is paid: its bank account (to sell USDT) and its wallet (to buy).
  await phone.getByRole('button', { name: 'Bank account', exact: true }).first().click();
  let add = phone.getByRole('dialog');
  await add.getByLabel('Account holder').fill(CLIENT.legalName);
  await add.getByLabel('IFSC').fill(CLIENT.ifsc);
  await add.getByLabel('Bank', { exact: true }).fill(CLIENT.bank);
  await add.getByLabel('Account number', { exact: true }).fill(CLIENT.account);
  await add.getByLabel('Account number again').fill(CLIENT.account);
  await add.getByRole('button', { name: 'Review' }).click();
  await add.getByRole('button', { name: 'Add bank account' }).click();
  if (await add.getByLabel('Authenticator code').isVisible().catch(() => false)) await confirmIt(phone, add);
  // Added, the sheet goes and the Exchange shows where the rupees will be paid.
  await expect(phone.getByText(`${CLIENT.bank} •••• ${CLIENT.account.slice(-4)}`).first()).toBeVisible();
  await expect(add).toBeHidden();
  await snap(phone, 'bank-added');
  did(deal, 'CLIENT', 'adds its bank account, confirmed with its authenticator');

  clientWallet = encodeTronAddress(randomBytes(20));
  await phone.goto(`${w.appUrl}/destinations`);
  await phone.getByRole('button', { name: /Add wallet|Wallet/ }).first().click();
  add = phone.getByRole('dialog');
  await add.getByLabel('Wallet address').fill(clientWallet);
  await add.getByLabel('Name').fill('Treasury wallet');
  await add.getByRole('button', { name: 'Review' }).click();
  await add.getByRole('button', { name: 'Add wallet' }).click();
  if (await add.getByLabel('Authenticator code').isVisible().catch(() => false)) await confirmIt(phone, add);
  await expect(phone.getByText(clientWallet.slice(-4)).first()).toBeVisible();
  did(deal, 'CLIENT', 'adds its USDT wallet, confirmed with its authenticator');

  const client = await w.db.selectFrom('client').select(['exchange_access']).where('legal_name', '=', CLIENT.legalName).executeTakeFirstOrThrow();
  expect(client.exchange_access).toBe(true);
});

test('BUY, priced by a person (automatic prices off, as in production): the client pays the trader and attaches the receipt', async ({ browser }) => {
  const deal = 'BUY · manual price';
  await ask('BUY_USDT', '1000');
  await expect(phone.getByText(/pricing this request|Getting the best price/).first()).toBeVisible();
  did(deal, 'CLIENT', 'asks for a price for 1,000 USDT');
  // Nothing moves until a person at INRP2P prices it.
  const request = await w.db.selectFrom('trade_request').select(['id', 'ref', 'status', 'client_id']).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
  expect(request.status).toBe('OPEN');
  expect(await w.db.selectFrom('trader_order').select('id').where('trade_request_id', '=', request.id).execute()).toEqual([]);

  const op = await operator(browser);
  await op.bringToFront();
  // The request waits on the operator's Desk queue; the operator opens it there.
  await op.goto(`${w.deskUrl}/`);
  await op.getByText(request.ref).first().click();
  const quote = op.getByTestId('quote-panel');
  await expect(quote).toBeVisible();
  await quote.getByLabel('Client rate (INR per USDT)').fill('102.00');
  await quote.getByRole('button', { name: 'Route to a trader' }).click();
  await expect(op.getByTestId('trader-section')).toContainText('offered — waiting for the trader');
  did(deal, 'OPERATOR', 'sets the client rate and routes the request to a trader');

  await traderPhone.bringToFront();
  await traderPhone.goto(`${w.appUrl}/sign-in?next=${encodeURIComponent('/traders')}`);
  await signIn(traderPhone, TRADER.email);
  await expect(traderPhone).toHaveURL(/\/traders/);
  await traderPhone.getByRole('button', { name: /^Accept/ }).first().click();
  await expect(traderPhone.getByRole('button', { name: /^Accept/ })).toHaveCount(0);
  did(deal, 'TRADER', 'accepts the order on its phone');

  await op.bringToFront();
  await op.reload();
  await pressUntilFocused(op, op.getByTestId('quote-panel').getByLabel('Client rate (INR per USDT)'));
  await op.getByTestId('quote-panel').getByRole('button', { name: 'Send quote' }).click();
  await expect(op.getByText(/Sent|sent/).first()).toBeVisible();
  did(deal, 'OPERATOR', 'sends the firm quote');

  await phone.bringToFront();
  await phone.goto(`${w.appUrl}/exchange`);
  // ADR 0028: the deal's network is the client's own line — 1,004.5 USDT priced at ₹102 for 1,000 received.
  await expect(phone.getByText('Network fee')).toBeVisible();
  await expect(phone.getByText(/4\.5\d* USDT — what TRON charges/)).toBeVisible();
  await phone.getByRole('button', { name: /^Accept quote at/ }).click();
  await expect(phone).toHaveURL(/\/trades\/IX-/);
  const trade = await tradeOnPhone('BUY_USDT');
  expect(await rupeesOf(trade.id)).toBe('102459.00');
  did(deal, 'CLIENT', 'accepts the quote — its USDT at the rate, and the network as its own line');

  // The trader funds the escrow from its wallet.
  const order = await orderOfTrade(trade.id);
  await traderPhone.bringToFront();
  await traderPhone.goto(`${w.appUrl}/traders/orders/${order.ref}`);
  await traderPhone.getByRole('button', { name: 'Show the escrow address' }).click();
  const escrow = await escrowOf(trade.id);
  await expect(traderPhone.getByText(escrow).first()).toBeVisible();
  await snap(traderPhone, 'trader-escrow-address');
  did(deal, 'TRADER', 'opens the escrow address and sends its USDT from its wallet app');
  await w.sendUsdt(w.traderWalletAddress, escrow, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
  did(deal, 'SYSTEM', 'the chain scanner sees the USDT in escrow (tron_scan / tron_confirm)');

  // The client pays the trader's own account, types the bank's UTR and attaches the bank app's receipt.
  await phone.bringToFront();
  await phone.reload();
  await payInr(phone, browser, { amount: await rupeesOf(trade.id), payee: TRADER.legalName, account: TRADER.account, utr: '612345678901', fromBank: CLIENT.bank });
  await phone.getByLabel(/Message the/).fill('Paid by IMPS from HDFC, receipt attached');
  await phone.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(phone.getByText('Paid by IMPS from HDFC, receipt attached')).toBeVisible();
  did(deal, 'CLIENT', 'pays by IMPS, enters the UTR, attaches the receipt, writes in the deal chat');

  // The trader sees the claim, the receipt and the message, checks its bank, names the sender and releases.
  await traderPhone.bringToFront();
  await traderPhone.reload();
  await expect(traderPhone.getByText('612345678901').first()).toBeVisible();
  await expect(traderPhone.getByText('Paid by IMPS from HDFC, receipt attached')).toBeVisible();
  await confirmInr(traderPhone, { sender: CLIENT.legalName.toUpperCase() });
  did(deal, 'TRADER', 'opens the receipt, checks its bank, types the sender’s name and releases the escrow');

  expect(await w.settle(trade.id)).toBe('COMPLETED');
  did(deal, 'SYSTEM', 'the signer pays the client’s wallet out of the escrow (onchain_cycle)');
  expect(w.chain.balanceOf(clientWallet)).toBe(1_000_000_000n);
  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText('Completed', { exact: false }).first()).toBeVisible();
  await snap(phone, 'buy-completed');
  // Every person's file is the deal's: the receipt is stored once, with the payment it proves.
  const files = await w.db.selectFrom('deal_file').select(['content_type', 'byte_size']).where('trade_id', '=', trade.id).execute();
  expect(files).toHaveLength(1);
  expect(files[0]!.content_type).toMatch(/^image\//);
});

test('SELL, priced at once (automatic prices on): the trader pays the client and attaches its receipt — no operator', async ({ browser }) => {
  const deal = 'SELL · instant price';
  await w.automaticPricesOn();
  did(deal, 'OPERATOR', 'the owner switches automatic prices and price requests on — once, not per deal');
  // The bid is ₹101 and the ask ₹102: Arjun buys 0.30% over the bid (₹101.30) and sells 0.30% under the ask (₹101.70).
  await followTheMarket('Buy USDT', '0.30', /Now ₹101\.30/);
  await followTheMarket('Sell USDT', '-0.30', /Now ₹101\.70/);
  did(deal, 'TRADER', 'sets both sides to follow the market by its margin, Instant until it turns it off — once, not per deal');

  await ask('SELL_USDT', '1200');
  await expect(phone.getByRole('button', { name: /^Accept quote at/ })).toBeVisible();
  await snap(phone, 'instant-quote');
  did(deal, 'CLIENT', 'asks for a price for 1,200 USDT and gets a firm one at once');
  await phone.getByRole('button', { name: /^Accept quote at/ }).click();
  await expect(phone).toHaveURL(/\/trades\/IX-/);
  const trade = await tradeOnPhone('SELL_USDT');
  did(deal, 'CLIENT', 'accepts it');

  const deposit = await w.db.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.address', 'a.expected_amount_minor']).where('a.trade_id', '=', trade.id).executeTakeFirstOrThrow();
  await expect(phone.getByText(deposit.address).first()).toBeVisible();
  await w.sendUsdt(clientWallet, deposit.address, Money.ofMinor(deposit.expected_amount_minor!, 'USDT').toDecimalString());
  did(deal, 'CLIENT', 'sends its USDT to the deal’s address from its wallet app');
  did(deal, 'SYSTEM', 'the chain scanner sees it in escrow');

  const order = await orderOfTrade(trade.id);
  const inr = (await w.db.selectFrom('trade_economics').select('quote_inr_minor').where('trade_id', '=', trade.id).executeTakeFirstOrThrow()).quote_inr_minor;
  await traderPhone.bringToFront();
  await traderPhone.goto(`${w.appUrl}/traders/orders/${order.ref}`);
  await payInr(traderPhone, browser, { amount: Money.ofMinor(inr, 'INR').toDecimalString(), payee: CLIENT.legalName, account: CLIENT.account, utr: '623456789012', fromBank: TRADER.bank });
  did(deal, 'TRADER', 'pays the client by IMPS, enters the UTR and attaches its receipt');

  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText('623456789012').first()).toBeVisible();
  await confirmInr(phone, { sender: TRADER.legalName.toUpperCase() });
  did(deal, 'CLIENT', 'opens the receipt, checks its bank, types the sender’s name and releases the escrow');

  const before = w.chain.balanceOf(w.traderWalletAddress);
  expect(await w.settle(trade.id)).toBe('COMPLETED');
  did(deal, 'SYSTEM', 'the signer pays the trader out of the escrow');
  expect(w.chain.balanceOf(w.traderWalletAddress) - before).toBe(order.base_minor);
  await traderPhone.bringToFront();
  await traderPhone.reload();
  await expect(traderPhone.getByText(/Completed|Nothing more to do/).first()).toBeVisible();
});

test('BUY 50 USDT at the market at once: the network its own line, nobody at INRP2P in the deal', async ({ browser }) => {
  const deal = 'BUY 50 · fully automatic';
  await ask('BUY_USDT', '50');
  const card = phone.getByRole('region', { name: 'Firm quote' });
  await expect(card.getByRole('button', { name: /^Accept quote at ₹102\.00/ })).toBeVisible();
  await expect(card.getByText('Network fee')).toBeVisible();
  await expect(card.getByText(/You pay ₹5,?559 · your USDT and 4\.50? USDT of network/)).toBeVisible();
  await snap(phone, 'small-buy-quote');
  did(deal, 'CLIENT', 'asks for 50 USDT and gets a firm price at the market at once, the network shown as its own line');
  await card.getByRole('button', { name: /^Accept quote at/ }).click();
  await expect(phone).toHaveURL(/\/trades\/IX-/);
  const trade = await tradeOnPhone('BUY_USDT');
  did(deal, 'CLIENT', 'accepts it');
  const order = await w.db.selectFrom('trader_order').select(['ref', 'base_minor', 'rate_micro', 'rate_offset_bps', 'rate_reference_snapshot_id']).where('trade_id', '=', trade.id).executeTakeFirstOrThrow();
  expect(order).toMatchObject({ rate_micro: 101_700_000n, rate_offset_bps: -30 });
  expect(order.rate_reference_snapshot_id).not.toBeNull();

  await traderPhone.bringToFront();
  await traderPhone.goto(`${w.appUrl}/traders/orders/${order.ref}`);
  await traderPhone.getByRole('button', { name: 'Show the escrow address' }).click();
  await w.sendUsdt(w.traderWalletAddress, await escrowOf(trade.id), Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
  did(deal, 'TRADER', 'funds the escrow — its order was accepted for it, at its market rate');

  await phone.bringToFront();
  await phone.reload();
  await payInr(phone, browser, { amount: await rupeesOf(trade.id), payee: TRADER.legalName, account: TRADER.account, utr: '645678901234', fromBank: CLIENT.bank });
  did(deal, 'CLIENT', 'pays ₹5,559 by IMPS, enters the UTR, attaches the receipt');

  await traderPhone.bringToFront();
  await traderPhone.reload();
  await confirmInr(traderPhone, { sender: CLIENT.legalName.toUpperCase() });
  did(deal, 'TRADER', 'checks its bank, names the sender, releases the escrow');

  const before = w.chain.balanceOf(clientWallet);
  expect(await w.settle(trade.id)).toBe('COMPLETED');
  did(deal, 'SYSTEM', 'the signer pays the client its 50 USDT in full out of the escrow');
  expect(w.chain.balanceOf(clientWallet) - before).toBe(50_000_000n);
});

test('a payment the trader says never came: the client adds its side, and a person at INRP2P decides', async ({ browser }) => {
  const deal = 'BUY · disputed';
  await ask('BUY_USDT', '1000');
  await phone.getByRole('button', { name: /^Accept quote at/ }).click();
  await expect(phone).toHaveURL(/\/trades\/IX-/);
  const trade = await tradeOnPhone('BUY_USDT');
  did(deal, 'CLIENT', 'asks, gets a firm price at once, accepts');

  const order = await orderOfTrade(trade.id);
  await traderPhone.bringToFront();
  await traderPhone.goto(`${w.appUrl}/traders/orders/${order.ref}`);
  await traderPhone.getByRole('button', { name: 'Show the escrow address' }).click();
  const escrow = await escrowOf(trade.id);
  await w.sendUsdt(w.traderWalletAddress, escrow, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
  did(deal, 'TRADER', 'funds the escrow');

  await phone.bringToFront();
  await phone.reload();
  await payInr(phone, browser, { amount: await rupeesOf(trade.id), payee: TRADER.legalName, account: TRADER.account, utr: '634567890123', fromBank: CLIENT.bank });
  did(deal, 'CLIENT', 'pays, enters the UTR, attaches the receipt');

  await traderPhone.bringToFront();
  await traderPhone.reload();
  await traderPhone.getByRole('button', { name: 'It hasn’t arrived' }).click();
  await traderPhone.getByLabel(/For INRP2P/).fill('No credit for this UTR in my ICICI statement yet');
  await traderPhone.getByRole('button', { name: 'Tell INRP2P' }).click();
  await expect(traderPhone.getByText(/has not arrived|hasn’t arrived/).first()).toBeVisible();
  did(deal, 'TRADER', 'says the rupees have not arrived');

  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText('The seller says your', { exact: false }).first()).toBeVisible();
  const side = phone.getByRole('region', { name: 'Add your side for INRP2P' }).first();
  await side.getByLabel('For INRP2P').fill('Paid by IMPS from HDFC ••2346 at 14:02, UTR 634567890123 — receipt in the chat');
  await side.getByRole('button', { name: 'Send to INRP2P' }).click();
  await expect(phone.getByText('Paid by IMPS from HDFC ••2346').first()).toBeVisible();
  await snap(phone, 'client-adds-its-side');
  did(deal, 'CLIENT', 'adds its side for INRP2P');

  // Nothing releases or returns the escrow now but a person at INRP2P, from the payee's bank evidence.
  expect(await w.settle(trade.id)).toBe('FIRST_LEG_DETECTED');
  expect(await w.db.selectFrom('chain_send').select('purpose').where('trade_id', '=', trade.id).execute()).toEqual([]);
  const op = await operator(browser);
  await op.bringToFront();
  await op.goto(`${w.deskUrl}/orders/${trade.ref}`);
  const decision = op.getByTestId('p2p-decision');
  await expect(decision).toBeVisible();
  await decision.getByText('Paid — release the escrow').click();
  await decision.getByLabel(/Sender, as the/).fill(CLIENT.legalName.toUpperCase());
  await decision.getByLabel('Evidence').fill('Trader’s ICICI statement, shared on a call: credit of ₹1,02,459 at 14:09 from KAVERI EXPORTS, UTR 634567890123');
  await snap(op, 'operator-decides');
  await decision.getByRole('button', { name: 'Decide paid' }).click();
  await expect(op.getByTestId('p2p-decision')).toBeHidden();
  did(deal, 'OPERATOR', 'reads both sides and the bank evidence, decides paid');

  expect(await w.settle(trade.id)).toBe('COMPLETED');
  did(deal, 'SYSTEM', 'the signer pays the client out of the escrow');
  await phone.bringToFront();
  await phone.reload();
  await expect(phone.getByText('Completed', { exact: false }).first()).toBeVisible();
});
