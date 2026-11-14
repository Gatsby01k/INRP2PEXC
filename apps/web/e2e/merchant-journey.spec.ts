import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { type BrowserContext, type Page, devices, expect, test } from '@playwright/test';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { surfacePorts, deskBaseUrl } from '../harness/desk-server.ts';
import { HUMAN_OTP_SINK, type HumanWorld, createHumanWorld } from './human-world.ts';

/**
 * A merchant's way in, as a stranger walks it on its phone (ADR 0028): the public page, "Open your exchange", the code,
 * the three-step application, the checklist that names the next step, the Security Reserve sent first, the programme's
 * review, both sides set in one screen and online, then its own page priced as on Traders. Every screen can be kept
 * (MERCHANT_SHOTS=<dir>) with what it took — fields, taps, seconds — so the journey is judged, not guessed.
 */
test.describe.configure({ mode: 'serial' });

const PORT = Number.parseInt(process.env.E2E_MERCHANT_PORT ?? '3250', 10);
const SHOTS = process.env.MERCHANT_SHOTS ?? '';
const M = { email: 'rohan@rohanp2p.test', name: 'Rohan Mehta', telegram: '@rohan_p2p', bank: 'HDFC Bank', ifsc: 'HDFC0001234', account: '50100234567891' } as const;

let w: HumanWorld;
let phone: Page;
const contexts: BrowserContext[] = [];
let shot = 0;
const log: { step: string; fields: number; taps: number; seconds: number }[] = [];
let mark = Date.now();
let fields = 0;
let taps = 0;
const wallet = encodeTronAddress(randomBytes(20));

async function snap(name: string): Promise<void> {
  log.push({ step: name, fields, taps, seconds: Math.round((Date.now() - mark) / 100) / 10 });
  fields = 0;
  taps = 0;
  mark = Date.now();
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  shot += 1;
  await phone.screenshot({ path: path.join(SHOTS, `${String(shot).padStart(2, '0')}-${name}.png`), fullPage: true });
}
const fill = async (l: ReturnType<Page['getByLabel']>, v: string) => {
  await l.fill(v);
  fields += 1;
};
const tap = async (l: ReturnType<Page['getByRole']>) => {
  await l.click();
  taps += 1;
};

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
  throw new Error(`no code for ${email}`);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  w = await createHumanWorld(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres', PORT);
  const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
  const context = await browser.newContext({ ...pixel });
  contexts.push(context);
  phone = await context.newPage();
});

test.afterAll(async () => {
  console.table(log);
  await Promise.all(contexts.map((c) => c.close()));
  await w?.stop();
});

