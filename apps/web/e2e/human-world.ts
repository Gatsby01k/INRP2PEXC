import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import pg from 'pg';
import { sql } from 'kysely';
import { Money, Rate, encodeTronAddress } from '@inrp2p/kernel';
import { type Db, createDb, createPool } from '@inrp2p/db';
import { migrate } from '@inrp2p/db/migrate';
import { installQueue } from '@inrp2p/outbox';
import { HdWalletCustodyAdapter, TronSendNetwork } from '@inrp2p/adapters';
import { HdSigner } from '@inrp2p/adapters/signer';
import { FakeChainVerifier, FakeGasFree, FakeTronNetwork } from '@inrp2p/adapters/testing';
import { executeCommand } from '@inrp2p/commands';
import type { ClientActor, DomainCommand } from '@inrp2p/identity';
import { createClientAuth, createOperatorAuth, provisionClientUser } from '@inrp2p/identity';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes, setClientExchangeAccess } from '@inrp2p/clients';
import { recordCustodyHdAccount } from '@inrp2p/treasury';
import { publishTrxRate, setNetworkFeePolicy } from '@inrp2p/network';
import { type OnchainDeps, runAutopay, runFeeRefresh, runGasFreeFeeRefresh, runHoldClosing, runMonitor, runSender } from '@inrp2p/onchain';
import { currentPricingPolicy, setPricingPolicy } from '@inrp2p/pricing';
import { runMarketReferenceRefresh } from '@inrp2p/quotes';
import { runTronConfirm } from '@inrp2p/scanner';
import { submitTxForVerification } from '@inrp2p/settlement';
import { applicationsUnderReview, applyAsTrader, approveTrader, autoReviewTraderInTx, configureTraderProgram, setAvailability, sharedReserveAddress, updateBlock } from '@inrp2p/traders';
import { deskBaseUrl, startDesk, surfacePorts } from '../harness/desk-server.ts';
import { CLIENT_AUTH_SECRET, E2E_FIELD_KEYS, OPERATOR_AUTH_SECRET, OPERATOR_PASSWORD, e2eFieldProtector, operator, run } from './world.ts';

/**
 * The INRP2P exchange as a client and a trader meet it, end to end on the exchange's own rails (ADR 0017/0019/0022): a
 * trader that fills INRP2P's deals (no desk of its own), INRP2P's operator, and — signed up in the run itself, on its
 * phone — a client. Automatic prices start **off**, as production runs them today (ADR 0025): a person prices each request
 * until the run switches them on.
 *
 * Everything a person does happens in the browser. What happens here is only what is not a person: the chain (a wallet
 * app sending USDT, and the scanner seeing it) and the worker's jobs (the signer releasing the escrow).
 */
export const HUMAN_DB = 'inrp2p_e2e_human';
export const HUMAN_OTP_SINK = path.join(import.meta.dirname, '.human-otp.jsonl');

/** The BIP-39 test mnemonic: TronWeb's published vectors — never a wallet with money. */
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // secret-scan:allow — BIP-39's published test vector

export const TRADER = {
  email: 'arjun@arjuntraders.test',
  name: 'Arjun Traders',
  legalName: 'Arjun Traders LLP',
  bank: 'ICICI Bank',
  ifsc: 'ICIC0000104',
  account: '91820045567321',
  /** What it pays for a client's USDT, and what it asks for its own. */
  buys: '101.80',
  sells: '101.20',
} as const;

