import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { createTestDatabase, type TestDatabase } from '@inrp2p/db/testing';
import { FakeChainVerifier, FakeCustodyAdapter, testFieldProtector } from '@inrp2p/adapters/testing';
import type { ClientActor } from '@inrp2p/identity';
import { createTestClientLogin, createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes } from '@inrp2p/clients';
import { runTronConfirm } from '@inrp2p/scanner';
import { submitTxForVerification } from '@inrp2p/settlement';
import { acceptOrder, applyAsTrader, approveTrader, assignRequest, setAvailability, sharedReserveAddress, updateBlock } from '@inrp2p/traders';
import { importPoolAddresses, recordCustodyCapability, registerTreasuryWallet } from '@inrp2p/treasury';
import { fundBudget, seedNetworkCosts } from '@inrp2p/network/testing';
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
  /** The fake chain every world's USDT moves on. */
  readonly chain: FakeChainVerifier;
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
 * users, recorded POOL custody with imported addresses and a HOT treasury wallet that holds nothing: deals run on the
 * trader's and the client's money (D-16), so nothing in this world needs the platform's own USDT, and nothing writes a
 * balance into a wallet behind the commands' back. A trader to deal with comes with the first deal (`scenarioTrader`).
 */
export async function createScenario(label: string, opts: { custody?: 'POOL' | 'UNSUPPORTED'; depositPoolSize?: number } = {}): Promise<Scenario> {
  const t = await createTestDatabase(label);
  const owner = await createTestOperator(t.owner, ['OWNER']);
  const dealer = await createTestOperator(t.owner, ['DEALER']);
  const finance = await createTestOperator(t.owner, ['FINANCE']);
  const custody = new FakeCustodyAdapter({ capability: 'POOL', poolSize: opts.depositPoolSize ?? 10, seed: label });
  // One protector for the world: what it seals (a bank account's number) the screens built on it can open.
  const protector = testFieldProtector();

  const client = await runAs(t.app, createClient(dealer.actor), dealer.ref, 'client.create', { legalName: 'Acme Pay Private Limited', displayName: 'Acme Pay', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const });
  const bank = await runAs(t.app, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: client.clientId, holderName: 'Acme Pay Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100123458219', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const wallet = await runAs(t.app, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
    clientId: client.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'DESTINATION' as const, label: 'Client wallet',
  });

  const pool = await runAs(t.app, registerTreasuryWallet(finance.actor), finance.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Deposit pool', role: 'DEPOSIT_POOL' as const });
  const hot = await runAs(t.app, registerTreasuryWallet(finance.actor), finance.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Hot wallet', role: 'HOT' as const });
  void hot;
  if ((opts.custody ?? 'POOL') === 'POOL') {
    await runAs(t.app, recordCustodyCapability(finance.actor), finance.ref, 'custody.record_capability', { provider: custody.provider, network: 'TRON' as const, capability: 'POOL' as const, consolidationNotes: 'Provider sweeps to the hot wallet; energy delegated.' });
    await runAs(t.app, importPoolAddresses(finance.actor, custody), finance.ref, 'custody.import_pool_addresses', { network: 'TRON' as const, treasuryWalletId: pool.walletId });
  }

  // What the chain charges and a TRX price (ADR 0017): every world can price a quote and accept a trade, as production
  // can once the worker has read the chain.
  await seedNetworkCosts(t.app);
  await fundBudget(t.app, { traderId: null, amountSun: 1_000_000_000_000n, from: encodeTronAddress(randomBytes(20)) });

  const acceptor = await person(t, owner, client.clientId, { canAccept: true, role: 'CLIENT_ADMIN' });
  const viewer = await person(t, owner, client.clientId, { canAccept: false });
  const unverified = await person(t, owner, client.clientId, { canAccept: true, emailVerified: false });

  return {
    t, app: t.app, owner, dealer, finance,
    deps: { protector, custody },
    clientId: client.clientId,
    bankAccountId: bank.bankAccountId,
    walletId: wallet.walletId,
    chain: new FakeChainVerifier(),
    acceptor, viewer, unverified,
    close: () => t.close(),
  };
}

export interface ScenarioTrader {
  readonly traderId: string;
  readonly clientId: string;
  readonly bankAccountId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  /** Administrator of the trader's account: applies, accepts its orders and moves its money. */
  readonly admin: ClientPerson;
  /** How the bank shows the trader's account as a sender. */
  readonly holderName: string;
}

const TRADERS = new WeakMap<Scenario, Promise<ScenarioTrader>>();

/** The rates the scenario's trader deals at: it buys USDT at 103.00 and sells it at 105.00. */
export const TRADER_BUYS_AT = '103.000000';
export const TRADER_SELLS_AT = '105.000000';

/** A trader with both blocks live and everything it needs to take any deal of a test: made once, with the first deal. */
export function scenarioTrader(s: Scenario): Promise<ScenarioTrader> {
  const known = TRADERS.get(s);
  if (known) return known;
  const made = makeTrader(s);
  TRADERS.set(s, made);
  return made;
}

async function makeTrader(s: Scenario): Promise<ScenarioTrader> {
  const holderName = 'Konkan Desk LLP';
  const client = await runAs(s.app, createClient(s.dealer.actor), s.dealer.ref, 'client.create', { legalName: holderName, displayName: 'Konkan Desk', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const });
  const bank = await runAs(s.app, addBankAccount(s.owner.actor, s.deps.protector), s.owner.ref, 'client_bank.add', {
    clientId: client.clientId, holderName, bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK0000123', accountNumber: String(700000000000 + Math.floor(Math.random() * 99999999999)), railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const walletAddress = encodeTronAddress(randomBytes(20));
  const wallet = await runAs(s.app, addWallet(s.owner.actor), s.owner.ref, 'client_wallet.add', { clientId: client.clientId, network: 'TRON' as const, address: walletAddress, purpose: 'BOTH' as const, label: 'Konkan wallet' });
  const admin = await person(s.t, s.owner, client.clientId, { canAccept: true, role: 'CLIENT_ADMIN' });
  const traderDeps = { custody: s.deps.custody, protector: s.deps.protector, chain: s.chain };
  await runAs(s.app, applyAsTrader(admin.actor, traderDeps), admin.ref, 'trader.apply', {
    experience: 'BINANCE', telegram: '@konkan_desk', confirmOwnership: true, offersBuy: true, offersSell: true, typicalInr: '100000000', typicalUsdt: '1000000', dailyInr: '100000000', dailyUsdt: '1000000',
    bankAccountId: bank.bankAccountId, walletId: wallet.walletId,
  });
  const profile = await s.app.selectFrom('trader_profile').select('id').where('client_id', '=', client.clientId).executeTakeFirstOrThrow();
  await runAs(s.app, approveTrader(s.finance.actor), s.finance.ref, 'trader.approve', { traderId: profile.id, requiredReserve: '500' });
  await fundBudget(s.app, { traderId: profile.id, amountSun: 1_000_000_000_000n, from: walletAddress });
  // The Security Reserve, from the trader's registered wallet, read from the chain.
  const settlementOp = await createTestOperator(s.t.owner, ['SETTLEMENT_OPERATOR']);
  const { address } = (await sharedReserveAddress(s.app))!;
  const receipt = s.chain.add({ from: walletAddress, to: address, amountMinor: Money.parse('500', 'USDT').minor });
  await runAs(s.app, submitTxForVerification(settlementOp.actor, { chain: s.chain }), settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
  await runTronConfirm(s.app, { chain: s.chain, providers: [] });
  for (const [side, capacity, rate] of [['BUY_USDT', '1000000000', TRADER_BUYS_AT], ['SELL_USDT', '10000000', TRADER_SELLS_AT]] as const) {
    const block = await s.app.selectFrom('trader_block').select('version').where('trader_id', '=', profile.id).where('side', '=', side).executeTakeFirstOrThrow();
    await runAs(s.app, updateBlock(admin.actor), admin.ref, 'trader.update_block', { side, expectedVersion: block.version, capacity, rate, minOrder: '1', maxOrder: capacity });
  }
  await runAs(s.app, setAvailability(admin.actor), admin.ref, 'trader.set_availability', { available: true });
  return { traderId: profile.id, clientId: client.clientId, bankAccountId: bank.bankAccountId, walletId: wallet.walletId, walletAddress, admin, holderName };
}

/**
 * A request routed to the scenario's trader, which accepts it at the client rate the desk will quote: what the desk has in
 * hand when it prices a deal. Returns the route a quote on it names.
 */
export async function routeToTrader(s: Scenario, requestId: string, clientRate: string): Promise<{ routeId: string; orderId: string; orderRef: string }> {
  const trader = await scenarioTrader(s);
  const assigned = await runAs(s.app, assignRequest(s.dealer.actor), s.dealer.ref, 'trader_order.assign', { requestId, plannedClientRate: clientRate });
  await runAs(s.app, acceptOrder(trader.admin.actor), trader.admin.ref, 'trader_order.accept', { ref: assigned.ref });
  const order = await s.app.selectFrom('trader_order').select(['id', 'route_id']).where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
  return { routeId: order.route_id, orderId: order.id, orderRef: assigned.ref };
}

export { runAs, setCanAcceptQuotes };
