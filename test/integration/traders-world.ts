import { randomBytes, randomUUID } from 'node:crypto';
import { encodeTronAddress, Money } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import { testFieldProtector } from '@inrp2p/adapters/testing';
import type { ClientActor } from '@inrp2p/identity';
import { createTestClientLogin, runAs } from '@inrp2p/identity/testing';
import { addBankAccount, addWallet, createClient, linkClientUser, setCanAcceptQuotes } from '@inrp2p/clients';
import { createInrAccount, createSettlementEntity } from '@inrp2p/inr-accounts';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { submitTxForVerification } from '@inrp2p/settlement';
import { runTronConfirm } from '@inrp2p/scanner';
import {
  type ApplyPayload, type TraderDeps, acceptOrder, applyAsTrader, approveTrader, assignRequest, configureTraderProgram, setAvailability, traderReserveAddress, updateBlock,
} from '@inrp2p/traders';
import { createWorld, type World } from '../../packages/settlement/test/world.ts';

export interface TraderPerson {
  readonly userId: string;
  readonly actor: ClientActor;
  readonly ref: { type: 'USER'; id: string; surface: 'CLIENT'; sessionId: string };
}

export interface TraderSetup {
  readonly clientId: string;
  readonly bankAccountId: string;
  readonly walletId: string;
  readonly walletAddress: string;
  readonly admin: TraderPerson;
  readonly member: TraderPerson;
}

export interface TradersWorld extends World {
  readonly traderDeps: TraderDeps;
  readonly hotAddress: string;
  /** The account traders pay INR into, sealed with the same protector the trader views open it with. */
  readonly collectionAccountId: string;
}

export async function createTradersWorld(label: string): Promise<TradersWorld> {
  const w = await createWorld(label, { depositPoolSize: 60 });
  const hot = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
  const entity = await runAs(w.app, createSettlementEntity(w.finance.actor), w.finance.ref, 'settlement_entity.create', { legalName: 'INRP2P Collections Private Limited', shortName: `COLL-${randomUUID().slice(0, 6)}` });
  const collection = await runAs(w.app, createInrAccount(w.finance.actor, w.deps.protector), w.finance.ref, 'inr_account.create', {
    entityId: entity.entityId, label: 'Trader collections', bankName: 'Axis Bank', ifsc: 'UTIB0000456', accountNumber: '918020045510099',
    rails: ['IMPS', 'NEFT', 'RTGS'] as const, direction: 'COLLECTION' as const, defaultDailyCapacity: '0.00',
  });
  return { ...w, traderDeps: { custody: w.deps.custody, protector: w.deps.protector, chain: w.chain }, hotAddress: hot.address, collectionAccountId: collection.accountId };
}

async function person(w: World, clientId: string, opts: { admin: boolean; canCommit: boolean }): Promise<TraderPerson> {
  const login = await createTestClientLogin(w.t.owner, { emailVerified: true, stepUp: 'fresh' });
  const linked = await runAs(w.app, linkClientUser(w.owner.actor), w.owner.ref, 'client_user.link', { clientId, userId: login.userId, role: opts.admin ? ('CLIENT_ADMIN' as const) : ('CLIENT_TRADER' as const) });
  if (opts.canCommit) await runAs(w.app, setCanAcceptQuotes(w.owner.actor), w.owner.ref, 'client_user.set_accept_quotes', { clientUserId: linked.clientUserId, canAcceptQuotes: true });
  return { userId: login.userId, actor: { kind: 'CLIENT', userId: login.userId, sessionId: login.sessionId }, ref: login.ref as TraderPerson['ref'] };
}

/** A client that will become a trader: its own bank account and a send-and-receive wallet, an admin and a member. */
export async function traderClient(w: World, name: string, walletPurpose: 'BOTH' | 'DESTINATION' = 'BOTH'): Promise<TraderSetup> {
  const client = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: `${name} LLP`, displayName: name, type: 'COMPANY' as const, typicalDirection: 'BUY_USDT' as const });
  const bank = await runAs(w.app, addBankAccount(w.owner.actor, testFieldProtector()), w.owner.ref, 'client_bank.add', {
    clientId: client.clientId, holderName: `${name} LLP`, bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK0000123', accountNumber: String(700000000000 + Math.floor(Math.random() * 1e9)), railPreferences: ['IMPS'] as const,
  });
  const walletAddress = encodeTronAddress(randomBytes(20));
  const wallet = await runAs(w.app, addWallet(w.owner.actor), w.owner.ref, 'client_wallet.add', { clientId: client.clientId, network: 'TRON' as const, address: walletAddress, purpose: walletPurpose, label: `${name} wallet` });
  return {
    clientId: client.clientId,
    bankAccountId: bank.bankAccountId,
    walletId: wallet.walletId,
    walletAddress,
    admin: await person(w, client.clientId, { admin: true, canCommit: true }),
    member: await person(w, client.clientId, { admin: false, canCommit: false }),
  };
}

export async function configureProgram(w: TradersWorld, input: { reserve?: string | null; rewardBps?: number | null; collection?: boolean }): Promise<void> {
  const current = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', {
    expectedVersion: current.version,
    ...(input.reserve !== undefined ? { defaultRequiredReserve: input.reserve } : {}),
    ...(input.rewardBps !== undefined ? { rewardBps: input.rewardBps } : {}),
    ...(input.collection ? { collectionAccountId: w.collectionAccountId } : {}),
    reason: 'test programme',
  });
}

