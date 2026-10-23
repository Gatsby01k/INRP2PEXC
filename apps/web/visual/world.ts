import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { sql } from 'kysely';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { type Db, createDb, createPool } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { dispatchOutbox, installQueue } from '@inrp2p/outbox';
import { QuorumChainVerifier, type FieldProtector, LocalKeyEncryptionKey, createFieldProtector } from '@inrp2p/adapters';
import { FAKE_USDT_CONTRACT, FakeCustodyAdapter, FakeTronChain, FakeTronProvider } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor, DomainCommand, OperatorActor, OperatorRole } from '@inrp2p/identity';
import { createClientAuth, createOperatorAuth, provisionClientUser, provisionOperator } from '@inrp2p/identity';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes, setClientExchangeAccess } from '@inrp2p/clients';
import { createInrAccount, createSettlementEntity, setDayCapacity, setInrAccountCollectionDetails } from '@inrp2p/inr-accounts';
import { configureRoute, createRoute } from '@inrp2p/routes';
import { publishRouteRate } from '@inrp2p/pricing';
import { acceptQuote, claimDeskDealLink, createDeskDealLink, createQuote, createQuoteLink, createRequest, requestDeskQuote, sendQuote } from '@inrp2p/quotes';
import { fundBudget, seedNetworkCosts } from '@inrp2p/network/testing';
import { confirmPayout, confirmRouteSettlement, createPayoutLeg, importBankStatement, recordLegEvidence, recordRouteSettlement, sendPayoutLeg } from '@inrp2p/settlement';
import { acknowledgedSignalHandler, clientNotificationHandler, traderNotificationHandler } from '@inrp2p/notifications';
import { receiptHandler } from '@inrp2p/reporting';
import { runTronConfirm, runTronScan } from '@inrp2p/scanner';
import { importPoolAddresses, recordCustodyCapability, registerTreasuryWallet } from '@inrp2p/treasury';
import {
  acceptOrder, applyAsTrader, approveTrader, assignRequest, configureTraderProgram, openDesk, orderDeliveryAddress, setAvailability, setDeskPrices, setDeskStatus, sharedReserveAddress, updateBlock,
} from '@inrp2p/traders';

/**
 * The world the page baselines are captured from.
 *
 * It is deliberately **not** shared with the end-to-end world: a baseline must not move because someone changed
 * a fixture for an unrelated behavioural test. Everything here is fixed — the clock, the addresses, the amounts,
 * the order of creation — because a pixel baseline is only worth having if the same code always produces it.
 *
 * Determinism comes from three places:
 *   1. The **business clock** is frozen for the whole database (`inrp2p.clock_override`, migration 0012), so
 *      every reference (`IX-260919-0001`) and every business timestamp is the same on every run, on any day.
 *   2. Addresses, hashes and amounts are derived from fixed strings, never from randomness.
 *   3. The handful of columns that deliberately follow the wall clock rather than the business clock are pinned
 *      afterwards (see `pinWallClockColumns`), because they would otherwise print today's date on a page.
 */
export const VISUAL_DB = 'inrp2p_visual';
export const STATE_FILE = path.join(import.meta.dirname, '.state.json');

/** The frozen business clock. IST is UTC+05:30, so this is 19 Sep 2026, 14:41 IST — refs read `…-260919-…`. */
export const FROZEN_NOW = '2026-09-19T09:11:00.000Z';
export const FROZEN_IST_DAY = '2026-09-19';

/**
 * The origin the seed's own in-process Better Auth calls use. Nothing is resolved or connected here — the
 * handler is invoked directly — but it is written as a literal address for the same reason the harness binds
 * one: a name in a test origin is a trap waiting for the next person who copies it.
 */
const SEED_ORIGIN = 'http://127.0.0.1';

export const OPERATOR_PASSWORD = 'desk-visual-passphrase-1'; // secret-scan:allow — fixture for a throwaway database
export const OPERATOR_AUTH_SECRET = 'visual-operator-secret-0123456789abcdef'; // secret-scan:allow
export const CLIENT_AUTH_SECRET = 'visual-client-secret-0123456789abcdef'; // secret-scan:allow

/** Fixed field-protection keys, so the seed and the built app seal and open the same values. Obviously fake. */
export const VISUAL_FIELD_KEYS = {
  keyId: 'visual-kek',
  kekBase64: 'dmlzdWFsLWtlay1tYXRlcmlhbC0wMTIzNDU2Nzg5YWI=', // secret-scan:allow
  hmacBase64: 'dmlzdWFsLWhtYWMtbWF0ZXJpYWwtMDEyMzQ1Njc4OWE=', // secret-scan:allow
} as const;

/** The custody provider the fixture records a POOL capability for; the app is configured with the same slug. */
export const VISUAL_CUSTODY_PROVIDER = 'fake-custody';

export interface VisualOperator {
  readonly email: string;
  readonly password: string;
  readonly totpSecret: string;
}

export interface VisualState {
  readonly databaseUrl: string;
  readonly owner: VisualOperator;
  readonly clients: { readonly acme: string; readonly bharat: string };
  /** Trade ids by the state each one is parked in, so a spec names the state rather than an id. */
  readonly trades: {
    readonly completed: string;
    readonly awaitingPayout: string;
    readonly directRoute: string;
    readonly shortPaid: string;
  };
  readonly tradeRefs: { readonly completed: string; readonly awaitingPayout: string; readonly awaitingDeposit: string; readonly awaitingInr: string; readonly p2pBuy: string };
  readonly openRequestId: string;
  /** The client product's own fixture: one signed-in person, one live quote, one link to it. */
  readonly client: { readonly email: string; readonly quoteRef: string; readonly linkToken: string };
  /**
   * A trader on P2P (ADR 0019): signed in on its own; one order where it pays a client's rupees straight to the client,
   * whose USDT is in escrow, and one where its own USDT is in escrow while the buyer pays it.
   */
  readonly trader: { readonly email: string; readonly traderId: string; readonly orderRef: string; readonly sellOrderRef: string };
  /**
   * The same trader's own desk (ADR 0020), live: Meera Textiles sold it USDT from its page and waits for the desk's
   * rupees; Acme took a deal link to buy and waits for the desk's USDT in escrow; Bharat holds its price; one link waits.
   */
  readonly desk: { readonly handle: string; readonly payDealRef: string; readonly escrowDealRef: string; readonly openLinkToken: string };
}

