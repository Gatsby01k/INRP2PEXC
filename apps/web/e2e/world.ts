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
import { type FieldProtector, LocalKeyEncryptionKey, createFieldProtector } from '@inrp2p/adapters';
import { FakeChainVerifier, FakeCustodyAdapter } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { DomainCommand } from '@inrp2p/identity';
import { type ClientActor, type OperatorActor, type OperatorRole, createClientAuth, createOperatorAuth, provisionClientUser, provisionOperator } from '@inrp2p/identity';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes } from '@inrp2p/clients';
import { runTronConfirm } from '@inrp2p/scanner';
import { submitTxForVerification } from '@inrp2p/settlement';
import { applyAsTrader, approveTrader, configureTraderProgram, setAvailability, sharedReserveAddress, updateBlock } from '@inrp2p/traders';
import { importPoolAddresses, recordCustodyCapability, registerTreasuryWallet } from '@inrp2p/treasury';
import { fundBudget, seedNetworkCosts } from '@inrp2p/network/testing';

export const E2E_DB = 'inrp2p_e2e';
export const STATE_FILE = path.join(import.meta.dirname, '.state.json');
/**
 * The origin the seed's own in-process Better Auth calls use. Nothing is resolved or connected here — the
 * handler is invoked directly — but it is written as a literal address for the same reason the harness binds
 * one: a name in a test origin is a trap waiting for the next person who copies it.
 */
const SEED_ORIGIN = 'http://127.0.0.1';

export const OPERATOR_PASSWORD = 'desk-operator-passphrase-1'; // secret-scan:allow — fixture for a throwaway database

/**
 * The auth secrets for the run. The seed and the server must share them exactly: Better Auth encrypts an
 * operator's TOTP secret with the auth secret, so a seed that invents its own enrols an authenticator the desk
 * can never decrypt — the code is correct and sign-in still fails. Fixed and obviously fake; they exist only
 * for a throwaway database on a loopback port.
 */
export const OPERATOR_AUTH_SECRET = 'e2e-operator-secret-0123456789abcdef'; // secret-scan:allow
export const CLIENT_AUTH_SECRET = 'e2e-client-secret-0123456789abcdef'; // secret-scan:allow

/**
 * Field-protection keys for the run, fixed for the same reason the auth secrets are: the built app seals an
 * acceptance code into `otp_delivery`, and the harness has to open it to play the part of the email provider.
 * Two processes cannot do that with keys one of them invented. Obviously fake, and only ever a throwaway
 * database on a loopback port.
 */
export const E2E_FIELD_KEYS = {
  keyId: 'e2e-kek',
  kekBase64: 'ZTJlLWtlay1tYXRlcmlhbC0wMTIzNDU2Nzg5YWJjZGU=', // secret-scan:allow
  hmacBase64: 'ZTJlLWhtYWMtbWF0ZXJpYWwtMDEyMzQ1Njc4OWFiY2U=', // secret-scan:allow
} as const;

/** The one protector the seed, the built app and the harness all share. */
export function e2eFieldProtector(): FieldProtector {
  return createFieldProtector({
    kek: LocalKeyEncryptionKey.fromBase64(E2E_FIELD_KEYS.keyId, E2E_FIELD_KEYS.kekBase64),
    hmacKey: Buffer.from(E2E_FIELD_KEYS.hmacBase64, 'base64'),
  });
}

/** The custody provider the world records a POOL capability for; the app is configured with the same slug (D-02). */
export const E2E_CUSTODY_PROVIDER = 'fake-custody';

/**
 * The addresses the public site is configured to publish in this run, on the reserved `.test` domain, so the way
 * in for a new client can be followed end to end. Nothing on the public site links to an address not listed here.
 */
export const E2E_PUBLIC_CONTACTS = { desk: 'desk@inrp2p.test', security: 'security@inrp2p.test' } as const;

/** The client user who may accept quotes (D-01); the run signs in as them and receives acceptance codes. */
export const ACCEPTOR_EMAIL = 'treasury@acmepay.test';

export interface E2EOperator {
  readonly email: string;
  readonly password: string;
  /** Raw TOTP secret, so a test can compute the code the desk asks for. */
  readonly totpSecret: string;
  readonly roles: readonly OperatorRole[];
}

/** The trader the world's client deals with; the run plays its part with the real commands. */
export interface E2ETrader {
  readonly traderId: string;
  readonly userId: string;
  /** How the bank shows the trader's account as a sender. */
  readonly holderName: string;
}