export async function traderIdOf(db: Db, clientId: string): Promise<string> {
  return (await db.selectFrom('trader_profile').select('id').where('client_id', '=', clientId).executeTakeFirstOrThrow()).id;
}

/** Scanner confirmation over whatever the fake chain now says (only the verifier is used by this job). */
export function confirmOnChain(w: TradersWorld) {
  return runTronConfirm(w.app, { chain: w.chain, provider: undefined as never });
}

/** USDT from `from` to `to`, detected through the operator's tx-hash submission (same path as the scanner). */
export async function sendUsdt(w: TradersWorld, from: string, to: string, amount: string) {
  const receipt = w.chain.add({ from, to, amountMinor: Money.parse(amount, 'USDT').minor });
  const detected = await runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
  return { receipt, detected };
}

/**
 * `trader.apply` with the details every application carries (a contact, P2P experience, the ownership confirmation,
 * and a daily capacity no lower than the typical order) filled in, so a test states only what it is about.
 */
export function applyAs(w: TradersWorld, who: TraderPerson, p: Partial<ApplyPayload> & Pick<ApplyPayload, 'offersBuy' | 'offersSell'>) {
  const payload: ApplyPayload = {
    experience: 'BINANCE', telegram: '@desk_tester', confirmOwnership: true,
    ...(p.typicalInr ? { dailyInr: p.typicalInr } : {}),
    ...(p.typicalUsdt ? { dailyUsdt: p.typicalUsdt } : {}),
    ...p,
  };
  return runAs(w.app, applyAsTrader(who.actor, w.traderDeps), who.ref, 'trader.apply', payload);
}

/** Apply → approve → fund the reserve → set blocks → switch on. */
export async function liveTrader(
  w: TradersWorld,
  setup: TraderSetup,
  opts: { buy?: { capacity: string; rate: string; min: string; max: string }; sell?: { capacity: string; rate: string; min: string; max: string }; reserve?: string } = {},
): Promise<{ traderId: string; buyRouteId: string | null; sellRouteId: string | null }> {
  await applyAs(w, setup.admin, {
    offersBuy: Boolean(opts.buy), offersSell: Boolean(opts.sell), typicalInr: opts.buy ? opts.buy.capacity : null, typicalUsdt: opts.sell ? opts.sell.capacity : null,
    bankAccountId: setup.bankAccountId, walletId: setup.walletId,
  });
  const traderId = await traderIdOf(w.app, setup.clientId);
  await runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId, requiredReserve: '500' });
  const { address } = await runAs(w.app, traderReserveAddress(setup.admin.actor, w.traderDeps), setup.admin.ref, 'trader.reserve_address', {});
  await sendUsdt(w, setup.walletAddress, address, opts.reserve ?? '500');
  await confirmOnChain(w);
  for (const [side, cfg] of [['BUY_USDT', opts.buy], ['SELL_USDT', opts.sell]] as const) {
    if (!cfg) continue;
    const block = await w.app.selectFrom('trader_block').select('version').where('trader_id', '=', traderId).where('side', '=', side).executeTakeFirstOrThrow();
    await runAs(w.app, updateBlock(setup.admin.actor), setup.admin.ref, 'trader.update_block', { side, expectedVersion: block.version, capacity: cfg.capacity, rate: cfg.rate, minOrder: cfg.min, maxOrder: cfg.max, status: 'ACTIVE' as const });
  }
  await runAs(w.app, setAvailability(setup.admin.actor), setup.admin.ref, 'trader.set_availability', { available: true });
  const routes = await w.app.selectFrom('liquidity_route').select(['id', 'direction']).where('trader_id', '=', traderId).execute();
  return {
    traderId,
    buyRouteId: routes.find((r) => r.direction === 'SELL_USDT')?.id ?? null,
    sellRouteId: routes.find((r) => r.direction === 'BUY_USDT')?.id ?? null,
  };
}

/** A client request in the given direction, fixed in USDT. */
export async function clientRequest(w: World, direction: 'SELL_USDT' | 'BUY_USDT', amount: string): Promise<string> {
  const r = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction, fixedSide: 'BASE' as const, amount, ...(direction === 'SELL_USDT' ? { bankAccountId: w.bankAccountId } : { walletId: w.walletId }),
  });
  return r.requestId;
}

/** Desk routes the request, the trader accepts, the desk quotes on the trader route, the client accepts. */
export async function tradeThroughTrader(w: TradersWorld, setup: TraderSetup, input: { requestId: string; clientRate: string }): Promise<{ orderId: string; orderRef: string; tradeId: string; routeObligationId: string; quoteId: string }> {
  const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: input.requestId });
  await runAs(w.app, acceptOrder(setup.admin.actor), setup.admin.ref, 'trader_order.accept', { ref: assigned.ref });
  const order = await w.app.selectFrom('trader_order').select(['route_id']).where('id', '=', assigned.orderId).executeTakeFirstOrThrow();
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: input.requestId, routeId: order.route_id, clientRate: input.clientRate, validitySeconds: 300 });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.deps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
  const obligation = await w.app.selectFrom('route_obligation').select('id').where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
  return { orderId: assigned.orderId, orderRef: assigned.ref, tradeId: accepted.tradeId, routeObligationId: obligation.id, quoteId: quote.quoteId };
}

export const utr = (prefix = 'TRD') => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