/** The one protector the seed and the built app share. */
function visualFieldProtector(): FieldProtector {
  return createFieldProtector({
    kek: LocalKeyEncryptionKey.fromBase64(VISUAL_FIELD_KEYS.keyId, VISUAL_FIELD_KEYS.kekBase64),
    hmacKey: Buffer.from(VISUAL_FIELD_KEYS.hmacBase64, 'base64'),
  });
}

/** Fixed 20-byte TRON addresses: the same wallet prints the same characters on every run. */
const address = (label: string): string => encodeTronAddress(createHash('sha256').update(`inrp2p-visual:${label}`).digest().subarray(0, 20));

const actorRef = (userId: string, sessionId: string) => ({ type: 'USER' as const, id: userId, surface: 'OPERATOR' as const, sessionId });

async function run<P, R>(db: Db, def: DomainCommand<P, R>, ref: ReturnType<typeof actorRef>, name: string, payload: P): Promise<R> {
  const out = await executeCommand(db, def, { name, actor: ref, payload, idempotencyKey: randomUUID(), financial: true });
  return out.result;
}

const withDatabase = (url: string, db: string): string => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/**
 * Columns that follow the **wall** clock by design — the business day is a wall-clock concept, and a rate
 * snapshot's age is measured against real time so a stale rate is really stale. They would otherwise print the
 * day the baseline happened to be recorded, so the fixture pins them. Nothing here changes behaviour: the values
 * are only moved to the instant the frozen business clock already reports.
 */
const WALL_CLOCK_COLUMNS: readonly { table: string; columns: readonly string[] }[] = [
  { table: 'rate_snapshot', columns: ['effective_at', 'created_at'] },
  { table: 'deposit_address', columns: ['created_at'] },
  { table: 'deposit_assignment', columns: ['assigned_at'] },
  { table: 'treasury_wallet', columns: ['observed_at', 'created_at'] },
  { table: 'liquidity_route', columns: ['created_at'] },
  { table: 'inr_settlement_account', columns: ['created_at'] },
  { table: 'trader_program', columns: ['updated_at'] },
  // A trader's page shows its decisions (audit events, timed by the wall clock on purpose: an audit time is real) and
  // when its bank account and wallet were submitted (TD-23).
  { table: 'audit_event', columns: ['at'] },
  { table: 'bank_account', columns: ['created_at'] },
  { table: 'crypto_wallet', columns: ['created_at'] },
];

async function pinWallClockColumns(db: Db): Promise<void> {
  // Fixture pinning writes columns the domain treats as immutable, so the guards are stood down for exactly
  // these statements, in this throwaway database, and turned straight back on.
  await sql`set session_replication_role = replica`.execute(db);
  try {
    for (const { table, columns } of WALL_CLOCK_COLUMNS) {
      const set = columns.map((c) => `${c} = '${FROZEN_NOW}'::timestamptz`).join(', ');
      await sql.raw(`update ${table} set ${set} where ${columns[0]} is not null`).execute(db);
    }
  } finally {
    await sql`set session_replication_role = origin`.execute(db);
  }
}

/** The chain the fixture's deposits arrive on: two fake providers over one fake chain, as in production shape. */
function chainDeps(scanner: string) {
  const chain = new FakeTronChain({ tokenContract: FAKE_USDT_CONTRACT });
  const primary = new FakeTronProvider('visual-node-a', chain);
  const secondary = new FakeTronProvider('visual-node-b', chain);
  return { chain, primary, deps: { chain: new QuorumChainVerifier({ providers: [primary, secondary], tokenContract: FAKE_USDT_CONTRACT }), providers: [primary, secondary], scanner: { scanner } } };
}