export interface HumanWorld {
  readonly db: Db;
  readonly chain: FakeChainVerifier;
  readonly deskUrl: string;
  readonly appUrl: string;
  readonly operator: { readonly email: string; readonly password: string; readonly totpSecret: string };
  readonly traderWalletAddress: string;
  /** A wallet app sends USDT and the chain scanner sees it, final. */
  sendUsdt(from: string, to: string, amount: string): Promise<void>;
  /** The worker's rails jobs, turned until the trade's escrow has paid out (or returned): plan, sign, broadcast, a block, settle. */
  settle(tradeId: string): Promise<string>;
  /** The owner switches automatic prices on against a fresh market, and the trader makes both its offers firm. */
  /** The owner's one switch (ADR 0025, 0028): the market read, automatic prices and price requests on. Traders do their own part on their phone. */
  automaticPricesOn(): Promise<void>;
  /** The shared Security Reserve address every trader sends its reserve to. */
  reserveAddress(): Promise<string>;
  /** The programme's own review (ADR 0024), as the worker runs it: on, then every application waiting is decided. */
  reviewApplications(): Promise<{ traderId: string; outcome: string; flags: readonly string[] }[]>;
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

export async function createHumanWorld(adminUrl: string, port: number): Promise<HumanWorld> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${HUMAN_DB} with (force)`);
  await admin.query(`create database ${HUMAN_DB}`);
  await admin.end();
  await rm(HUMAN_OTP_SINK, { force: true });

  const databaseUrl = withDatabase(adminUrl, HUMAN_DB);
  const pool = createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-e2e-human' });
  await migrate(pool);
  await installQueue(pool);
  const db = createDb(pool);
  const authDb = createDb(createPool({ connectionString: databaseUrl, applicationName: 'inrp2p-e2e-human-auth', int8: 'number' }));
  const seedOrigin = 'http://127.0.0.1';
  const operatorAuth = createOperatorAuth({ authDb, appDb: db, secret: OPERATOR_AUTH_SECRET, baseURL: seedOrigin, rateLimit: { enabled: false }, useSecureCookies: false });
  const clientAuth = createClientAuth({ authDb, appDb: db, secret: CLIENT_AUTH_SECRET, baseURL: seedOrigin, rateLimit: { enabled: false }, useSecureCookies: false, otpSender: { send: async () => {} } });
  const owner = await operator(operatorAuth, db, 'owner@inrp2p.test', ['OWNER']);
  const settler = await operator(operatorAuth, db, 'settlement@inrp2p.test', ['SETTLEMENT_OPERATOR']);
  const protector = e2eFieldProtector();

  // The exchange's own rails, on GasFree accounts (ADR 0022): each deal address pays its own network in USDT.
  const chain = new FakeChainVerifier();
  const signer = HdSigner.fromMnemonic(TEST_MNEMONIC);
  const custody = new HdWalletCustodyAdapter({ accountXpub: signer.accountXpub });
  await run(db, recordCustodyHdAccount(owner.actor, custody), owner.ref, 'custody.record_hd_account', {
    accountXpub: signer.accountXpub, feeWalletAddress: signer.feeWalletAddress, depositPoolAddress: encodeTronAddress(randomBytes(20)),
  });
  const net = new FakeTronNetwork(chain);
  const rails: OnchainDeps = {
    network: new TronSendNetwork([net.gateway('node-a'), net.gateway('node-b')]), signer, chain, clock: () => net.headTime,
    gasFree: new FakeGasFree(net),
    policy: { validitySeconds: 120, expiryMarginSeconds: 6, rebroadcastSeconds: 0, unresolvedAfterMinutes: 30 },
  };
  await runFeeRefresh(db, rails);
  await runGasFreeFeeRefresh(db, rails);
  await run(db, setNetworkFeePolicy(owner.actor), owner.ref, 'settings.network_fees', { resourceMode: 'GASFREE' as const, reason: 'deals run on GasFree accounts' });
  await run(db, publishTrxRate(owner.actor), owner.ref, 'network.publish_trx_rate', { usdtPerTrx: '0.300000', source: 'e2e', confirmLargeChange: true });
  const programme = await db.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await run(db, configureTraderProgram(owner.actor), owner.ref, 'trader_program.configure', { expectedVersion: programme.version, defaultRequiredReserve: '2000', reason: 'P2P escrow' });

  const sendUsdt = async (from: string, to: string, amount: string) => {
    const receipt = chain.add({ from, to, amountMinor: Money.parse(amount, 'USDT').minor });
    await run(db, submitTxForVerification(settler.actor, { chain }), settler.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
    await runTronConfirm(db, { chain, providers: [] });
  };

  // The trader: approved, its Security Reserve in, both sides on — it fills INRP2P's deals and runs no desk. (Its onboarding
  // in the browser — the application, the reserve's address and hash — is the client suite's.)
  const company = await run(db, createClient(owner.actor), owner.ref, 'client.create', { legalName: TRADER.legalName, displayName: TRADER.name, type: 'COMPANY' as const, typicalDirection: 'BUY_USDT' as const });
  await run(db, setClientExchangeAccess(owner.actor), owner.ref, 'client.set_exchange_access', { clientId: company.clientId, exchangeAccess: false, reason: 'a trader, not a client of the exchange' });
  const bank = await run(db, addBankAccount(owner.actor, protector), owner.ref, 'client_bank.add', {
    clientId: company.clientId, holderName: TRADER.legalName, bankName: TRADER.bank, ifsc: TRADER.ifsc, accountNumber: TRADER.account, railPreferences: ['IMPS', 'NEFT'] as const,
  });
  const traderWalletAddress = encodeTronAddress(randomBytes(20));
  const wallet = await run(db, addWallet(owner.actor), owner.ref, 'client_wallet.add', { clientId: company.clientId, network: 'TRON' as const, address: traderWalletAddress, purpose: 'BOTH' as const, label: 'Trading wallet' });
  const userId = await provisionClientUser(clientAuth, { email: TRADER.email, name: 'Arjun' });
  await sql`update auth_user set email_verified = true where id = ${userId}`.execute(db);
  const linked = await run(db, linkClientUser(owner.actor), owner.ref, 'client_user.link', { clientId: company.clientId, userId, role: 'CLIENT_ADMIN' as const });
  await run(db, setCanAcceptQuotes(owner.actor), owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  const session = await db.insertInto('auth_session')
    .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(), updated_at: new Date(), user_id: userId, surface: 'CLIENT' })
    .returning('id').executeTakeFirstOrThrow();
  await sql`insert into step_up_verification (user_id, session_id, method, verified_at) values (${userId}, ${session.id}, 'TOTP', statement_timestamp())`.execute(db);
  const actor: ClientActor = { kind: 'CLIENT', userId, sessionId: session.id };
  const ref = { type: 'USER' as const, id: userId, surface: 'CLIENT' as const, sessionId: session.id };
  await runClient(db, applyAsTrader(actor, { protector }), ref, 'trader.apply', {
    experience: 'BINANCE' as const, telegram: '@arjun_traders', confirmOwnership: true, offersBuy: true, offersSell: true,
    typicalInr: '1000000.00', dailyInr: '5000000.00', typicalUsdt: '10000.000000', dailyUsdt: '50000.000000', bankAccountId: bank.bankAccountId, walletId: wallet.walletId,
  });
  const traderId = (await db.selectFrom('trader_profile').select('id').where('client_id', '=', company.clientId).executeTakeFirstOrThrow()).id;
  // Production's programme (2026-11-03): a 2,000 USDT reserve, and the reserve's limits on — a new trader's deal is at most
  // twice it, its open deals four times (ADR 0024).
  await run(db, approveTrader(owner.actor), owner.ref, 'trader.approve', { traderId, requiredReserve: '2000' });
  // Its wallet holds USDT from elsewhere before the day: the reserve and the escrows it funds come out of it.
  chain.add({ from: encodeTronAddress(randomBytes(20)), to: traderWalletAddress, amountMinor: Money.parse('100000', 'USDT').minor });
  await sendUsdt(traderWalletAddress, (await sharedReserveAddress(db))!.address, '2000');
  const sides = [
    ['BUY_USDT', { capacity: '5000000.00', rate: TRADER.buys, minOrder: '1000.00', maxOrder: '2000000.00' }],
    ['SELL_USDT', { capacity: '50000.000000', rate: TRADER.sells, minOrder: '10.000000', maxOrder: '20000.000000' }],
  ] as const;
  for (const [side, cfg] of sides) {
    const block = await db.selectFrom('trader_block').select('version').where('trader_id', '=', traderId).where('side', '=', side).executeTakeFirstOrThrow();
    await runClient(db, updateBlock(actor), ref, 'trader.update_block', { side, expectedVersion: block.version, ...cfg, status: 'ACTIVE' as const });
  }
  await runClient(db, setAvailability(actor), ref, 'trader.set_availability', { available: true });
  await authDb.destroy();

  const ports = surfacePorts(port);
  const stopServer = await startDesk({
    port, databaseUrl, operatorAuthSecret: OPERATOR_AUTH_SECRET, clientAuthSecret: CLIENT_AUTH_SECRET, surfaces: ['desk', 'app', 'public'],
    fieldKeys: E2E_FIELD_KEYS, custodyProvider: custody.provider, custodyCapability: 'DERIVED', custodyXpub: signer.accountXpub,
    clientOtpSinkFile: HUMAN_OTP_SINK, label: 'e2e-human',
  });

  return {
    db, chain, traderWalletAddress, sendUsdt,
    deskUrl: deskBaseUrl(ports.desk),
    appUrl: deskBaseUrl(ports.app),
    operator: { email: owner.email, password: OPERATOR_PASSWORD, totpSecret: owner.totpSecret },
    async settle(tradeId) {
      for (let turn = 0; turn < 12; turn++) {
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
    async automaticPricesOn() {
      const r = (d: string) => Rate.parse(d, 'ROUTE').micro;
      await runMarketReferenceRefresh(db, async () => ({ bidMicro: r('101.00'), askMicro: r('102.00'), source: 'market: e2e books' }));
      await run(db, setPricingPolicy(owner.actor), owner.ref, 'pricing.set_policy', {
        expectedPolicyId: (await currentPricingPolicy(db)).id, autoQuote: true, rfq: true, reason: 'automatic prices and price requests on for the run',
      });
    },
    async reserveAddress() {
      return (await sharedReserveAddress(db))!.address;
    },
    async reviewApplications() {
      const program = await db.selectFrom('trader_program').select(['version', 'auto_review']).where('id', '=', 1).executeTakeFirstOrThrow();
      if (!program.auto_review) {
        await run(db, configureTraderProgram(owner.actor), owner.ref, 'trader_program.configure', { expectedVersion: program.version, autoReview: true, reason: 'the programme reviews by its rules' });
      }
      const out: { traderId: string; outcome: string; flags: readonly string[] }[] = [];
      for (const traderId of await applicationsUnderReview(db)) {
        const r = await executeCommand(db, { authorize: async () => {}, handle: (ctx) => autoReviewTraderInTx(ctx, traderId) }, {
          name: 'trader.auto_review', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { traderId }, idempotencyKey: randomUUID(), financial: true,
        });
        out.push({ traderId, outcome: r.result.outcome, flags: r.result.flags });
      }
      return out;
    },
    async stop() {
      await stopServer();
      await db.destroy();
    },
  };
}
