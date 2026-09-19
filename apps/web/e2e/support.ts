import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type Locator, type Page, expect } from '@playwright/test';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { type Db, createDb, createPool } from '@inrp2p/db';
import { DualProviderChainVerifier, UnconfiguredChainVerifier } from '@inrp2p/adapters';
import { FAKE_USDT_CONTRACT, FakeCustodyAdapter, FakeNotificationAdapter, FakeTronChain, FakeTronProvider } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor, DomainCommand, OperatorActor } from '@inrp2p/identity';
import { acceptQuote, acceptanceCodeHandler, createQuote, createQuoteLink, createRequest, deliverAcceptanceCode, sendQuote } from '@inrp2p/quotes';
import { createPayoutLeg, confirmPayout, recordLegEvidence, sendPayoutLeg } from '@inrp2p/settlement';
import { acknowledgedSignalHandler, clientNotificationHandler } from '@inrp2p/notifications';
import { dispatchOutbox } from '@inrp2p/outbox';
import { runTronConfirm, runTronScan } from '@inrp2p/scanner';
import { deskBaseUrl, surfacePorts } from '../harness/desk-server.ts';
import { OTP_SINK_FILE } from './global-setup.ts';
import { type E2EOperator, type E2EState, STATE_FILE, e2eFieldProtector, totpFor } from './world.ts';

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
    acceptQuote(actor, { custody: custodyForAcceptance(), protector: e2eFieldProtector() }),
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

/* ------------------------------------------------------------------ *
 * Phase 7: the client product                                         *
 * ------------------------------------------------------------------ */

/** The three origins the run browses. One address, three ports, three surfaces (see `harness/desk-server.ts`). */
const PORTS = surfacePorts(Number.parseInt(process.env.E2E_PORT ?? '3210', 10));
export const appBaseUrl = (): string => deskBaseUrl(PORTS.app);
export const linkBaseUrl = (): string => deskBaseUrl(PORTS.public);

/** A server-side operator session with a fresh step-up, for the desk-side steps a client journey depends on. */
async function operatorSession(who: E2EOperator): Promise<{ actor: OperatorActor; ref: { type: 'USER'; id: string; surface: 'OPERATOR'; sessionId: string } }> {
  const user = await appDb().selectFrom('auth_user').select('id').where('email', '=', who.email).executeTakeFirstOrThrow();
  const session = await appDb()
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: user.id, surface: 'OPERATOR' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${user.id}, ${session.id}, 'TOTP', statement_timestamp())`.execute(appDb());
  return {
    actor: { kind: 'OPERATOR', userId: user.id, sessionId: session.id, roles: [...who.roles], grants: [] },
    ref: { type: 'USER', id: user.id, surface: 'OPERATOR', sessionId: session.id },
  };
}

async function asOperator<P, R>(who: E2EOperator, def: (o: Awaited<ReturnType<typeof operatorSession>>) => DomainCommand<P, R>, name: string, payload: P): Promise<R> {
  const o = await operatorSession(who);
  const out = await executeCommand(appDb(), def(o), { name, actor: o.ref, payload, idempotencyKey: randomUUID(), financial: true });
  return out.result;
}

/**
 * The desk side of a client journey: a request, a price, a sent quote and a shareable link — through the real
 * commands, with the real authorization. The client spec is about the client product, so the desk's own screens
 * are exercised by the operator specs; what matters here is that what the client opens is a real quote.
 */
export async function deskSendsQuoteWithLink(input: { amount: string; clientRate: string; validitySeconds?: number }): Promise<{ quoteRef: string; token: string; quoteId: string }> {
  const s = state();
  const request = await asOperator(s.owner, (o) => createRequest(o.actor, {}), 'request.create', {
    clientId: s.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: input.amount, bankAccountId: s.bankAccountId,
  });
  const quote = await asOperator(s.owner, (o) => createQuote(o.actor, {}), 'quote.create', {
    requestId: request.requestId, routeId: s.routeId, clientRate: input.clientRate, validitySeconds: input.validitySeconds ?? 600,
  });
  await asOperator(s.owner, (o) => sendQuote(o.actor, {}), 'quote.send', { quoteId: quote.quoteId });
  let token = '';
  await asOperator(s.owner, (o) => createQuoteLink(o.actor, {}, (t) => { token = t; }), 'quote_link.create', { quoteId: quote.quoteId });
  const row = await appDb().selectFrom('quote').select('ref').where('id', '=', quote.quoteId).executeTakeFirstOrThrow();
  return { quoteRef: row.ref, token, quoteId: quote.quoteId };
}

/**
 * Plays the email provider for an acceptance code, through the product's own delivery path: the code lives only
 * sealed in `otp_delivery`, and `deliverAcceptanceCode` is what opens it, hands it over and erases it. Reading
 * the column directly would prove less and would also leave the code behind.
 */
export async function acceptanceCodeFor(quoteId: string): Promise<string> {
  const delivery = await appDb()
    .selectFrom('otp_delivery as d')
    .innerJoin('acceptance_challenge as c', 'c.id', 'd.challenge_id')
    .select('d.id')
    .where('c.quote_id', '=', quoteId)
    .where('d.code_sealed', 'is not', null)
    .orderBy('d.created_at', 'desc')
    .executeTakeFirstOrThrow();
  const mailbox = new FakeNotificationAdapter();
  await deliverAcceptanceCode(appDb(), { protector: e2eFieldProtector() }, mailbox, { deliveryId: delivery.id });
  const code = mailbox.sent.at(-1)?.code;
  if (!code) throw new Error('no acceptance code was delivered');
  return code;
}

/** Every sign-in code written for an address so far, oldest first. */
async function signInCodes(email: string): Promise<string[]> {
  const lines = (await readFile(OTP_SINK_FILE, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l) as { email: string; otp: string }).filter((m) => m.email === email).map((m) => m.otp);
}

/**
 * The next sign-in code for an address, from the run's own sink file (test-only; the runtime refuses it in
 * production). `after` is how many codes that address had **before** this request, so a second sign-in in the
 * same run cannot pick up the first one's code and fail on a stale six digits.
 */
export async function clientSignInCode(email: string, after = 0): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const codes = await signInCodes(email);
    if (codes.length > after) return codes.at(-1)!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no new sign-in code was written for ${email}`);
}

