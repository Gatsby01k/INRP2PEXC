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
import { DualProviderChainVerifier, type FieldProtector, LocalKeyEncryptionKey, createFieldProtector } from '@inrp2p/adapters';
import { FAKE_USDT_CONTRACT, FakeCustodyAdapter, FakeTronChain, FakeTronProvider } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor, DomainCommand, OperatorActor, OperatorRole } from '@inrp2p/identity';
import { createClientAuth, createOperatorAuth, provisionClientUser, provisionOperator } from '@inrp2p/identity';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes } from '@inrp2p/clients';
import { createInrAccount, createSettlementEntity, setDayCapacity } from '@inrp2p/inr-accounts';
import { configureRoute, createRoute } from '@inrp2p/routes';
import { publishRouteRate } from '@inrp2p/pricing';
import { acceptQuote, createQuote, createQuoteLink, createRequest, sendQuote } from '@inrp2p/quotes';
import { confirmPayout, createPayoutLeg, recordLegEvidence, recordRouteSettlement, sendPayoutLeg } from '@inrp2p/settlement';
import { acknowledgedSignalHandler, clientNotificationHandler } from '@inrp2p/notifications';
import { runTronConfirm, runTronScan } from '@inrp2p/scanner';
import { importPoolAddresses, recordCustodyCapability, registerTreasuryWallet } from '@inrp2p/treasury';

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
  readonly tradeRefs: { readonly completed: string; readonly awaitingPayout: string; readonly awaitingDeposit: string };
  readonly openRequestId: string;
  /** The client product's own fixture: one signed-in person, one live quote, one link to it. */
  readonly client: { readonly email: string; readonly quoteRef: string; readonly linkToken: string };
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
  return { chain, primary, deps: { chain: new DualProviderChainVerifier({ primary, secondary, tokenContract: FAKE_USDT_CONTRACT }), provider: primary, scanner: { scanner } } };
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
  const protector = visualFieldProtector();

  // ── Clients ────────────────────────────────────────────────────────────────────────────────────────────
  const acme = await run(world, createClient(owner.actor), owner.ref, 'client.create', {
    legalName: 'Acme Pay Private Limited', displayName: 'Acme Pay', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const,
  });
  const acmeBank = await run(world, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: acme.clientId, holderName: 'Acme Pay Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0001234',
    accountNumber: '50100123458219', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  await run(world, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
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

  // ── The exchange's own money ────────────────────────────────────────────────────────────────────────────
  const entity = await run(world, createSettlementEntity(owner.actor), owner.ref, 'settlement_entity.create', {
    legalName: 'INRP2P Settlement Private Limited', shortName: 'INRP2P',
  });
  const account = await run(world, createInrAccount(owner.actor, protector), owner.ref, 'inr_account.create', {
    entityId: entity.entityId, label: 'Company A', bankName: 'ICICI Bank', ifsc: 'ICIC0001234', accountNumber: '000405001234',
    rails: ['IMPS', 'NEFT', 'RTGS'] as const, direction: 'BOTH' as const, defaultDailyCapacity: '50000000.00',
  });
  await run(world, setDayCapacity(owner.actor), owner.ref, 'capacity.set_day', { accountId: account.accountId, capacity: '50000000.00', reason: 'visual fixture' });

  const custody = new FakeCustodyAdapter({ provider: VISUAL_CUSTODY_PROVIDER, capability: 'POOL', poolSize: 24, seed: 'visual' });
  const poolWallet = await run(world, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: address('deposit-pool'), label: 'Deposit pool', role: 'DEPOSIT_POOL' as const,
  });
  const hot = await run(world, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: address('hot-wallet'), label: 'Hot wallet', role: 'HOT' as const,
  });
  await sql`update treasury_wallet set observed_balance_minor = ${Money.parse('2000000', 'USDT').minor} where id = ${hot.walletId}`.execute(world);
  await run(world, recordCustodyCapability(owner.actor), owner.ref, 'custody.record_capability', {
    provider: custody.provider, network: 'TRON' as const, capability: 'POOL' as const, consolidationNotes: 'Provider sweeps to the hot wallet.',
  });
  await run(world, importPoolAddresses(owner.actor, custody), owner.ref, 'custody.import_pool_addresses', { network: 'TRON' as const, treasuryWalletId: poolWallet.walletId });

  // Pin the wall-clock columns before any trade is priced: a quote measures its route snapshot's age against
  // the **business** clock, which is frozen here, so a snapshot stamped with real time would read as stale.
  await pinWallClockColumns(world);

  // ── Trades, one per state the desk has to show ──────────────────────────────────────────────────────────
  const chain = chainDeps('visual');

  // 1. Completed: the launch scenario, so Orders has a finished trade and the strip a realized margin.
  const completed = await trade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, bankAccountId: acmeBank.bankAccountId,
    amount: '100000', clientRate: '102.000000', chain,
  });
  for (const amount of ['6000000.00', '4200000.00']) {
    const leg = await run(world, createPayoutLeg(owner.actor, {}), owner.ref, 'payout_leg.create', {
      tradeId: completed.tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: account.accountId,
    });
    await run(world, sendPayoutLeg(owner.actor), owner.ref, 'payout_leg.send', { legId: leg.legId });
    await run(world, recordLegEvidence(owner.actor, chain.deps), owner.ref, 'payout_leg.record_evidence', {
      legId: leg.legId, rail: 'IMPS' as const, utr: `IXVIS${amount.slice(0, 7).replace('.', '')}`,
    });
    await confirmPayout(world, owner.actor, chain.deps, { legId: leg.legId, idempotencyKey: randomUUID() });
  }

  // 2. Awaiting payout, with a leg already sent and referenced — the payout panel with work in flight, and the
  //    ⧗ confirm the step-up capture needs.
  const awaiting = await trade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, bankAccountId: acmeBank.bankAccountId,
    amount: '25000', clientRate: '102.000000', chain,
  });
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

  // A route settlement recorded but not yet confirmed, so Rates shows the confirm the obligation is waiting on.
  await run(world, recordRouteSettlement(owner.actor, chain.deps), owner.ref, 'route_settlement.record', {
    routeObligationId: await obligationOf(world, completed.tradeId), flow: 'FROM_ROUTE_TO_EXCHANGE' as const,
    amount: '4000000.00', rail: 'IMPS' as const, utr: 'IXVISROUTE001', inrAccountId: account.accountId,
  });

  // ── The client product's own states ────────────────────────────────────────────────────────────────────
  // 6. A trade the client has accepted and not yet funded: the deposit instructions, which is the one screen a
  //    client is looking at while they move money.
  const awaitingDeposit = await trade(world, owner, {
    clientId: acme.clientId, acceptor: acmeAcceptor, routeId: mumbai.routeId, bankAccountId: acmeBank.bankAccountId,
    amount: '5000', clientRate: '102.000000', chain, skipDeposit: true,
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

  // 8. The inbox, filled the way production fills it: by running the outbox over the events these commands
  //    already enqueued. Nothing writes a notification directly.
  await dispatchOutbox(world, [clientNotificationHandler(world), acknowledgedSignalHandler()], { batchSize: 500 });

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
    tradeRefs: { completed: refOf(completed.tradeId), awaitingPayout: refOf(awaiting.tradeId), awaitingDeposit: refOf(awaitingDeposit.tradeId) },
    openRequestId: openRequest.requestId,
    client: { email: 'treasury@acmepay.test', quoteRef: pendingQuoteRef, linkToken },
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  await world.destroy();
  await authDb.destroy();
  return state;
}

/** Request → quote → the client's own acceptance → the chain's delivery, exactly as the product does it. */
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
  },
): Promise<{ tradeId: string }> {
  const request = await run(db, createRequest(owner.actor, {}), owner.ref, 'request.create', {
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