export interface E2EState {
  readonly databaseUrl: string;
  readonly owner: E2EOperator;
  readonly clientId: string;
  readonly bankAccountId: string;
  readonly trader: E2ETrader;
  readonly acceptorUserId: string;
  readonly acceptorEmail: string;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const actorRef = (userId: string, sessionId: string) => ({ type: 'USER' as const, id: userId, surface: 'OPERATOR' as const, sessionId });

export async function run<P, R>(db: Db, def: DomainCommand<P, R>, ref: ReturnType<typeof actorRef>, name: string, payload: P): Promise<R> {
  const out = await executeCommand(db, def, { name, actor: ref, payload, idempotencyKey: randomUUID(), financial: true });
  return out.result;
}

/** A client person acting from a server-side session, verified a moment ago: what a trader's own commands run as. */
export async function asClient<P, R>(db: Db, userId: string, def: (actor: ClientActor) => DomainCommand<P, R>, name: string, payload: P): Promise<R> {
  const session = await db.insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: userId, surface: 'CLIENT' })
    .returning('id').executeTakeFirstOrThrow();
  await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${userId}, ${session.id}, 'TOTP', statement_timestamp())`.execute(db);
  const out = await executeCommand(db, def({ kind: 'CLIENT', userId, sessionId: session.id }), {
    name, actor: { type: 'USER', id: userId, surface: 'CLIENT', sessionId: session.id }, payload, idempotencyKey: randomUUID(), financial: true,
  });
  return out.result;
}

/**
 * Builds the world the end-to-end run needs, using the same domain commands an operator would: a desk account
 * with real TOTP enrolment, a client with a destination and an authorized acceptor, a trader for it to deal with, and
 * a treasury with a deposit pool. Nothing is written directly except what only the chain would otherwise supply.
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
    baseURL: SEED_ORIGIN,
    rateLimit: { enabled: false },
    useSecureCookies: false,
  });

  const owner = await operator(auth, db, 'owner@inrp2p.test', ['OWNER']);
  const settlementOperator = await operator(auth, db, 'settlement@inrp2p.test', ['SETTLEMENT_OPERATOR']);
  const protector = e2eFieldProtector();

  const client = await run(db, createClient(owner.actor), owner.ref, 'client.create', {
    legalName: 'Acme Pay Private Limited', displayName: 'Acme Pay', type: 'COMPANY' as const, typicalDirection: 'SELL_USDT' as const,
  });
  const bank = await run(db, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: client.clientId, holderName: 'Acme Pay Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0001234',
    accountNumber: '50100123458219', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  await run(db, addWallet(owner.actor), owner.ref, 'client_wallet.add', {
    clientId: client.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'DESTINATION' as const, label: 'Acme wallet',
  });

  const clientAuth = createClientAuth({
    authDb, appDb: db, secret: CLIENT_AUTH_SECRET, baseURL: SEED_ORIGIN,
    rateLimit: { enabled: false }, useSecureCookies: false, otpSender: { send: async () => {} },
  });
  const acceptorUserId = await provisionClientUser(clientAuth, { email: ACCEPTOR_EMAIL, name: 'Acme treasury' });
  await sql`update auth_user set email_verified = true where id = ${acceptorUserId}`.execute(db);
  const linked = await run(db, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: client.clientId, userId: acceptorUserId, role: 'CLIENT_ADMIN' as const });
  await run(db, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });

  // What a transfer costs on TRON (ADR 0017): every quote carries its network fee.
  await seedNetworkCosts(db);

  const trader = await seedTrader(db, clientAuth, owner, settlementOperator, protector);

  const custody = new FakeCustodyAdapter({ provider: E2E_CUSTODY_PROVIDER, capability: 'POOL', poolSize: 20, seed: 'e2e' });
  const poolWallet = await run(db, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Deposit pool', role: 'DEPOSIT_POOL' as const,
  });
  await run(db, registerTreasuryWallet(owner.actor), owner.ref, 'treasury.register_wallet', {
    network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Hot wallet', role: 'HOT' as const,
  });
  await run(db, recordCustodyCapability(owner.actor), owner.ref, 'custody.record_capability', {
    provider: custody.provider, network: 'TRON' as const, capability: 'POOL' as const, consolidationNotes: 'Provider sweeps to the hot wallet.',
  });
  await run(db, importPoolAddresses(owner.actor, custody), owner.ref, 'custody.import_pool_addresses', { network: 'TRON' as const, treasuryWalletId: poolWallet.walletId });

  const state: E2EState = {
    databaseUrl,
    owner: { email: owner.email, password: OPERATOR_PASSWORD, totpSecret: owner.totpSecret, roles: ['OWNER'] },
    clientId: client.clientId,
    bankAccountId: bank.bankAccountId,
    trader,
    acceptorUserId,
    acceptorEmail: ACCEPTOR_EMAIL,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  await db.destroy();
  await authDb.destroy();
  return state;
}

/** The rates the world's trader deals at; a client's screen never shows either. */
const TRADER_BUYS_AT = '104.20';
const TRADER_SELLS_AT = '105.20';
const TRADER_NAME = 'Mumbai OTC LLP';

/** A trader: its company, bank account and wallet, a real application, its Security Reserve read from the chain, both sides live. */
async function seedTrader(
  db: Db, clientAuth: ReturnType<typeof createClientAuth>, owner: Awaited<ReturnType<typeof operator>>, settler: Awaited<ReturnType<typeof operator>>, protector: FieldProtector,
): Promise<E2ETrader> {
  const programme = await db.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await run(db, configureTraderProgram(owner.actor), owner.ref, 'trader_program.configure', { expectedVersion: programme.version, riskPolicy: null, reason: 'end-to-end run' });
  const company = await run(db, createClient(owner.actor), owner.ref, 'client.create', { legalName: TRADER_NAME, displayName: 'Mumbai OTC', type: 'COMPANY' as const, typicalDirection: 'BUY_USDT' as const });
  const bank = await run(db, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: company.clientId, holderName: TRADER_NAME, bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK0000123', accountNumber: '74130211980057', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const address = encodeTronAddress(randomBytes(20));
  const wallet = await run(db, addWallet(owner.actor), owner.ref, 'client_wallet.add', { clientId: company.clientId, network: 'TRON' as const, address, purpose: 'BOTH' as const, label: 'Trader wallet' });
  const userId = await provisionClientUser(clientAuth, { email: 'desk@mumbaiotc.test', name: 'Mumbai OTC' });
  await sql`update auth_user set email_verified = true where id = ${userId}`.execute(db);
  const linked = await run(db, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: company.clientId, userId, role: 'CLIENT_ADMIN' as const });
  await run(db, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  await asClient(db, userId, (actor) => applyAsTrader(actor, { protector }), 'trader.apply', {
    experience: 'BINANCE' as const, telegram: '@mumbai_otc', confirmOwnership: true, offersBuy: true, offersSell: true,
    typicalInr: '1000000.00', dailyInr: '50000000.00', typicalUsdt: '10000.000000', dailyUsdt: '500000.000000', bankAccountId: bank.bankAccountId, walletId: wallet.walletId,
  });
  const traderId = (await db.selectFrom('trader_profile').select('id').where('client_id', '=', company.clientId).executeTakeFirstOrThrow()).id;
  await run(db, approveTrader(owner.actor), owner.ref, 'trader.approve', { traderId, requiredReserve: '500' });
  await fundBudget(db, { traderId, amountSun: 1_000_000_000_000n, from: address });
  const chain = new FakeChainVerifier();
  const receipt = chain.add({ from: address, to: (await sharedReserveAddress(db))!.address, amountMinor: Money.parse('500', 'USDT').minor });
  await run(db, submitTxForVerification(settler.actor, { chain }), settler.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
  await runTronConfirm(db, { chain, providers: [] });
  for (const [side, cfg] of [
    ['BUY_USDT', { capacity: '50000000.00', rate: TRADER_BUYS_AT, minOrder: '1000.00', maxOrder: '20000000.00' }],
    ['SELL_USDT', { capacity: '500000.000000', rate: TRADER_SELLS_AT, minOrder: '10.000000', maxOrder: '200000.000000' }],
  ] as const) {
    const block = await db.selectFrom('trader_block').select('version').where('trader_id', '=', traderId).where('side', '=', side).executeTakeFirstOrThrow();
    await asClient(db, userId, (actor) => updateBlock(actor), 'trader.update_block', { side, expectedVersion: block.version, ...cfg, status: 'ACTIVE' as const });
  }
  await asClient(db, userId, (actor) => setAvailability(actor), 'trader.set_availability', { available: true });
  return { traderId, userId, holderName: TRADER_NAME };
}

/** Creates an operator, completes real TOTP enrolment, and opens a server-side session for the seeding commands. */
export async function operator(auth: ReturnType<typeof createOperatorAuth>, db: Db, email: string, roles: readonly OperatorRole[]) {
  const userId = await provisionOperator(auth, db, { email, name: email.split('@')[0]!, password: OPERATOR_PASSWORD, roles });
  const jar = new Map<string, string>();
  const call = async (path: string, body: unknown) => {
    const headers = new Headers({ 'content-type': 'application/json', origin: SEED_ORIGIN });
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.set('cookie', cookie);
    const res = await auth.handler(new Request(`${SEED_ORIGIN}/api/auth${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
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
