import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import pg from 'pg';
import { sql } from 'kysely';
import { Money, encodeTronAddress, parseTrx } from '@inrp2p/kernel';
import { type Db, createDb, createPool } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { installQueue } from '@inrp2p/outbox';
import { HdWalletCustodyAdapter, TronSendNetwork } from '@inrp2p/adapters';
import { HdSigner } from '@inrp2p/adapters/signer';
import { FakeChainVerifier, FakeTronNetwork } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';
import { createClientAuth, createOperatorAuth, provisionClientUser } from '@inrp2p/identity';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes, setClientExchangeAccess } from '@inrp2p/clients';
import { recordCustodyHdAccount } from '@inrp2p/treasury';
import { claimNetworkDeposit, publishTrxRate } from '@inrp2p/network';
import { type OnchainDeps, runAutopay, runFeeRefresh, runHoldClosing, runMonitor, runSender } from '@inrp2p/onchain';
import { runTronConfirm } from '@inrp2p/scanner';
import { submitTxForVerification } from '@inrp2p/settlement';
import { applyAsTrader, approveTrader, configureTraderProgram, openDesk, setAvailability, setDeskPrices, setDeskStatus, sharedReserveAddress, updateBlock } from '@inrp2p/traders';
import { deskBaseUrl, startDesk, surfacePorts } from '../harness/desk-server.ts';
import { CLIENT_AUTH_SECRET, E2E_FIELD_KEYS, OPERATOR_AUTH_SECRET, e2eFieldProtector, operator, run } from './world.ts';

/**
 * The world of a desk (ADR 0020), end to end on the exchange's own rails: deal addresses derived from an HD account, a
 * TRON network the signer actually signs for, the trader's own TRX paying its deals' transfers. It is built inside the
 * test worker, because the chain is: what the browser does lands in the database, what the chain does happens here,
 * and the signer that releases each escrow runs here too — exactly the split between the web app and the worker.
 *
 * Its own database and its own server: the main run's world settles through a custody provider's pool (D-02); a desk's
 * deals settle P2P through the HD wallet, and a server is configured for one or the other.
 */
export const DESKS_DB = 'inrp2p_e2e_desks';
export const DESKS_OTP_SINK = path.join(import.meta.dirname, '.desks-otp.jsonl');

/** The BIP-39 test mnemonic: TronWeb's published vectors — never a wallet with money. */
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // secret-scan:allow — BIP-39's published test vector

export const DESK = {
  handle: 'rahul',
  name: 'Rahul OTC',
  legalName: 'Rahul OTC LLP',
  email: 'desk@rahulotc.test',
  /** What the desk pays for a client's USDT, and what it asks for its own. */
  sells: '101.800000',
  buys: '102.600000',
} as const;

export interface DeskWorld {
  readonly db: Db;
  readonly chain: FakeChainVerifier;
  readonly appUrl: string;
  readonly linkUrl: string;
  readonly deskWalletAddress: string;
  /** Moves USDT on the chain and has it seen: the scanner's detection and its confirmation once final. */
  sendUsdt(from: string, to: string, amount: string): Promise<void>;
  /** The worker's rails jobs, turned until the trade completes: plan, sign, broadcast, a block, settle. */
  settle(tradeId: string): Promise<string>;
  stop(): Promise<void>;
}

const withDatabase = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

async function runClient<P, R>(db: Db, def: DomainCommand<P, R>, ref: { type: 'USER'; id: string; surface: 'CLIENT'; sessionId: string }, name: string, payload: P): Promise<R> {
  return (await executeCommand(db, def, { name, actor: ref, payload, idempotencyKey: randomUUID(), financial: true })).result;
}