export async function seedVisual(adminUrl: string): Promise<VisualState> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${VISUAL_DB} with (force)`);
  await admin.query(`create database ${VISUAL_DB}`);
  await admin.end();

  const databaseUrl = withDatabase(adminUrl, VISUAL_DB);
  const pool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-visual-seed' });
  await migrate(pool);
  await installQueue(pool);
  const db = createDb(pool);

  // Freeze the business clock for every connection to this database — the seed's and the desk server's alike.
  // `inrp2p_now()` honours the override only where the permit table exists (migration 0012), so this can never
  // be switched on by configuration alone in a real deployment.
  await sql`create table inrp2p_test_clock_permit (enabled boolean primary key default true)`.execute(db);
  const freeze = new pg.Client({ connectionString: adminUrl });
  await freeze.connect();
  await freeze.query(`alter database ${VISUAL_DB} set "inrp2p.clock_override" = '${FROZEN_NOW}'`);
  await freeze.end();
  await pool.end();

  // Reconnect so this session picks up the frozen clock too.
  const seedPool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-visual-seed' });
  const world = createDb(seedPool);
  const authPool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-visual-auth', int8: 'number' });
  const authDb = createDb(authPool);

  const auth = createOperatorAuth({ authDb, appDb: world, secret: OPERATOR_AUTH_SECRET, baseURL: SEED_ORIGIN, rateLimit: { enabled: false }, useSecureCookies: false });
  const owner = await operator(auth, world, 'owner@inrp2p.test', ['OWNER']);
  // Above ₹2,500,000 a payout is confirmed by someone other than its sender (SECURITY §4, C1).
  const settler = await operator(auth, world, 'settlement@inrp2p.test', ['SETTLEMENT_OPERATOR']);
  const protector = visualFieldProtector();

  // ── Clients ────────────────────────────────────────────────────────────────────────────────────────────
  const acme = await run(world, createClient(owner.actor), owner.ref, 'client.create', {
    legalName: 'Acme Pay Private Limited', displayName: 'Acme Pay', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const,
  });
  const acmeBank = await run(world, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: acme.clientId, holderName: 'Acme Pay Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0001234',
    accountNumber: '50100123458219', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const acmeWallet = await run(world, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
    clientId: acme.clientId, network: 'TRON' as const, address: address('acme-wallet'), purpose: 'DESTINATION' as const, label: 'Acme wallet',
  });

  const bharat = await run(world, createClient(owner.actor), owner.ref, 'client.create', {
    legalName: 'Bharat Digital Services LLP', displayName: 'Bharat Digital', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const,
  });
  const bharatBank = await run(world, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: bharat.clientId, holderName: 'Bharat Digital Services LLP', bankName: 'Axis Bank', ifsc: 'UTIB0004567',
    accountNumber: '91820045510033', railPreferences: ['IMPS', 'RTGS'] as const,
  });

  const coastal = await run(world, createClient(owner.actor), owner.ref, 'client.create', {
    legalName: 'Coastal Traders Private Limited', displayName: 'Coastal Traders', type: 'COMPANY' as const, typicalDirection: 'BUY_USDT' as const,
  });
  await run(world, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: coastal.clientId, holderName: 'Coastal Traders Private Limited', bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK0006789',
    accountNumber: '73910022114400', railPreferences: ['NEFT'] as const,
  });
  // Coastal buys USDT, so their destination is a wallet rather than a bank account.
  const coastalWallet = await run(world, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
    clientId: coastal.clientId, network: 'TRON' as const, address: address('coastal-wallet'), purpose: 'DESTINATION' as const, label: 'Coastal treasury',
  });

  // Acceptance is the client's own act (D-01), so the fixture needs an authorized client user per trading client.
  const clientAuth = createClientAuth({
    authDb, appDb: world, secret: CLIENT_AUTH_SECRET, baseURL: SEED_ORIGIN, rateLimit: { enabled: false }, useSecureCookies: false,
    otpSender: { send: async () => {} },
  });
  const acmeAcceptor = await acceptor(world, clientAuth, owner, acme.clientId, 'treasury@acmepay.test', 'Acme treasury');
  const bharatAcceptor = await acceptor(world, clientAuth, owner, bharat.clientId, 'ops@bharatdigital.test', 'Bharat ops');

  // ── Routes ─────────────────────────────────────────────────────────────────────────────────────────────
  const mumbai = await run(world, createRoute(owner.actor), owner.ref, 'routes.create', {
    name: 'Mumbai OTC', direction: 'BOTH' as const, executionMode: 'DIRECT_TO_CLIENT' as const,
    registeredRouteAddress: address('mumbai-route'), availableBaseUsdt: '5000000',
  });
  await run(world, configureRoute(owner.actor), owner.ref, 'routes.configure', {
    routeId: mumbai.routeId, expectedVersion: 1, executionMode: 'TO_EXCHANGE' as const, reason: 'the provider settles into our own account',
  });
  await run(world, publishRouteRate(owner.actor), owner.ref, 'rates.publish_route', { routeId: mumbai.routeId, direction: 'SELL_USDT' as const, rate: '104.200000' });
  await run(world, publishRouteRate(owner.actor), owner.ref, 'rates.publish_route', { routeId: mumbai.routeId, direction: 'BUY_USDT' as const, rate: '100.000000' });

  // A second route that pays the client directly (D-14), so the payout panel shows the payer selector.
  const chennai = await run(world, createRoute(owner.actor), owner.ref, 'routes.create', {
    name: 'Chennai Direct', direction: 'BOTH' as const, executionMode: 'DIRECT_TO_CLIENT' as const,
    registeredRouteAddress: address('chennai-route'), availableBaseUsdt: '3000000',
  });
  await run(world, publishRouteRate(owner.actor), owner.ref, 'rates.publish_route', { routeId: chennai.routeId, direction: 'SELL_USDT' as const, rate: '104.000000' });
  await run(world, publishRouteRate(owner.actor), owner.ref, 'rates.publish_route', { routeId: chennai.routeId, direction: 'BUY_USDT' as const, rate: '100.500000' });

  // What a transfer costs on TRON (ADR 0017), at today's real prices — 100 sun of energy, a TRX at 0.30 USDT — and TRX
  // in the platform budget, so every quote carries its network fee and every acceptance holds its TRX.
  await seedNetworkCosts(world, { usdtPerTrxMicro: 300_000n });
  await fundBudget(world, { traderId: null, amountSun: 1_000_000_000_000n, from: address('platform-trx') });

  // ── The exchange's own money ────────────────────────────────────────────────────────────────────────────
  const entity = await run(world, createSettlementEntity(owner.actor), owner.ref, 'settlement_entity.create', {
    legalName: 'INRP2P Settlement Private Limited', shortName: 'INRP2P',
  });
  const account = await run(world, createInrAccount(owner.actor, protector), owner.ref, 'inr_account.create', {
    entityId: entity.entityId, label: 'Company A', bankName: 'ICICI Bank', ifsc: 'ICIC0001234', accountNumber: '000405001234',
    rails: ['IMPS', 'NEFT', 'RTGS'] as const, direction: 'BOTH' as const, defaultDailyCapacity: '50000000.00',
  });
  await run(world, setDayCapacity(owner.actor), owner.ref, 'capacity.set_day', { accountId: account.accountId, capacity: '50000000.00', reason: 'visual fixture' });
  // ADR 0018: what a client paying a BUY sees — the payee and the account's UPI ID, so its trade shows a UPI code.
  await run(world, setInrAccountCollectionDetails(owner.actor), owner.ref, 'inr_account.set_collection_details', {
    accountId: account.accountId, upiVpa: 'inrp2p.collect@icici', beneficiaryName: 'INRP2P Settlement Pvt Ltd',
  });

  const custody = new FakeCustodyAdapter({ provider: VISUAL_CUSTODY_PROVIDER, capability: 'POOL', poolSize: 24, seed: 'visual' });
  const poolWallet = await run(world, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: address('deposit-pool'), label: 'Deposit pool', role: 'DEPOSIT_POOL' as const,
  });
  await run(world, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: address('hot-wallet'), label: 'Hot wallet', role: 'HOT' as const,
  });
  await run(world, recordCustodyCapability(owner.actor), owner.ref, 'custody.record_capability', {
    provider: custody.provider, network: 'TRON' as const, capability: 'POOL' as const, consolidationNotes: 'Provider sweeps to the hot wallet.',
  });
  await run(world, importPoolAddresses(owner.actor, custody), owner.ref, 'custody.import_pool_addresses', { network: 'TRON' as const, treasuryWalletId: poolWallet.walletId });

  // Pin the wall-clock columns before any trade is priced: a quote measures its route snapshot's age against
  // the **business** clock, which is frozen here, so a snapshot stamped with real time would read as stale.
  await pinWallClockColumns(world);

  // ── Trades, one per state the desk has to show ──────────────────────────────────────────────────────────
  const chain = chainDeps('visual');

  // 1. Completed: the launch scenario, so Orders has a finished trade and the strip a realized margin. The route
  //    delivers its INR first; the client is paid with it and nothing else (D-16). Both legs are above the approval
  //    threshold, so the owner sends them and the settlement operator confirms them (C1).
  const completed = await trade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, bankAccountId: acmeBank.bankAccountId,
    amount: '100000', clientRate: '102.000000', chain,
  });
  await routeDelivers(world, owner, chain, { tradeId: completed.tradeId, amount: '10420000.00', inrAccountId: account.accountId, utr: 'IXVISROUTE000' });
  for (const amount of ['6000000.00', '4200000.00']) {
    const leg = await run(world, createPayoutLeg(owner.actor, {}), owner.ref, 'payout_leg.create', {
      tradeId: completed.tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: account.accountId,
    });
    await run(world, sendPayoutLeg(owner.actor), owner.ref, 'payout_leg.send', { legId: leg.legId });
    await run(world, recordLegEvidence(owner.actor, chain.deps), owner.ref, 'payout_leg.record_evidence', {
      legId: leg.legId, rail: 'IMPS' as const, utr: `IXVIS${amount.slice(0, 7).replace('.', '')}`,
    });
    await confirmPayout(world, settler.actor, chain.deps, { legId: leg.legId, idempotencyKey: randomUUID() });
  }

  // 2. Awaiting payout, with a leg already sent and referenced — the payout panel with work in flight, and the
  //    ⧗ confirm the step-up capture needs.
  const awaiting = await trade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, bankAccountId: acmeBank.bankAccountId,
    amount: '25000', clientRate: '102.000000', chain,
  });
  await routeDelivers(world, owner, chain, { tradeId: awaiting.tradeId, amount: '1000000.00', inrAccountId: account.accountId, utr: 'IXVISROUTE002' });
  const inFlight = await run(world, createPayoutLeg(owner.actor, {}), owner.ref, 'payout_leg.create', {
    tradeId: awaiting.tradeId, amount: '1000000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: account.accountId,
  });
  await run(world, sendPayoutLeg(owner.actor), owner.ref, 'payout_leg.send', { legId: inFlight.legId });
  await run(world, recordLegEvidence(owner.actor, chain.deps), owner.ref, 'payout_leg.record_evidence', {
    legId: inFlight.legId, rail: 'IMPS' as const, utr: 'IXVIS1000000',
  });

  // 3. A trade on the direct route, so the payout panel offers the route as a payer and Rates shows the
  //    read-only allocation that confirming a direct leg already made (FI-64).
  const direct = await trade(world, owner, {
    clientId: bharat.clientId, acceptor: bharatAcceptor, routeId: chennai.routeId, bankAccountId: bharatBank.bankAccountId,
    amount: '40000', clientRate: '103.000000', chain,
  });
  const directLeg = await run(world, createPayoutLeg(owner.actor, {}), owner.ref, 'payout_leg.create', {
    tradeId: direct.tradeId, amount: '2000000.00', payer: 'ROUTE' as const,
  });
  await run(world, sendPayoutLeg(owner.actor), owner.ref, 'payout_leg.send', { legId: directLeg.legId });
  await run(world, recordLegEvidence(owner.actor, chain.deps), owner.ref, 'payout_leg.record_evidence', {
    legId: directLeg.legId, rail: 'IMPS' as const, utr: 'IXVISDIRECT01',
  });
  await confirmPayout(world, owner.actor, chain.deps, { legId: directLeg.legId, idempotencyKey: randomUUID() });

  // 4. A short payment: the chain delivered less than the trade expects, which the domain turns into a blocking
  //    exception. Nothing is faked — the scanner and the confirmation open the case themselves.
  const short = await trade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, bankAccountId: acmeBank.bankAccountId,
    amount: '10000', clientRate: '102.000000', chain, deposit: '9950',
  });

  // 5. A request nobody has priced yet — the queue's "needs action" group and the quote builder.
  const openRequest = await run(world, createRequest(owner.actor, {}), owner.ref, 'request.create', {
    clientId: coastal.clientId, direction: 'BUY_USDT' as const, fixedSide: 'QUOTE' as const, amount: '2500000.00',
    targetRate: '100.400000', walletId: coastalWallet.walletId,
  });

  // A route settlement recorded but not yet confirmed, so Rates shows the confirm the obligation is waiting on: the
  //    rest of what the route owes on the trade awaiting payout.
  await routeDelivers(world, owner, chain, { tradeId: awaiting.tradeId, amount: '1605000.00', inrAccountId: account.accountId, utr: 'IXVISROUTE001', confirm: false });

  // ── The client product's own states ────────────────────────────────────────────────────────────────────
  // 6. A trade the client has accepted and not yet funded: the deposit instructions, which is the one screen a
  //    client is looking at while they move money.
  const awaitingDeposit = await trade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, bankAccountId: acmeBank.bankAccountId,
    amount: '5000', clientRate: '102.000000', chain, skipDeposit: true,
  });

  // 6b. A BUY the client has accepted and not yet paid (ADR 0018): where to pay, the UPI code, the trade's reference,
  //     the time left, and the "I've paid" form — the screen a client has open while their payment app is.
  const awaitingInr = await buyTrade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, walletId: acmeWallet.walletId, amount: '500', clientRate: '101.500000',
  });

  // 7. A live quote with a shareable link, so Exchange counts one down and the public link page has one to show.
  //    The business clock is frozen, so this quote is permanently 180 s from expiry — which is the point.
  const pendingRequest = await run(world, createRequest(owner.actor, {}), owner.ref, 'request.create', {
    clientId: acme.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '100000',
    targetRate: '102.000000', bankAccountId: acmeBank.bankAccountId,
  });
  const pendingQuote = await run(world, createQuote(owner.actor, {}), owner.ref, 'quote.create', {
    requestId: pendingRequest.requestId, routeId: mumbai.routeId, clientRate: '102.000000', validitySeconds: 180,
  });
  await run(world, sendQuote(owner.actor, {}), owner.ref, 'quote.send', { quoteId: pendingQuote.quoteId });
  let linkToken = '';
  await run(world, createQuoteLink(owner.actor, {}, (t) => { linkToken = t; }), owner.ref, 'quote_link.create', { quoteId: pendingQuote.quoteId });
  const pendingQuoteRef = (await world.selectFrom('quote').select('ref').where('id', '=', pendingQuote.quoteId).executeTakeFirstOrThrow()).ref;

  // ── Traders (TD-23, ADR 0019) ──────────────────────────────────────────────────────────────────────────
  // 7b. The programme settles P2P: Konkan Liquidity trades with its own INR and USDT, applied, approved, its Security
  //     Reserve funded on chain from its registered wallet, both blocks live. Bharat sells 10,000 USDT through the
  //     desk, which routes the request to Konkan at the client rate it quotes; Konkan accepts, the client accepts and
  //     its USDT arrives in escrow — so the order waits on Konkan paying Bharat's own account. And Acme buys 2,000
  //     USDT from Konkan: Konkan's USDT is in escrow, and Acme's screen shows the seller's account to pay.
  const programme = await world.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await run(world, configureTraderProgram(owner.actor), owner.ref, 'trader_program.configure', {
    expectedVersion: programme.version, defaultRequiredReserve: '500', rewardBps: 10, collectionAccountId: account.accountId, executionMode: 'P2P' as const, reason: 'the visual fixture programme',
  });
  const konkan = await run(world, createClient(owner.actor), owner.ref, 'client.create', {
    legalName: 'Konkan Liquidity LLP', displayName: 'Konkan Liquidity', type: 'COMPANY' as const, typicalDirection: 'BUY_USDT' as const,
  });
  // It provides liquidity only: no Exchange, so its workspace is Traders alone — the shell a trader actually sees.
  await run(world, setClientExchangeAccess(owner.actor), owner.ref, 'client.set_exchange_access', {
    clientId: konkan.clientId, exchangeAccess: false, reason: 'provides liquidity only, through the trader programme',
  });
  const konkanBank = await run(world, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: konkan.clientId, holderName: 'Konkan Liquidity LLP', bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK0000123',
    accountNumber: '74130211980057', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const konkanWalletAddress = address('konkan-wallet');
  const konkanWallet = await run(world, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
    clientId: konkan.clientId, network: 'TRON' as const, address: konkanWalletAddress, purpose: 'BOTH' as const, label: 'Konkan wallet',
  });
  const konkanDesk = await clientPerson(world, clientAuth, owner, konkan.clientId, 'desk@konkanliquidity.test', 'Konkan desk');
  const traderDeps = { custody, protector, chain: chain.deps.chain };
  await runClient(world, applyAsTrader(konkanDesk.actor, traderDeps), konkanDesk.ref, 'trader.apply', {
    experience: 'BINANCE' as const, telegram: '@konkan_desk', confirmOwnership: true, offersBuy: true, offersSell: true,
    typicalInr: '1020000.00', dailyInr: '2000000.00', typicalUsdt: '2000.000000', dailyUsdt: '20000.000000', bankAccountId: konkanBank.bankAccountId, walletId: konkanWallet.walletId,
  });
  const traderId = (await world.selectFrom('trader_profile').select('id').where('client_id', '=', konkan.clientId).executeTakeFirstOrThrow()).id;
  await run(world, approveTrader(owner.actor), owner.ref, 'trader.approve', { traderId, requiredReserve: '500' });
  // Its network deposit (ADR 0017): TRX from its registered wallet, enough for its orders' transfers.
  await fundBudget(world, { traderId, amountSun: 250_000_000n, from: konkanWalletAddress });
  // The one reserve address every trader sends to (D-17); the trader's registered wallet is what makes it its own.
  const reserve = (await sharedReserveAddress(world))!;
  chain.chain.add({ from: konkanWalletAddress, to: reserve.address, amountMinor: Money.parse('800', 'USDT').minor });
  chain.chain.solidifyAll();
  await runTronScan(world, chain.deps);
  await runTronConfirm(world, chain.deps);
  const buyBlock = await world.selectFrom('trader_block').select('version').where('trader_id', '=', traderId).where('side', '=', 'BUY_USDT').executeTakeFirstOrThrow();
  await runClient(world, updateBlock(konkanDesk.actor), konkanDesk.ref, 'trader.update_block', {
    side: 'BUY_USDT' as const, expectedVersion: buyBlock.version, capacity: '2000000.00', rate: '104.80', minOrder: '50000.00', maxOrder: '1500000.00', status: 'ACTIVE' as const,
  });
  const sellBlock = await world.selectFrom('trader_block').select('version').where('trader_id', '=', traderId).where('side', '=', 'SELL_USDT').executeTakeFirstOrThrow();
  await runClient(world, updateBlock(konkanDesk.actor), konkanDesk.ref, 'trader.update_block', {
    side: 'SELL_USDT' as const, expectedVersion: sellBlock.version, capacity: '20000.000000', rate: '105.20', minOrder: '100.000000', maxOrder: '10000.000000', status: 'ACTIVE' as const,
  });
  await runClient(world, setAvailability(konkanDesk.actor), konkanDesk.ref, 'trader.set_availability', { available: true });
  const traderRequest = await run(world, createRequest(owner.actor, {}), owner.ref, 'request.create', {
    clientId: bharat.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '10000',
    targetRate: '102.000000', bankAccountId: bharatBank.bankAccountId,
  });
  const assigned = await run(world, assignRequest(owner.actor), owner.ref, 'trader_order.assign', { requestId: traderRequest.requestId, plannedClientRate: '102.000000' });
  await runClient(world, acceptOrder(konkanDesk.actor), konkanDesk.ref, 'trader_order.accept', { ref: assigned.ref });
  const traderRoute = (await world.selectFrom('trader_order').select('route_id').where('id', '=', assigned.orderId).executeTakeFirstOrThrow()).route_id;
  await trade(world, owner, {
    clientId: bharat.clientId, acceptor: bharatAcceptor, routeId: traderRoute, bankAccountId: bharatBank.bankAccountId,
    amount: '10000', clientRate: '102.000000', chain, requestId: traderRequest.requestId,
  });
  // Acme buys 2,000 USDT from Konkan, P2P: the order is sized at the client rate, Konkan's USDT reaches the order's
  // escrow from its registered wallet, and Acme is shown Konkan's account.
  const p2pRequest = await run(world, createRequest(owner.actor, {}), owner.ref, 'request.create', {
    clientId: acme.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '2000', targetRate: '106.500000', walletId: acmeWallet.walletId,
  });
  const sellOrder = await run(world, assignRequest(owner.actor), owner.ref, 'trader_order.assign', { requestId: p2pRequest.requestId, plannedClientRate: '106.500000' });
  await runClient(world, acceptOrder(konkanDesk.actor), konkanDesk.ref, 'trader_order.accept', { ref: sellOrder.ref });
  const sellRoute = (await world.selectFrom('trader_order').select('route_id').where('id', '=', sellOrder.orderId).executeTakeFirstOrThrow()).route_id;
  const p2pBuy = await buyTrade(world, owner, { clientId: acme.clientId, acceptor: acmeAcceptor, routeId: sellRoute, walletId: acmeWallet.walletId, amount: '2000', clientRate: '106.500000', requestId: p2pRequest.requestId });
  const escrow = await runClient(world, orderDeliveryAddress(konkanDesk.actor, { custody }), konkanDesk.ref, 'trader_order.delivery_address', { ref: sellOrder.ref });
  chain.chain.add({ from: konkanWalletAddress, to: escrow.address, amountMinor: Money.parse(escrow.amount, 'USDT').minor });
  chain.chain.solidifyAll();
  await runTronScan(world, chain.deps);
  await runTronConfirm(world, chain.deps);

  // ── A desk (ADR 0020) ──────────────────────────────────────────────────────────────────────────────────────
  // 7c. Konkan runs its own exchange on INRP2P: its page at /konkan, live prices on both sides, an operator on its team.
  //     Meera Textiles — a new client — sells 1,500 USDT from the page, its USDT already in the deal's escrow, so the
  //     desk owes it rupees. Acme takes a link to buy 800 USDT: the desk owes its USDT to the escrow. Bharat holds the
  //     page's price for 2,000 USDT; and one link is still waiting for its client.
  const deskQuoteDeps = { custody, protector };
  const opened = await runClient(world, openDesk(konkanDesk.actor), konkanDesk.ref, 'desk.open', {
    handle: 'konkan', displayName: 'Konkan Liquidity', about: 'OTC desk in Mumbai since 2019. IMPS and NEFT, 9:00–23:00 IST. Large tickets welcome.',
  });
  await runClient(world, setDeskPrices(konkanDesk.actor), konkanDesk.ref, 'desk.set_prices', {
    prices: [
      { direction: 'SELL_USDT' as const, rate: '104.600000', min: '100', max: '10000', live: true },
      { direction: 'BUY_USDT' as const, rate: '105.400000', min: '100', max: '5000', live: true },
    ],
    validForHours: 24,
  });
  await runClient(world, setDeskStatus(konkanDesk.actor), konkanDesk.ref, 'desk.set_status', { expectedVersion: opened.version, status: 'LIVE' as const });
  const ravi = await provisionClientUser(clientAuth, { email: 'ravi@konkanliquidity.test', name: 'Ravi' });
  await sql`update auth_user set email_verified = true where id = ${ravi}`.execute(world);
  const raviLinked = await run(world, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: konkan.clientId, userId: ravi, role: 'CLIENT_TRADER' as const });
  await run(world, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: raviLinked.clientUserId, canAcceptQuotes: true });

  const meera = await run(world, createClient(owner.actor), owner.ref, 'client.create', { legalName: 'Meera Textiles Private Limited', displayName: 'Meera Textiles', type: 'COMPANY' as const });
  const meeraBank = await run(world, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: meera.clientId, holderName: 'Meera Textiles Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0000240', accountNumber: '50200061234570', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const meeraWalletAddress = address('meera-wallet');
  await run(world, addWallet(owner.actor), owner.ref, 'client_wallet.add', { clientId: meera.clientId, network: 'TRON' as const, address: meeraWalletAddress, purpose: 'BOTH' as const, label: 'Meera wallet' });
  const meeraPerson = await clientPerson(world, clientAuth, owner, meera.clientId, 'finance@meeratextiles.test', 'Meera finance');
  const meeraQuote = await runClient(world, requestDeskQuote(meeraPerson.actor, deskQuoteDeps), meeraPerson.ref, 'desk_deal.request_quote', {
    handle: 'konkan', direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1500', bankAccountId: meeraBank.bankAccountId,
  });
  const meeraTrade = await runClient(world, acceptQuote(meeraPerson.actor, deskQuoteDeps), meeraPerson.ref, 'quote.accept', { quoteId: meeraQuote.quoteId });
  const meeraEscrow = await world.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', meeraTrade.tradeId).executeTakeFirstOrThrow();
  chain.chain.add({ from: meeraWalletAddress, to: meeraEscrow.address, amountMinor: Money.parse('1500', 'USDT').minor });
  chain.chain.solidifyAll();
  await runTronScan(world, chain.deps);
  await runTronConfirm(world, chain.deps);

  let dealToken = '';
  await runClient(world, createDeskDealLink(konkanDesk.actor, (t) => { dealToken = t; }), konkanDesk.ref, 'desk_deal_link.create', {
    direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '800', rate: '105.300000', validMinutes: 1440, note: 'Acme treasury, WhatsApp',
  });
  const acmeSession = await clientSession(world, acmeAcceptor.userId);
  const linkQuote = await runClient(world, claimDeskDealLink(acmeSession.actor, deskQuoteDeps), acmeSession.ref, 'desk_deal_link.claim', { token: dealToken, walletId: acmeWallet.walletId });
  await runClient(world, acceptQuote(acmeSession.actor, deskQuoteDeps), acmeSession.ref, 'quote.accept', { quoteId: linkQuote.quoteId });
  let openLinkToken = '';
  await runClient(world, createDeskDealLink(konkanDesk.actor, (t) => { openLinkToken = t; }), konkanDesk.ref, 'desk_deal_link.create', {
    direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '2500', rate: '104.700000', validMinutes: 1440, note: 'Ravi’s contact, Telegram',
  });
  const bharatSession = await clientSession(world, bharatAcceptor.userId);
  await runClient(world, requestDeskQuote(bharatSession.actor, deskQuoteDeps), bharatSession.ref, 'desk_deal.request_quote', {
    handle: 'konkan', direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '2000', bankAccountId: bharatBank.bankAccountId,
  });
  const orderRefOf = async (orderId: string) => (await world.selectFrom('trader_order').select('ref').where('id', '=', orderId).executeTakeFirstOrThrow()).ref;
  const payDealRef = await orderRefOf(meeraQuote.orderId);
  const escrowDealRef = await orderRefOf(linkQuote.orderId);

  // 8. The inbox, filled the way production fills it: by running the outbox over the events these commands
  //    already enqueued. Nothing writes a notification directly.
  await dispatchOutbox(world, [clientNotificationHandler(world), traderNotificationHandler(world), receiptHandler(world), acknowledgedSignalHandler()], { batchSize: 500 });

  // 8b. A bank statement, reconciled. Its lines are the payments the desk actually confirmed on this account —
  //     the payouts that left it and, since D-16, the routes' INR that arrived in it to pay them — so the import
  //     matches everything and opens no case: the quiet outcome, which is the one a baseline should show. The extra
  //     line is a bank charge this system never made: `UNRECORDED`, and deliberately not a case, because a real
  //     statement is full of them.
  const confirmedLines = await sql<{ utr: string; amount_minor: bigint; outgoing: boolean }>`
    select f.utr, f.amount_minor, (f.payer_type = 'EXCHANGE_ACCOUNT' and f.payer_id = ${account.accountId}) as outgoing
    from fiat_transfer f
    where f.status = 'CONFIRMED'
      and ((f.payer_type = 'EXCHANGE_ACCOUNT' and f.payer_id = ${account.accountId}) or (f.payee_type = 'EXCHANGE_ACCOUNT' and f.payee_id = ${account.accountId}))
    order by f.utr`.execute(world);
  const statementLines = [
    ...confirmedLines.rows.map((r) => ({
      valueDate: FROZEN_IST_DAY, direction: r.outgoing ? ('DEBIT' as const) : ('CREDIT' as const),
      amount: Money.ofMinor(r.amount_minor, 'INR').toDecimalString(), reference: r.utr, description: r.outgoing ? 'NEFT OUTWARD' : 'NEFT INWARD',
    })),
    { valueDate: FROZEN_IST_DAY, direction: 'DEBIT' as const, amount: '236.00', reference: 'BANKCHG0919', description: 'MONTHLY CHARGES' },
  ];
  await run(world, importBankStatement(owner.actor), owner.ref, 'statement.import', {
    inrAccountId: account.accountId, periodFrom: FROZEN_IST_DAY, periodTo: FROZEN_IST_DAY,
    filename: 'hdfc-20260919.csv',
    sha256: createHash('sha256').update(JSON.stringify(statementLines)).digest('hex'),
    lines: statementLines,
  });

  // The scanner's own state, written directly: only the chain would otherwise supply it, and the USDT screen
  // shows it so an operator can tell "quiet" from "broken".
  await sql`
    insert into chain_cursor (network, scanner, last_scanned_block, last_solidified_block, last_run_at)
    values ('TRON', 'tron_deposits', 74210330, 74210310, ${FROZEN_NOW}::timestamptz)
    on conflict (network, scanner) do update set last_scanned_block = excluded.last_scanned_block`.execute(world);

  // Again, for the rows the trades themselves created.
  await pinWallClockColumns(world);

  const refs = await sql<{ id: string; ref: string }>`select id, ref from trade`.execute(world);
  const refOf = (id: string) => refs.rows.find((r) => r.id === id)!.ref;

  const state: VisualState = {
    databaseUrl,
    owner: { email: owner.email, password: OPERATOR_PASSWORD, totpSecret: owner.totpSecret },
    clients: { acme: acme.clientId, bharat: bharat.clientId },
    trades: { completed: completed.tradeId, awaitingPayout: awaiting.tradeId, directRoute: direct.tradeId, shortPaid: short.tradeId },
    tradeRefs: { completed: refOf(completed.tradeId), awaitingPayout: refOf(awaiting.tradeId), awaitingDeposit: refOf(awaitingDeposit.tradeId), awaitingInr: refOf(awaitingInr.tradeId), p2pBuy: refOf(p2pBuy.tradeId) },
    openRequestId: openRequest.requestId,
    client: { email: 'treasury@acmepay.test', quoteRef: pendingQuoteRef, linkToken },
    trader: { email: konkanDesk.email, traderId, orderRef: assigned.ref, sellOrderRef: sellOrder.ref },
    desk: { handle: 'konkan', payDealRef, escrowDealRef, openLinkToken },
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  await world.destroy();
  await authDb.destroy();
  return state;
}

/** Request → quote → the client's own acceptance → the chain's delivery, exactly as the product does it. */
/** A BUY accepted by the client in the app, through the same acceptance a client's session makes. */
async function buyTrade(
  db: Db,
  owner: Awaited<ReturnType<typeof operator>>,
  input: { clientId: string; acceptor: { userId: string }; routeId: string; walletId: string; amount: string; clientRate: string; requestId?: string },
): Promise<{ tradeId: string }> {
  const request = input.requestId
    ? { requestId: input.requestId }
    : await run(db, createRequest(owner.actor, {}), owner.ref, 'request.create', {
        clientId: input.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: input.amount, targetRate: input.clientRate, walletId: input.walletId,
      });
  const quote = await run(db, createQuote(owner.actor, {}), owner.ref, 'quote.create', { requestId: request.requestId, routeId: input.routeId, clientRate: input.clientRate, validitySeconds: 180 });
  await run(db, sendQuote(owner.actor, {}), owner.ref, 'quote.send', { quoteId: quote.quoteId });
  const session = await db
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: input.acceptor.userId, surface: 'CLIENT' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const accepted = await executeCommand(
    db,
    acceptQuote({ kind: 'CLIENT', userId: input.acceptor.userId, sessionId: session.id }, { custody: new FakeCustodyAdapter({ provider: VISUAL_CUSTODY_PROVIDER, capability: 'POOL', poolSize: 24, seed: 'visual' }), protector: visualFieldProtector() }),
    { name: 'quote.accept', actor: { type: 'USER', id: input.acceptor.userId, surface: 'CLIENT', sessionId: session.id }, payload: { quoteId: quote.quoteId }, idempotencyKey: randomUUID(), financial: true },
  );
  return { tradeId: (accepted.result as { tradeId: string }).tradeId };
}

async function trade(
  db: Db,
  owner: Awaited<ReturnType<typeof operator>>,
  input: {
    clientId: string;
    acceptor: { userId: string };
    routeId: string;
    bankAccountId: string;
    amount: string;
    clientRate: string;
    chain: ReturnType<typeof chainDeps>;
    /** What the client actually sent, when that differs from what they owe (short payment). */
    deposit?: string;
    /** Leave the trade waiting for its USDT, which is the first thing a client's own trade screen shows. */
    skipDeposit?: boolean;
    /** A request already made — one the desk routed to a trader, whose route the quote is then made on. */
    requestId?: string;
  },
): Promise<{ tradeId: string }> {
  const request = input.requestId
    ? { requestId: input.requestId }
    : await run(db, createRequest(owner.actor, {}), owner.ref, 'request.create', {
        clientId: input.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: input.amount,
        targetRate: input.clientRate, bankAccountId: input.bankAccountId,
      });
  const quote = await run(db, createQuote(owner.actor, {}), owner.ref, 'quote.create', {
    requestId: request.requestId, routeId: input.routeId, clientRate: input.clientRate, validitySeconds: 180,
  });
  await run(db, sendQuote(owner.actor, {}), owner.ref, 'quote.send', { quoteId: quote.quoteId });

  const session = await db
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: input.acceptor.userId, surface: 'CLIENT' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const clientActor: ClientActor = { kind: 'CLIENT', userId: input.acceptor.userId, sessionId: session.id };
  const accepted = await executeCommand(
    db,
    acceptQuote(clientActor, { custody: new FakeCustodyAdapter({ provider: VISUAL_CUSTODY_PROVIDER, capability: 'POOL', poolSize: 24, seed: 'visual' }), protector: visualFieldProtector() }),
    {
      name: 'quote.accept',
      actor: { type: 'USER', id: input.acceptor.userId, surface: 'CLIENT', sessionId: session.id },
      payload: { quoteId: quote.quoteId },
      idempotencyKey: randomUUID(),
      financial: true,
    },
  );
  const { tradeId } = accepted.result as { tradeId: string };

  if (input.skipDeposit) return { tradeId };

  const deposit = await db
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select('d.address')
    .where('a.trade_id', '=', tradeId)
    .executeTakeFirstOrThrow();
  input.chain.chain.add({ to: deposit.address, amountMinor: Money.parse(input.deposit ?? input.amount, 'USDT').minor });
  input.chain.chain.solidifyAll();
  await runTronScan(db, input.chain.deps);
  await runTronConfirm(db, input.chain.deps);
  return { tradeId };
}

/**
 * The trade's route delivers INR into the exchange's account, recorded against its obligation and — unless
 * `confirm: false` — confirmed against the bank: the only money a TO_EXCHANGE trade's client is ever paid with.
 */
async function routeDelivers(
  db: Db,
  owner: Awaited<ReturnType<typeof operator>>,
  chain: ReturnType<typeof chainDeps>,
  input: { tradeId: string; amount: string; inrAccountId: string; utr: string; confirm?: boolean },
): Promise<void> {
  const recorded = await run(db, recordRouteSettlement(owner.actor, chain.deps), owner.ref, 'route_settlement.record', {
    routeObligationId: await obligationOf(db, input.tradeId), flow: 'FROM_ROUTE_TO_EXCHANGE' as const,
    amount: input.amount, rail: 'IMPS' as const, utr: input.utr, inrAccountId: input.inrAccountId,
  });
  if (input.confirm !== false) {
    await run(db, confirmRouteSettlement(owner.actor, chain.deps), owner.ref, 'route_settlement.confirm', { routeSettlementId: recorded.routeSettlementId });
  }
}

async function obligationOf(db: Db, tradeId: string): Promise<string> {
  const r = await db.selectFrom('route_obligation').select('id').where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
  return r.id;
}

/** A client user allowed to accept their own quotes (D-01). */
async function acceptor(db: Db, clientAuth: ReturnType<typeof createClientAuth>, owner: Awaited<ReturnType<typeof operator>>, clientId: string, email: string, name: string) {
  const userId = await provisionClientUser(clientAuth, { email, name });
  await sql`update auth_user set email_verified = true where id = ${userId}`.execute(db);
  const linked = await run(db, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId, userId, role: 'CLIENT_ADMIN' as const });
  await run(db, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  return { userId };
}

/**
 * A client company's own person: provisioned like a real sign-up, email verified, linked as the company's admin with
 * authority to commit, and given a client session (with a fresh verification) for the seeding commands they take
 * themselves. The pages are later captured under a session the product issues through its own sign-in form.
 */
async function clientPerson(db: Db, clientAuth: ReturnType<typeof createClientAuth>, owner: Awaited<ReturnType<typeof operator>>, clientId: string, email: string, name: string) {
  const userId = await provisionClientUser(clientAuth, { email, name });
  await sql`update auth_user set email_verified = true where id = ${userId}`.execute(db);
  const linked = await run(db, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId, userId, role: 'CLIENT_ADMIN' as const });
  await run(db, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  const session = await db
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: userId, surface: 'CLIENT' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${userId}, ${session.id}, 'TOTP', statement_timestamp())`.execute(db);
  const actor: ClientActor = { kind: 'CLIENT', userId, sessionId: session.id };
  return { userId, email, actor, ref: { type: 'USER' as const, id: userId, surface: 'CLIENT' as const, sessionId: session.id } };
}

