import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { encodeTronAddress } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { FakeCustodyAdapter, testFieldProtector } from '@inrp2p/adapters/testing';
import type { ClientActor } from '@inrp2p/identity';
import { createTestClientLogin, createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes } from '@inrp2p/clients';
import { createRoute, configureRoute } from '@inrp2p/routes';
import { publishRouteRate } from '@inrp2p/pricing';
import { importPoolAddresses, recordCustodyCapability, registerTreasuryWallet } from '@inrp2p/treasury';
import type { QuoteDeps } from '../src/index.ts';

export const ipHash = (ip = '203.0.113.9') => createHash('sha256').update(ip).digest('hex');

export interface ClientPerson {
  readonly userId: string;
  readonly clientUserId: string;
  readonly actor: ClientActor;
  readonly ref: { type: 'USER'; id: string; surface: 'CLIENT'; sessionId: string };
  readonly email: string;
}

export interface Scenario {
  readonly t: TestDatabase;
  readonly app: Db;
  readonly owner: TestOperator;
  readonly dealer: TestOperator;
  readonly finance: TestOperator;
  readonly deps: QuoteDeps;
  readonly clientId: string;
  readonly bankAccountId: string;
  readonly walletId: string;
  readonly routeId: string;
  /** Can accept quotes, verified email. */
  readonly acceptor: ClientPerson;
  /** Member of the client without acceptance authority. */
  readonly viewer: ClientPerson;
  /** Can accept quotes but has not verified their email (link OTP must refuse them). */
  readonly unverified: ClientPerson;
  close(): Promise<void>;
}

async function person(t: TestDatabase, owner: TestOperator, clientId: string, opts: { canAccept: boolean; emailVerified?: boolean; role?: 'CLIENT_ADMIN' | 'CLIENT_TRADER' }): Promise<ClientPerson> {
  const login = await createTestClientLogin(t.owner, { emailVerified: opts.emailVerified ?? true, stepUp: 'fresh' });
  const linked = await runAs(t.app, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId, userId: login.userId, role: opts.role ?? 'CLIENT_TRADER' });
  if (opts.canAccept) {
    await runAs(t.app, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  }
  const email = (await t.owner.selectFrom('auth_user').select('email').where('id', '=', login.userId).executeTakeFirstOrThrow()).email;
  return {
    userId: login.userId,
    clientUserId: linked.clientUserId,
    actor: { kind: 'CLIENT', userId: login.userId, sessionId: login.sessionId },
    ref: login.ref as ClientPerson['ref'],
    email,
  };
}

/**
 * A complete Phase 3 world: operators, an ACTIVE client with a bank account and a destination wallet, three client
 * users, an ACTIVE route with a fresh rate in both directions, recorded POOL custody with imported addresses and a
 * funded HOT treasury wallet (so BUY `TO_EXCHANGE` acceptance can reserve).
 */
export async function createScenario(label: string, opts: { custody?: 'POOL' | 'UNSUPPORTED'; hotBalanceUsdt?: string } = {}): Promise<Scenario> {
  const t = await createTestDatabase(label);
  const owner = await createTestOperator(t.owner, ['OWNER']);
  const dealer = await createTestOperator(t.owner, ['DEALER']);
  const finance = await createTestOperator(t.owner, ['FINANCE']);
  const custody = new FakeCustodyAdapter({ capability: 'POOL' });

  const client = await runAs(t.app, createClient(dealer.actor), dealer.ref, 'client.create', { legalName: 'Acme Pay Private Limited', displayName: 'Acme Pay', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const });
  const bank = await runAs(t.app, addBankAccount(owner.actor, testFieldProtector()), owner.ref, 'client_bank.add', {
    clientId: client.clientId, holderName: 'Acme Pay Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100123458219', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const wallet = await runAs(t.app, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
    clientId: client.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'DESTINATION' as const, label: 'Client wallet',
  });

  const route = await runAs(t.app, createRoute(owner.actor), owner.ref, 'routes.create', {
    name: `Route ${randomUUID().slice(0, 8)}`, direction: 'BOTH' as const, executionMode: 'DIRECT_TO_CLIENT' as const, registeredRouteAddress: encodeTronAddress(randomBytes(20)), availableBaseUsdt: '5000000',
  });
  await runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route', { routeId: route.routeId, direction: 'SELL_USDT' as const, rate: '92.500000' });
  await runAs(t.app, publishRouteRate(dealer.actor), dealer.ref, 'rates.publish_route', { routeId: route.routeId, direction: 'BUY_USDT' as const, rate: '93.500000' });

  const pool = await runAs(t.app, registerTreasuryWallet(finance.actor), finance.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Deposit pool', role: 'DEPOSIT_POOL' as const });
  const hot = await runAs(t.app, registerTreasuryWallet(finance.actor), finance.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Hot wallet', role: 'HOT' as const });
  // Balance observation is Phase 4's job; the fixture writes it directly so acceptance can reserve against it.
  await sql`update treasury_wallet set observed_balance_minor = ${BigInt(opts.hotBalanceUsdt ?? '1000000') * 1_000_000n}, observed_at = statement_timestamp(), updated_at = statement_timestamp() where id = ${hot.walletId}`.execute(t.owner);
  if ((opts.custody ?? 'POOL') === 'POOL') {
    await runAs(t.app, recordCustodyCapability(finance.actor), finance.ref, 'custody.record_capability', { provider: custody.provider, network: 'TRON' as const, capability: 'POOL' as const, consolidationNotes: 'Provider sweeps to the hot wallet; energy delegated.' });
    await runAs(t.app, importPoolAddresses(finance.actor, custody), finance.ref, 'custody.import_pool_addresses', { network: 'TRON' as const, treasuryWalletId: pool.walletId });
  }

  const acceptor = await person(t, owner, client.clientId, { canAccept: true, role: 'CLIENT_ADMIN' });
  const viewer = await person(t, owner, client.clientId, { canAccept: false });
  const unverified = await person(t, owner, client.clientId, { canAccept: true, emailVerified: false });

  return {
    t, app: t.app, owner, dealer, finance,
    deps: { protector: testFieldProtector(), custody },
    clientId: client.clientId,
    bankAccountId: bank.bankAccountId,
    walletId: wallet.walletId,
    routeId: route.routeId,
    acceptor, viewer, unverified,
    close: () => t.close(),
  };
}

/** Switches the scenario route to `TO_EXCHANGE` so BUY acceptance reserves treasury USDT (FI-33). */
export async function useExchangeExecution(s: Scenario, expectedVersion = 1): Promise<void> {
  await runAs(s.app, configureRoute(s.owner.actor), s.owner.ref, 'routes.configure', { routeId: s.routeId, expectedVersion, executionMode: 'TO_EXCHANGE' as const, reason: 'provider settles to our exchange account' });
}

export { runAs, setCanAcceptQuotes };
