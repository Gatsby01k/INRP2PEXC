import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { type Locator, type Page, expect } from '@playwright/test';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { type Db, createDb, createPool } from '@inrp2p/db';
import { DualProviderChainVerifier } from '@inrp2p/adapters';
import { FAKE_USDT_CONTRACT, FakeCustodyAdapter, FakeTronChain, FakeTronProvider, testFieldProtector } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor } from '@inrp2p/identity';
import { acceptQuote } from '@inrp2p/quotes';
import { runTronConfirm, runTronScan } from '@inrp2p/scanner';
import { type E2EOperator, type E2EState, STATE_FILE, totpFor } from './world.ts';

export const state = (): E2EState => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2EState;

let db: Db | undefined;
export function appDb(): Db {
  if (!db) db = createDb(createPool({ connectionString: state().databaseUrl, applicationName: 'inrp2p-e2e-harness' }));
  return db;
}

/** Signs in through the real form: password, then the authenticator code (SECURITY §2.1). */
export async function signIn(page: Page, who: E2EOperator): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Work email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authenticator code').fill(await totpFor(who.totpSecret));
  await page.getByRole('button', { name: 'Verify and open the desk' }).click();
  // Exact: the sign-in page's own heading is "INRP2P Desk", which a substring match would happily accept.
  await expect(page.getByRole('heading', { name: 'Desk', exact: true })).toBeVisible();
}

/**
 * Tabs forward until the given control has focus. A keyboard-only run must not teleport focus with `.focus()`:
 * if the desk's tab order cannot reach a control, the operator cannot either, and the run should fail.
 */
export async function pressUntilFocused(page: Page, target: Locator, maxPresses = 40): Promise<void> {
  await expect(target).toBeVisible();
  for (let i = 0; i < maxPresses; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Signs in the way a dealer with no mouse does: Tab, type, Enter. */
export async function signInWithKeyboard(page: Page, who: E2EOperator): Promise<void> {
  await page.goto('/sign-in');
  await pressUntilFocused(page, page.getByLabel('Work email'));
  await page.keyboard.type(who.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(who.password);
  await pressUntilFocused(page, page.getByRole('button', { name: 'Continue' }));
  await page.keyboard.press('Enter');
  await pressUntilFocused(page, page.getByLabel('Authenticator code'));
  await page.keyboard.type(await totpFor(who.totpSecret));
  await pressUntilFocused(page, page.getByRole('button', { name: 'Verify and open the desk' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Desk', exact: true })).toBeVisible();
}

/** Answers the step-up dialog the desk raises for a ⧗ action, and fails if it was never raised. */
export async function stepUp(page: Page, who: E2EOperator, opts: { keyboard?: boolean } = {}): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Verify to continue' });
  await expect(dialog).toBeVisible();
  const code = await totpFor(who.totpSecret);
  if (opts.keyboard) {
    await pressUntilFocused(page, dialog.getByLabel('Authenticator code'));
    await page.keyboard.type(code);
    await pressUntilFocused(page, dialog.getByRole('button', { name: 'Verify and confirm' }));
    await page.keyboard.press('Enter');
  } else {
    await dialog.getByLabel('Authenticator code').fill(code);
    await dialog.getByRole('button', { name: 'Verify and confirm' }).click();
  }
  await expect(dialog).toBeHidden();
}

/** Asserts the desk went straight through, because the sign-in verification is still inside the window. */
export async function noStepUp(page: Page): Promise<void> {
  await expect(page.getByRole('dialog', { name: 'Verify to continue' })).toBeHidden();
}

/**
 * Ages every step-up verification past its window (SECURITY §2.1, `STEP_UP_MAX_AGE_SECONDS`). Signing in
 * verifies TOTP, so without this the whole demo would sit inside one ten-minute window and never exercise the
 * re-verification path. Moving the clock is the harness's job; the desk's own rule is left untouched.
 */
export async function expireStepUp(): Promise<void> {
  await appDb()
    .updateTable('step_up_verification')
    .set({ verified_at: new Date(Date.now() - 3_600_000) })
    .execute();
}

/**
 * The two things the operator product cannot do, done the way the real world does them:
 * the client accepts their own quote (D-01), and the chain delivers the USDT.
 */
export async function acceptAsClient(quoteId: string): Promise<{ tradeId: string; tradeRef: string }> {
  const s = state();
  const session = await appDb()
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: s.acceptorUserId, surface: 'CLIENT' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const actor: ClientActor = { kind: 'CLIENT', userId: s.acceptorUserId, sessionId: session.id };
  const out = await executeCommand(
    appDb(),
    acceptQuote(actor, { custody: custodyForAcceptance(), protector: testFieldProtector('e2e-kek') }),
    {
      name: 'quote.accept',
      actor: { type: 'USER', id: s.acceptorUserId, surface: 'CLIENT', sessionId: session.id },
      payload: { quoteId },
      idempotencyKey: randomUUID(),
      financial: true,
    },
  );
  return out.result as { tradeId: string; tradeRef: string };
}

// Acceptance allocates a deposit address from the pool that was imported during seeding.
const custodyForAcceptance = () => new FakeCustodyAdapter({ capability: 'POOL', poolSize: 20, seed: 'e2e' });

/** The client sends the USDT, and the scanner does what it does in production: detect, then confirm. */
export async function clientSendsUsdt(tradeId: string, amount: string): Promise<void> {
  const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
  const primary = new FakeTronProvider('e2e-node-a', chain);
  const secondary = new FakeTronProvider('e2e-node-b', chain);
  const deps = {
    chain: new DualProviderChainVerifier({ primary, secondary, tokenContract: FAKE_USDT_CONTRACT }),
    provider: primary,
    scanner: { scanner: `e2e_${Date.now()}` },
  };
  const address = await appDb()
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select('d.address')
    .where('a.trade_id', '=', tradeId)
    .executeTakeFirstOrThrow();
  chain.add({ to: address.address, amountMinor: Money.parse(amount, 'USDT').minor });
  chain.solidifyAll();
  await runTronScan(appDb(), deps);
  await runTronConfirm(appDb(), deps);
}

export async function tradeState(tradeId: string): Promise<string> {
  const r = await appDb().selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow();
  return r.lifecycle_state;
}

/** Realized gross margin in the ledger — the figure the demo scenario has to land on (FI-43). */
export async function realizedMargin(): Promise<string> {
  const r = await sql<{ net: string }>`
    select coalesce(sum(case e.direction when 'CR' then e.amount_minor else -e.amount_minor end), 0)::text as net
    from ledger_entry e join ledger_account a on a.id = e.account_id
    where a.code = 'REVENUE:GROSS_MARGIN'`.execute(appDb());
  return Money.ofMinor(BigInt(r.rows[0]!.net), 'INR').toDecimalString();
}

export async function latestSentQuoteId(clientId: string): Promise<string> {
  const r = await appDb()
    .selectFrom('quote')
    .select('id')
    .where('client_id', '=', clientId)
    .where('status', '=', 'SENT')
    .orderBy('sent_at', 'desc')
    .executeTakeFirstOrThrow();
  return r.id;
}