test('a stranger finds the merchant door and signs in', async () => {
  const pub = deskBaseUrl(surfacePorts(PORT).public);
  await phone.goto(pub);
  await expect(phone.locator('h1').first()).toBeVisible();
  await expect(phone.getByRole('link', { name: /Open your exchange/ }).first()).toBeVisible();
  await phone.goto(`${w.appUrl}/become-a-trader`);
  await expect(phone.getByText('Step one · your email')).toBeVisible();
  await snap('become-a-trader');
  const before = (await codes(M.email)).length;
  const email = phone.getByLabel('Email', { exact: true });
  await expect.poll(() => email.evaluate((el) => Object.keys(el).some((k) => k.startsWith('__react'))), { timeout: 20_000 }).toBe(true);
  await fill(email, M.email);
  await tap(phone.getByRole('button', { name: 'Continue' }));
  await expect(phone.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await fill(phone.getByLabel('Verification code'), await nextCode(M.email, before));
  await expect(phone.getByRole('heading', { name: 'Traders', exact: true })).toBeVisible();
  // The reserve is named, with its amount, before anyone starts.
  await expect(phone.getByText('2,000 USDT', { exact: false }).first()).toBeVisible();
  await snap('traders-before-applying');
});

test('it applies in three steps: the bank is named from its IFSC, the holder from its name', async () => {
  await tap(phone.getByRole('link', { name: 'Apply now' }));
  await expect(phone.getByRole('form', { name: 'Trader application' })).toBeVisible();
  await expect(phone.getByRole('heading', { name: 'Apply to trade' })).toBeVisible();
  await fill(phone.getByLabel(/^Full name/), M.name);
  await tap(phone.locator('label', { hasText: 'Individual' }));
  await fill(phone.getByLabel('Telegram'), M.telegram);
  await tap(phone.locator('label', { hasText: 'Binance' }));
  await snap('apply-1-you');
  await tap(phone.getByRole('button', { name: 'Continue' }));
  await tap(phone.locator('label', { hasText: 'You buy and sell.' }));
  await fill(phone.getByLabel('Typical order, INR'), '200000');
  await fill(phone.getByLabel('INR you can provide in a day'), '2000000');
  await fill(phone.getByLabel('Typical order, USDT'), '2000');
  await fill(phone.getByLabel('USDT you can provide in a day'), '20000');
  await snap('apply-2-trade');
  await tap(phone.getByRole('button', { name: 'Continue' }));
  await expect(phone.getByLabel('Account holder')).toHaveValue(M.name);
  await fill(phone.getByLabel('Account number'), M.account);
  await fill(phone.getByLabel('IFSC'), M.ifsc);
  await expect(phone.getByLabel('Bank name')).toHaveValue('HDFC Bank');
  await fill(phone.getByLabel('TRC20 wallet address'), wallet);
  await expect(phone.getByText('Next: your Security Reserve')).toBeVisible();
  await tap(phone.getByRole('checkbox', { name: /belong to me or my company/ }));
  await snap('apply-3-settle');
  await tap(phone.getByRole('button', { name: 'Submit application' }));
  await expect(phone).toHaveURL(/\/traders$/);
  // The next step is said, first: the reserve, from this wallet.
  const start = phone.getByRole('region', { name: 'Your way to the first order' });
  await expect(start).toBeVisible();
  await expect(start.getByRole('link', { name: 'Send the reserve' })).toBeVisible();
  await snap('traders-checklist-applied');
});

test('it sends its Security Reserve first, from its own wallet', async () => {
  await tap(phone.getByRole('link', { name: 'Send the reserve' }));
  await expect(phone.getByRole('region', { name: 'Send 2,000 USDT' })).toBeVisible();
  // Nothing to take back yet: no withdrawal form in the way.
  await expect(phone.getByRole('heading', { name: 'Withdraw' })).toHaveCount(0);
  await snap('reserve-send');
  w.chain.add({ from: encodeTronAddress(randomBytes(20)), to: wallet, amountMinor: Money.parse('50000', 'USDT').minor });
  await w.sendUsdt(wallet, await w.reserveAddress(), '2000');
  await phone.goto(`${w.appUrl}/traders`);
  await expect(phone.getByText('In, and yours')).toBeVisible();
  await snap('traders-reserve-in');
});

test('the programme approves it by its rules, and the checklist moves on to prices', async () => {
  const decided = await w.reviewApplications();
  expect(decided).toEqual([expect.objectContaining({ outcome: 'APPROVED', flags: [] })]);
  // The owner's one switch: the market read and automatic prices on (the merchant's prices follow that market).
  await w.automaticPricesOn();
  await phone.goto(`${w.appUrl}/traders`);
  const start = phone.getByRole('region', { name: 'Start taking orders' });
  await expect(start.getByRole('link', { name: 'Set your prices' })).toBeVisible();
  await snap('traders-approved');
});

test('it sets both sides on one screen and goes online with one button', async () => {
  await tap(phone.getByRole('link', { name: 'Set your prices' }));
  const form = phone.getByRole('form', { name: 'Set your prices' });
  await expect(form).toBeVisible();
  // Everything starts from the application: capacity from the day's figure, the largest order from the typical one.
  await expect(form.getByLabel('INR you can provide')).toHaveValue('2000000');
  await expect(form.getByLabel('USDT you can provide')).toHaveValue('20000');
  // The bid is ₹101 and the ask ₹102: +0.20% buys at ₹101.20, −0.20% sells at ₹101.80 (paisa in the trader's favour).
  await expect(form.getByText('₹101.20 / USDT', { exact: false }).first()).toBeVisible();
  await expect(form.getByText('₹101.80 / USDT', { exact: false }).first()).toBeVisible();
  await snap('setup');
  await tap(form.getByRole('button', { name: 'Start taking orders' }));
  await expect(phone).toHaveURL(/\/traders$/);
  await expect(phone.getByRole('region', { name: /Start taking orders|Your way to the first order/ })).toHaveCount(0);
  await expect(phone.getByText('Market +0.20%')).toBeVisible();
  await expect(phone.getByText('Market −0.20%')).toBeVisible();
  await expect(phone.getByText('On until you turn it off').first()).toBeVisible();
  await snap('traders-online');
  const blocks = await w.db.selectFrom('trader_block as b').innerJoin('trader_profile as t', 't.id', 'b.trader_id').innerJoin('client as c', 'c.id', 't.client_id')
    .select(['b.side', 'b.status', 'b.rate_basis', 'b.market_offset_bps', 'b.instant_open_ended', 't.available']).where('c.display_name', '=', M.name).orderBy('b.side').execute();
  expect(blocks).toEqual([
    { side: 'BUY_USDT', status: 'ACTIVE', rate_basis: 'MARKET', market_offset_bps: 20, instant_open_ended: true, available: true },
    { side: 'SELL_USDT', status: 'ACTIVE', rate_basis: 'MARKET', market_offset_bps: -20, instant_open_ended: true, available: true },
  ]);
});

test('its own page prices as on Traders: one price for the merchant', async () => {
  await phone.goto(`${w.appUrl}/desk`);
  await fill(phone.getByLabel('Name clients see'), 'Rohan P2P');
  await tap(phone.getByRole('button', { name: 'Open desk' }));
  await expect(phone.getByRole('link', { name: /Edit prices/ })).toBeVisible();
  // Opened as a draft, its prices already as on Traders: nothing to type to have them.
  await expect(phone.getByText('No price yet')).toHaveCount(0);
  await snap('desk-today');
  await phone.goto(`${w.appUrl}/desk/prices`);
  // Both directions start "As on Traders", at the sides' rates now; no validity to choose.
  for (const name of ['As on Traders']) await expect(phone.getByRole('radio', { name: new RegExp(name) }).first()).toBeChecked();
  await expect(phone.getByText('₹101.80 now', { exact: false }).first()).toBeVisible();
  await snap('desk-prices');
  await tap(phone.getByRole('button', { name: 'Save prices' }));
  await expect(phone.getByText('Saved. Clients see them now.')).toBeVisible();
  // Prices are append-only: the latest of each direction is the price.
  const rows = await w.db.selectFrom('desk_price as p').innerJoin('desk as d', 'd.id', 'p.desk_id').select(['p.direction', 'p.basis', 'p.rate_micro', 'p.valid_until', 'p.set_at', 'p.id'])
    .where('d.display_name', '=', 'Rohan P2P').orderBy('p.direction').orderBy('p.set_at', 'desc').orderBy('p.id', 'desc').execute();
  const prices = ['BUY_USDT', 'SELL_USDT'].map((dir) => rows.find((r) => r.direction === dir)!).map(({ direction, basis, rate_micro, valid_until }) => ({ direction, basis, rate_micro, valid_until }));
  expect(rows.length).toBe(4);
  expect(prices).toEqual([
    { direction: 'BUY_USDT', basis: 'SIDE', rate_micro: null, valid_until: null },
    { direction: 'SELL_USDT', basis: 'SIDE', rate_micro: null, valid_until: null },
  ]);
});

test('it adds the UPI ID buyers pay it to, on its own — ready at once, on the first deals’ limit (ADR 0030)', async () => {
  await phone.goto(`${w.appUrl}/traders/settlement`);
  const card = phone.getByRole('region', { name: 'UPI IDs' });
  await expect(card.getByText('No UPI ID yet', { exact: false })).toBeVisible();
  await tap(card.getByRole('button', { name: 'Add UPI ID' }));
  const sheet = phone.getByRole('dialog');
  // An address made up from an account number is not a UPI ID it registers (ADR 0029).
  await fill(sheet.getByLabel('UPI ID', { exact: true }), '50100234567891@hdfc0001234.ifsc.npci');
  await expect(sheet.getByText('not one made from an account number', { exact: false })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Add UPI ID' })).toBeDisabled();
  await fill(sheet.getByLabel('UPI ID', { exact: true }), 'Rohan.P2P@okicici');
  // No name to type: buyers are told its own name — the one on its bank account — and check it in their app.
  await expect(sheet.getByLabel('Name your UPI app shows')).toHaveCount(0);
  await expect(sheet.getByText('they check it is', { exact: false })).toBeVisible();
  await snap('upi-add');
  await tap(sheet.getByRole('button', { name: 'Add UPI ID' }));
  await expect(sheet.getByRole('heading', { name: 'UPI ID added' })).toBeVisible();
  await tap(sheet.getByRole('button', { name: 'Done' }));
  await expect(card.getByText('rohan.p2p@okicici', { exact: true })).toBeVisible();
  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
  await expect(card.getByText('Up to ₹25,000 until your first deal to it is confirmed', { exact: false })).toBeVisible();
  await snap('upi-ready');
  const rows = await w.db.selectFrom('upi_id as u').innerJoin('client as c', 'c.id', 'u.client_id').select(['u.vpa', 'u.status', 'u.per_payment_limit_minor', 'u.name_confirmed_at'])
    .where('c.display_name', '=', M.name).execute();
  expect(rows).toEqual([{ vpa: 'rohan.p2p@okicici', status: 'ACTIVE', per_payment_limit_minor: 10_000_000n, name_confirmed_at: null }]);
});
