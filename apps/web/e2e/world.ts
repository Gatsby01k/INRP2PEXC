import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { sql } from 'kysely';
import { base32 } from '@better-auth/utils/base32';
import { createOTP } from '@better-auth/utils/otp';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { type Db, createDb, createPool } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { installQueue } from '@inrp2p/outbox';
import { FakeCustodyAdapter, testFieldProtector } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { DomainCommand } from '@inrp2p/identity';
import { type OperatorActor, type OperatorRole, createClientAuth, createOperatorAuth, provisionClientUser, provisionOperator } from '@inrp2p/identity';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes } from '@inrp2p/clients';
import { createInrAccount, createSettlementEntity, setDayCapacity } from '@inrp2p/inr-accounts';
import { configureRoute, createRoute } from '@inrp2p/routes';
import { publishRouteRate } from '@inrp2p/pricing';
import { importPoolAddresses, recordCustodyCapability, registerTreasuryWallet } from '@inrp2p/treasury';

export const E2E_DB = 'inrp2p_e2e';
export const STATE_FILE = path.join(import.meta.dirname, '.state.json');
export const OPERATOR_PASSWORD = 'desk-operator-passphrase-1'; // secret-scan:allow — fixture for a throwaway database

/**
 * The auth secrets for the run. The seed and the server must share them exactly: Better Auth encrypts an
 * operator's TOTP secret with the auth secret, so a seed that invents its own enrols an authenticator the desk
 * can never decrypt — the code is correct and sign-in still fails. Fixed and obviously fake; they exist only
 * for a throwaway database on a loopback port.
 */
export const OPERATOR_AUTH_SECRET = 'e2e-operator-secret-0123456789abcdef'; // secret-scan:allow
export const CLIENT_AUTH_SECRET = 'e2e-client-secret-0123456789abcdef'; // secret-scan:allow

export interface E2EOperator {
  readonly email: string;
  readonly password: string;
  /** Raw TOTP secret, so a test can compute the code the desk asks for. */
  readonly totpSecret: string;
  readonly roles: readonly OperatorRole[];
}