/** A client session for a person the seed already made, for the commands they take themselves. */
async function clientSession(db: Db, userId: string) {
  const session = await db
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: userId, surface: 'CLIENT' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const actor: ClientActor = { kind: 'CLIENT', userId, sessionId: session.id };
  return { actor, ref: { type: 'USER' as const, id: userId, surface: 'CLIENT' as const, sessionId: session.id } };
}

async function runClient<P, R>(db: Db, def: DomainCommand<P, R>, ref: { type: 'USER'; id: string; surface: 'CLIENT'; sessionId: string }, name: string, payload: P): Promise<R> {
  const out = await executeCommand(db, def, { name, actor: ref, payload, idempotencyKey: randomUUID(), financial: true });
  return out.result;
}

/** Creates an operator, completes real TOTP enrolment, and opens a server-side session for the seeding commands. */
async function operator(auth: ReturnType<typeof createOperatorAuth>, db: Db, email: string, roles: readonly OperatorRole[]) {
  const userId = await provisionOperator(auth, db, { email, name: email.split('@')[0]!, password: OPERATOR_PASSWORD, roles });
  const jar = new Map<string, string>();
  const call = async (p: string, body: unknown) => {
    const headers = new Headers({ 'content-type': 'application/json', origin: SEED_ORIGIN });
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.set('cookie', cookie);
    const res = await auth.handler(new Request(`${SEED_ORIGIN}/api/auth${p}`, { method: 'POST', headers, body: JSON.stringify(body) }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair!.indexOf('=');
      jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
    }
    return (await res.json()) as Record<string, unknown>;
  };
  await call('/sign-in/email', { email, password: OPERATOR_PASSWORD });
  const enable = await call('/two-factor/enable', { password: OPERATOR_PASSWORD });
  const totpSecret = new TextDecoder().decode(base32.decode(new URL(String(enable.totpURI)).searchParams.get('secret')!));
  await call('/two-factor/verify-totp', { code: await createOTP(totpSecret).totp() });

  const session = await db
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: userId, surface: 'OPERATOR' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${userId}, ${session.id}, 'TOTP', statement_timestamp())`.execute(db);
  const actor: OperatorActor = { kind: 'OPERATOR', userId, sessionId: session.id, roles, grants: [] };
  return { userId, email, totpSecret, actor, ref: actorRef(userId, session.id) };
}

export const totpFor = (secret: string): Promise<string> => createOTP(secret).totp();