/** Signs a client in through the real form: an address the desk knows, then the code sent to it. */
export async function signInAsClient(page: Page, email: string): Promise<void> {
  const before = (await signInCodes(email)).length;
  await page.goto(`${appBaseUrl()}/sign-in`);
  await page.getByLabel('Work email').fill(email);
  await page.getByRole('button', { name: 'Send me a code' }).click();
  await page.getByLabel('Six-digit code').fill(await clientSignInCode(email, before));
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Exact: the sign-in page's own heading is "INRP2P Exchange", which a substring match would happily accept.
  await expect(page.getByRole('heading', { name: 'Exchange', exact: true })).toBeVisible();
}

/** The desk pays an INR leg and confirms it, which is what moves a client's trade towards settled. */
export async function deskPaysOut(tradeId: string, amount: string): Promise<void> {
  const s = state();
  const leg = await asOperator(s.settlementOperator, (o) => createPayoutLeg(o.actor, {}), 'payout_leg.create', {
    tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: s.inrAccountId,
  });
  await asOperator(s.settlementOperator, (o) => sendPayoutLeg(o.actor), 'payout_leg.send', { legId: leg.legId });
  const utr = `HDFCR${Date.now()}`.slice(0, 22);
  await asOperator(s.settlementOperator, (o) => recordLegEvidence(o.actor, settlementDeps()), 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr });
  const o = await operatorSession(s.settlementOperator);
  await confirmPayout(appDb(), o.actor, settlementDeps(), { legId: leg.legId, idempotencyKey: randomUUID() });
}

const settlementDeps = () => ({ chain: new UnconfiguredChainVerifier() });

export async function tradeIdForRef(ref: string): Promise<string> {
  const r = await appDb().selectFrom('trade').select('id').where('ref', '=', ref).executeTakeFirstOrThrow();
  return r.id;
}

/**
 * Runs the outbox the way the worker does, so the client's inbox exists for the same reason it does in
 * production: a command wrote a state change and enqueued an event, and a handler turned that event into a
 * message. Nothing here writes a notification directly.
 */
export async function deliverNotifications(): Promise<void> {
  await dispatchOutbox(appDb(), [
    clientNotificationHandler(appDb()),
    acknowledgedSignalHandler(),
    acceptanceCodeHandler(appDb(), { protector: e2eFieldProtector() }, new FakeNotificationAdapter()),
  ]);
}