export interface E2EState {
  readonly databaseUrl: string;
  readonly owner: E2EOperator;
  readonly settlementOperator: E2EOperator;
  readonly clientId: string;
  readonly clientName: string;
  readonly bankAccountId: string;
  readonly walletId: string;
  readonly routeId: string;
  readonly inrAccountId: string;
  readonly acceptorUserId: string;
  readonly acceptorClientUserId: string;
  readonly hotWalletId: string;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const actorRef = (userId: string, sessionId: string) => ({ type: 'USER' as const, id: userId, surface: 'OPERATOR' as const, sessionId });

async function run<P, R>(db: Db, def: DomainCommand<P, R>, ref: ReturnType<typeof actorRef>, name: string, payload: P): Promise<R> {
  const out = await executeCommand(db, def, { name, actor: ref, payload, idempotencyKey: randomUUID(), financial: true });
  return out.result;
}

/**
 * Builds the world the end-to-end run needs, using the same domain commands an operator would: a desk account
 * with real TOTP enrolment, a client with a destination and an authorized acceptor, a route with a published
 * rate, an INR account with capacity, and a treasury with a deposit pool. Nothing is written directly except
 * the observed treasury balance, which only the chain would otherwise supply.
 */
export async function seedE2E(adminUrl: string): Promise<E2EState> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${E2E_DB} with (force)`);
  await admin.query(`create database ${E2E_DB}`);
  await admin.end();

  const databaseUrl = withDatabase(adminUrl, E2E_DB);
  const pool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-e2e-seed' });
  await migrate(pool);
  await installQueue(pool);
  const db = createDb(pool);
  const authPool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-e2e-auth', int8: 'number' });
  const authDb = createDb(authPool);

  const auth = createOperatorAuth({
    authDb,
    appDb: db,
    secret: OPERATOR_AUTH_SECRET,
    baseURL: 'http://localhost',
    rateLimit: { enabled: false },
    useSecureCookies: false,
  });

  const owner = await operator(auth, db, 'owner@inrp2p.test', ['OWNER']);
  const settlementOperator = await operator(auth, db, 'settlement@inrp2p.test', ['SETTLEMENT_OPERATOR']);
  const protector = testFieldProtector('e2e-kek');

  const client = await run(db, createClient(owner.actor), owner.ref, 'client.create', {
    legalName: 'Acme Pay Private Limited', displayName: 'Acme Pay', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const,
  });
  const bank = await run(db, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: client.clientId, holderName: 'Acme Pay Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0001234',
    accountNumber: '50100123458219', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const wallet = await run(db, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
    clientId: client.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'DESTINATION' as const, label: 'Acme wallet',
  });

  const clientAuth = createClientAuth({
    authDb, appDb: db, secret: CLIENT_AUTH_SECRET, baseURL: 'http://localhost',
    rateLimit: { enabled: false }, useSecureCookies: false, otpSender: { send: async () => {} },
  });
  const acceptorUserId = await provisionClientUser(clientAuth, { email: 'treasury@acmepay.test', name: 'Acme treasury' });
  await sql`update auth_user set email_verified = true where id = ${acceptorUserId}`.execute(db);
  const linked = await run(db, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: client.clientId, userId: acceptorUserId, role: 'CLIENT_ADMIN' as const });
  await run(db, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });

  // The demo scenario's route settles to the exchange, so the desk pays the client from its own accounts.
  const route = await run(db, createRoute(owner.actor), owner.ref, 'routes.create', {
    name: 'Mumbai OTC', direction: 'BOTH' as const, executionMode: 'DIRECT_TO_CLIENT' as const,
    registeredRouteAddress: encodeTronAddress(randomBytes(20)), availableBaseUsdt: '5000000',
  });
  await run(db, configureRoute(owner.actor), owner.ref, 'routes.configure', {
    routeId: route.routeId, expectedVersion: 1, executionMode: 'TO_EXCHANGE' as const, reason: 'the provider settles into our own account',
  });
  await run(db, publishRouteRate(owner.actor), owner.ref, 'rates.publish_route', { routeId: route.routeId, direction: 'SELL_USDT' as const, rate: '104.200000' });
  await run(db, publishRouteRate(owner.actor), owner.ref, 'rates.publish_route', { routeId: route.routeId, direction: 'BUY_USDT' as const, rate: '100.000000' });

  const entity = await run(db, createSettlementEntity(owner.actor), owner.ref, 'settlement_entity.create', {
    legalName: 'INRP2P Settlement Private Limited', shortName: 'INRP2P',
  });
  const account = await run(db, createInrAccount(owner.actor, protector), owner.ref, 'inr_account.create', {
    entityId: entity.entityId, label: 'Company A', bankName: 'ICICI Bank', ifsc: 'ICIC0001234', accountNumber: '000405001234',
    rails: ['IMPS', 'NEFT', 'RTGS'] as const, direction: 'BOTH' as const, defaultDailyCapacity: '50000000.00',
  });
  await run(db, setDayCapacity(owner.actor), owner.ref, 'capacity.set_day', { accountId: account.accountId, capacity: '50000000.00', reason: 'end-to-end run' });

  const custody = new FakeCustodyAdapter({ capability: 'POOL', poolSize: 20, seed: 'e2e' });
  const poolWallet = await run(db, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Deposit pool', role: 'DEPOSIT_POOL' as const,
  });
  const hot = await run(db, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Hot wallet', role: 'HOT' as const,
  });
  await sql`update treasury_wallet set observed_balance_minor = ${Money.parse('2000000', 'USDT').minor}, observed_at = statement_timestamp(), updated_at = statement_timestamp() where id = ${hot.walletId}`.execute(db);
  await run(db, recordCustodyCapability(owner.actor), owner.ref, 'custody.record_capability', {
    provider: custody.provider, network: 'TRON' as const, capability: 'POOL' as const, consolidationNotes: 'Provider sweeps to the hot wallet.',
  });
  await run(db, importPoolAddresses(owner.actor, custody), owner.ref, 'custody.import_pool_addresses', { network: 'TRON' as const, treasuryWalletId: poolWallet.walletId });

  const state: E2EState = {
    databaseUrl,
    owner: { email: owner.email, password: OPERATOR_PASSWORD, totpSecret: owner.totpSecret, roles: ['OWNER'] },
    settlementOperator: { email: settlementOperator.email, password: OPERATOR_PASSWORD, totpSecret: settlementOperator.totpSecret, roles: ['SETTLEMENT_OPERATOR'] },
    clientId: client.clientId,
    clientName: 'Acme Pay',
    bankAccountId: bank.bankAccountId,
    walletId: wallet.walletId,
    routeId: route.routeId,
    inrAccountId: account.accountId,
    acceptorUserId,
    acceptorClientUserId: linked.clientUserId,
    hotWalletId: hot.walletId,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  await db.destroy();
  await authDb.destroy();
  return state;
}

/** Creates an operator, completes real TOTP enrolment, and opens a server-side session for the seeding commands. */
async function operator(auth: ReturnType<typeof createOperatorAuth>, db: Db, email: string, roles: readonly OperatorRole[]) {
  const userId = await provisionOperator(auth, db, { email, name: email.split('@')[0]!, password: OPERATOR_PASSWORD, roles });
  const jar = new Map<string, string>();
  const call = async (path: string, body: unknown) => {
    const headers = new Headers({ 'content-type': 'application/json', origin: 'http://localhost' });
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.set('cookie', cookie);
    const res = await auth.handler(new Request(`http://localhost/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
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
  const ref = await sessionFor(db, userId);
  const actor: OperatorActor = { kind: 'OPERATOR', userId, sessionId: ref.sessionId, roles, grants: [] };
  return { userId, email, totpSecret, actor, ref };
}

/** A server-side session row for the seeding commands (the browser gets its own by signing in). */
async function sessionFor(db: Db, userId: string) {
  const session = await db
    .insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: userId, surface: 'OPERATOR' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${userId}, ${session.id}, 'TOTP', statement_timestamp())`.execute(db);
  return actorRef(userId, session.id);
}

export const totpFor = (secret: string): Promise<string> => createOTP(secret).totp();