export async function createDeskWorld(adminUrl: string, port: number): Promise<DeskWorld> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${DESKS_DB} with (force)`);
  await admin.query(`create database ${DESKS_DB}`);
  await admin.end();
  await rm(DESKS_OTP_SINK, { force: true });

  const databaseUrl = withDatabase(adminUrl, DESKS_DB);
  const pool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-e2e-desks' });
  await migrate(pool);
  await installQueue(pool);
  const db = createDb(pool);
  const authDb = createDb(createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-e2e-desks-auth', int8: 'number' }));
  const seedOrigin = 'http://127.0.0.1';
  const operatorAuth = createOperatorAuth({ authDb, appDb: db, secret: OPERATOR_AUTH_SECRET, baseURL: seedOrigin, rateLimit: { enabled: false }, useSecureCookies: false });
  const clientAuth = createClientAuth({ authDb, appDb: db, secret: CLIENT_AUTH_SECRET, baseURL: seedOrigin, rateLimit: { enabled: false }, useSecureCookies: false, otpSender: { send: async () => {} } });
  const owner = await operator(operatorAuth, db, 'owner@inrp2p.test', ['OWNER']);
  const settler = await operator(operatorAuth, db, 'settlement@inrp2p.test', ['SETTLEMENT_OPERATOR']);
  const protector = e2eFieldProtector();

  // The exchange's own rails: the HD account deal addresses come from, the network the signer sends on, its fees and TRX price.
  const chain = new FakeChainVerifier();
  const signer = HdSigner.fromMnemonic(TEST_MNEMONIC);
  const custody = new HdWalletCustodyAdapter({ accountXpub: signer.accountXpub });
  await run(db, recordCustodyHdAccount(owner.actor, custody), owner.ref, 'custody.record_hd_account', {
    accountXpub: signer.accountXpub, feeWalletAddress: signer.feeWalletAddress, depositPoolAddress: encodeTronAddress(randomBytes(20)),
  });
  const net = new FakeTronNetwork(chain);
  const rails: OnchainDeps = {
    network: new TronSendNetwork([net.gateway('node-a'), net.gateway('node-b')]), signer, chain, clock: () => net.headTime,
    policy: { validitySeconds: 120, expiryMarginSeconds: 6, rebroadcastSeconds: 0, unresolvedAfterMinutes: 30 },
  };
  await runFeeRefresh(db, rails);
  await run(db, publishTrxRate(owner.actor), owner.ref, 'network.publish_trx_rate', { usdtPerTrx: '0.300000', source: 'e2e', confirmLargeChange: true });
  const programme = await db.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await run(db, configureTraderProgram(owner.actor), owner.ref, 'trader_program.configure', {
    expectedVersion: programme.version, defaultRequiredReserve: '500', executionMode: 'P2P' as const, reason: 'desks deal P2P',
  });

  const sendUsdt = async (from: string, to: string, amount: string) => {
    const receipt = chain.add({ from, to, amountMinor: Money.parse(amount, 'USDT').minor });
    await run(db, submitTxForVerification(settler.actor, { chain }), settler.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
    await runTronConfirm(db, { chain, providers: [] });
  };

  // The trader: its company, its own bank account and wallet, its administrator — a real sign-up the desk signs in as.
  const company = await run(db, createClient(owner.actor), owner.ref, 'client.create', { legalName: DESK.legalName, displayName: DESK.name, type: 'COMPANY' as const, typicalDirection: 'BUY_USDT' as const });
  await run(db, setClientExchangeAccess(owner.actor), owner.ref, 'client.set_exchange_access', { clientId: company.clientId, exchangeAccess: false, reason: 'runs its own desk' });
  const bank = await run(db, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: company.clientId, holderName: DESK.legalName, bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK0000123', accountNumber: '74130211980057', railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const deskWalletAddress = encodeTronAddress(randomBytes(20));
  const wallet = await run(db, addWallet(owner.actor), owner.ref, 'client_wallet.add', { clientId: company.clientId, network: 'TRON' as const, address: deskWalletAddress, purpose: 'BOTH' as const, label: 'Desk wallet' });
  const userId = await provisionClientUser(clientAuth, { email: DESK.email, name: 'Rahul' });
  await sql`update auth_user set email_verified = true where id = ${userId}`.execute(db);
  const linked = await run(db, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: company.clientId, userId, role: 'CLIENT_ADMIN' as const });
  await run(db, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  const session = await db.insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: userId, surface: 'CLIENT' })
    .returning('id').executeTakeFirstOrThrow();
  await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${userId}, ${session.id}, 'TOTP', statement_timestamp())`.execute(db);
  const actor: ClientActor = { kind: 'CLIENT', userId, sessionId: session.id };
  const ref = { type: 'USER' as const, id: userId, surface: 'CLIENT' as const, sessionId: session.id };

  // Applied, approved, its Security Reserve and its TRX network deposit sent from its registered wallet, both sides live.
  await runClient(db, applyAsTrader(actor, { protector }), ref, 'trader.apply', {
    experience: 'BINANCE' as const, telegram: '@rahul_otc', confirmOwnership: true, offersBuy: true, offersSell: true,
    typicalInr: '1000000.00', dailyInr: '5000000.00', typicalUsdt: '10000.000000', dailyUsdt: '50000.000000', bankAccountId: bank.bankAccountId, walletId: wallet.walletId,
  });
  const traderId = (await db.selectFrom('trader_profile').select('id').where('client_id', '=', company.clientId).executeTakeFirstOrThrow()).id;
  await run(db, approveTrader(owner.actor), owner.ref, 'trader.approve', { traderId, requiredReserve: '500' });
  await sendUsdt(deskWalletAddress, (await sharedReserveAddress(db))!.address, '500');
  const txid = net.externalTrxTransfer({ from: deskWalletAddress, to: signer.feeWalletAddress, amountSun: parseTrx('1000') });
  const facts = await rails.network.trxTransfer(txid);
  if (facts.status !== 'FINAL') throw new Error(`the network deposit is not final: ${facts.status}`);
  await runClient(db, claimNetworkDeposit(actor, facts.transfer), ref, 'network_deposit.claim', { txHash: txid });
  for (const [side, cfg] of [
    ['BUY_USDT', { capacity: '5000000.00', rate: '101.20', minOrder: '1000.00', maxOrder: '2000000.00' }],
    ['SELL_USDT', { capacity: '50000.000000', rate: '102.20', minOrder: '10.000000', maxOrder: '20000.000000' }],
  ] as const) {
    const block = await db.selectFrom('trader_block').select('version').where('trader_id', '=', traderId).where('side', '=', side).executeTakeFirstOrThrow();
    await runClient(db, updateBlock(actor), ref, 'trader.update_block', { side, expectedVersion: block.version, ...cfg, status: 'ACTIVE' as const });
  }
  await runClient(db, setAvailability(actor), ref, 'trader.set_availability', { available: true });

  // Its desk: its address, its prices on both sides, live.
  const opened = await runClient(db, openDesk(actor), ref, 'desk.open', { handle: DESK.handle, displayName: DESK.name, about: 'OTC desk in Pune. IMPS and NEFT, 9:00–23:00 IST.' });
  await runClient(db, setDeskPrices(actor), ref, 'desk.set_prices', {
    prices: [
      { direction: 'SELL_USDT' as const, rate: DESK.sells, min: '100', max: '20000', live: true },
      { direction: 'BUY_USDT' as const, rate: DESK.buys, min: '100', max: '10000', live: true },
    ],
    validForHours: 24,
  });
  await runClient(db, setDeskStatus(actor), ref, 'desk.set_status', { expectedVersion: opened.version, status: 'LIVE' as const });
  await authDb.destroy();

  const ports = surfacePorts(port);
  const stopServer = await startDesk({
    port, databaseUrl, operatorAuthSecret: OPERATOR_AUTH_SECRET, clientAuthSecret: CLIENT_AUTH_SECRET, surfaces: ['app', 'public'],
    fieldKeys: E2E_FIELD_KEYS, custodyProvider: custody.provider, custodyCapability: 'DERIVED', custodyXpub: signer.accountXpub,
    clientOtpSinkFile: DESKS_OTP_SINK, label: 'e2e-desks',
  });

  return {
    db, chain, deskWalletAddress, sendUsdt,
    appUrl: deskBaseUrl(ports.app),
    linkUrl: deskBaseUrl(ports.public),
    async settle(tradeId) {
      // A trade completes when its payee confirms; the escrow's payout is the signer's afterwards. Turn until it is final.
      for (let turn = 0; turn < 10; turn++) {
        await runAutopay(db, rails);
        await runSender(db, rails);
        net.mine();
        await runMonitor(db, rails);
        await runHoldClosing(db);
        const sends = await db.selectFrom('chain_send').select('status').where('trade_id', '=', tradeId).execute();
        if (sends.length > 0 && sends.every((x) => x.status === 'CONFIRMED' || x.status === 'CANCELLED')) break;
      }
      return (await db.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow()).lifecycle_state;
    },
    async stop() {
      await stopServer();
      await db.destroy();
    },
  };
}
