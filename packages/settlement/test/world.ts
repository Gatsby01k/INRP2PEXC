import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import type { Db } from '@inrp2p/db';
import type { FakeChainVerifier } from '@inrp2p/adapters/testing';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import { createTestOperator } from '@inrp2p/identity/testing';
import { addWallet } from '@inrp2p/clients';
import { executeCommand } from '@inrp2p/commands';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { type SettlementDeps, claimIncomingFiat, confirmClientLegInTx, submitTxForVerification } from '@inrp2p/settlement';
import { confirmOrderPaymentReceived, orderDeliveryAddress } from '@inrp2p/traders';
import { runTronConfirm } from '@inrp2p/scanner';
import { type ScenarioTrader, type Scenario, createScenario, routeToTrader, scenarioTrader } from '../../quotes/test/scenario.ts';

export type { Scenario };

export interface World extends Scenario {
  readonly chain: FakeChainVerifier;
  readonly settlementDeps: SettlementDeps;
  readonly settlementOp: TestOperator;
  readonly settlementOp2: TestOperator;
  readonly financeOp: TestOperator;
  readonly financeOp2: TestOperator;
  readonly treasuryWalletId: string;
  readonly clientSourceAddress: string;
}

/** A full Phase 4 world: the Phase 3 scenario plus the settlement desk's people and the client's sending wallet. */
export async function createWorld(label: string, opts: { custody?: 'POOL' | 'UNSUPPORTED'; depositPoolSize?: number } = {}): Promise<World> {
  const s = await createScenario(label, { depositPoolSize: opts.depositPoolSize ?? 60, ...(opts.custody ? { custody: opts.custody } : {}) });
  const chain = s.chain;
  const settlementOp = await createTestOperator(s.t.owner, ['SETTLEMENT_OPERATOR']);
  const settlementOp2 = await createTestOperator(s.t.owner, ['SETTLEMENT_OPERATOR']);
  const financeOp = await createTestOperator(s.t.owner, ['FINANCE']);
  const financeOp2 = await createTestOperator(s.t.owner, ['FINANCE']);

  const hot = await s.t.owner.selectFrom('treasury_wallet').select('id').where('role', '=', 'HOT').executeTakeFirstOrThrow();
  const clientSourceAddress = encodeTronAddress(randomBytes(20));
  await runAs(s.app, addWallet(s.owner.actor), s.owner.ref, 'client_wallet.add', {
    clientId: s.clientId, network: 'TRON' as const, address: clientSourceAddress, purpose: 'SOURCE' as const, label: 'Client source wallet',
  });

  return {
    ...s,
    chain,
    settlementDeps: { chain },
    settlementOp,
    settlementOp2,
    financeOp,
    financeOp2,
    treasuryWalletId: hot.id,
    clientSourceAddress,
  };
}

export interface OpenTradeOptions {
  readonly direction?: 'SELL_USDT' | 'BUY_USDT';
  /** A SELL trade's payout account, when not the world's own. */
  readonly bankAccountId?: string;
  readonly baseUsdt?: string;
  readonly clientRate?: string;
}

/**
 * A deal with the world's trader, accepted and open (T1), ready for its first move: the request, the trader's acceptance
 * at the rate the desk quotes, the quote, the client's acceptance. The trader buys at 103.00 and sells at 105.00.
 */
export async function openTrade(w: World, opts: OpenTradeOptions = {}): Promise<{ tradeId: string; tradeRef: string; quoteId: string; routeObligationId: string; orderId: string; orderRef: string }> {
  const direction = opts.direction ?? 'SELL_USDT';
  const clientRate = opts.clientRate ?? (direction === 'SELL_USDT' ? '102.000000' : '106.000000');
  const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction, fixedSide: 'BASE' as const, amount: opts.baseUsdt ?? '100000',
    ...(direction === 'SELL_USDT' ? { bankAccountId: opts.bankAccountId ?? w.bankAccountId } : { walletId: w.walletId }),
  });
  const routed = await routeToTrader(w, request.requestId, clientRate);
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: routed.routeId, clientRate, validitySeconds: 300 });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.deps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
  const obligation = await w.app.selectFrom('route_obligation').select('id').where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
  return { tradeId: accepted.tradeId, tradeRef: accepted.tradeRef, quoteId: quote.quoteId, routeObligationId: obligation.id, orderId: routed.orderId, orderRef: routed.orderRef };
}

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };

/** The client's USDT reaching a SELL deal's escrow, seen on chain and, unless `final: false`, final (T2 + T4). */
export async function settleFirstLeg(w: World, tradeId: string, opts: { amountUsdt?: string; from?: string; db?: Db; final?: boolean } = {}): Promise<{ legId: string; transferId: string }> {
  const db = opts.db ?? w.app;
  const assignment = await w.app
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.address', 'a.expected_amount_minor'])
    .where('a.trade_id', '=', tradeId)
    .executeTakeFirstOrThrow();
  const amount = opts.amountUsdt ? Money.parse(opts.amountUsdt, 'USDT') : Money.ofMinor(assignment.expected_amount_minor!, 'USDT');
  const receipt = w.chain.add({ from: opts.from ?? w.clientSourceAddress, to: assignment.address, amountMinor: amount.minor });
  const submitted = await runAs(db, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
  expect(submitted.legId).not.toBeNull();
  if (opts.final ?? true) await confirmLeg(w, submitted.legId!, { db });
  return { legId: submitted.legId!, transferId: submitted.transferId };
}

/** What the scanner does once the chain has made a client's USDT final (T4). */
export async function confirmLeg(w: World, legId: string, opts: { db?: Db } = {}): Promise<void> {
  await executeCommand(opts.db ?? w.app, { authorize: async () => {}, handle: (ctx) => confirmClientLegInTx(ctx, w.settlementDeps, legId) }, { name: 'settlement.confirm_incoming', actor: SYSTEM, payload: { legId }, idempotencyKey: randomUUID(), financial: true });
}

/** A BUY deal's trader funding the escrow: its USDT at the order's own address, final on chain (ADR 0019). */
export async function fundEscrow(w: World, opened: { orderRef: string }, opts: { amount?: string } = {}): Promise<{ address: string }> {
  const trader = await scenarioTrader(w);
  const issued = await runAs(w.app, orderDeliveryAddress(trader.admin.actor, { custody: w.deps.custody }), trader.admin.ref, 'trader_order.delivery_address', { ref: opened.orderRef });
  const receipt = w.chain.add({ from: trader.walletAddress, to: issued.address, amountMinor: Money.parse(opts.amount ?? issued.amount, 'USDT').minor });
  await runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: receipt.txHash, logIndex: receipt.logIndex });
  await runTronConfirm(w.app, { chain: w.chain, providers: [] });
  return { address: issued.address };
}

/** A BUY deal's rupees: the escrow funded, the client says it paid its trader, and the trader sees them from the client's own account. */
export async function clientPaysTrader(w: World, opened: { tradeRef: string; orderRef: string }, opts: { fundEscrow?: boolean; senderName?: string } = {}): Promise<{ legRef: string; transferId: string }> {
  const trader: ScenarioTrader = await scenarioTrader(w);
  if (opts.fundEscrow ?? true) await fundEscrow(w, opened);
  const claim = await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: opened.tradeRef, rail: 'IMPS' as const, utr: String(100000000000 + Math.floor(Math.random() * 899999999999)), fromBankAccountId: w.bankAccountId });
  await runAs(w.app, confirmOrderPaymentReceived(trader.admin.actor, { chain: w.chain }), trader.admin.ref, 'trader_order.confirm_received', { ref: opened.orderRef, senderName: opts.senderName ?? CLIENT_SENDER });
  return claim;
}

/**
 * Records what the fake chain shows at `address` as a custody balance observation (B2), as the worker's
 * `custody_observe` job or an operator's refresh would: two independent sources agreeing on the solidified balance.
 */
export async function observe(w: World, address: string, opts: { db?: Db } = {}): Promise<void> {
  const { executeCommand } = await import('@inrp2p/commands');
  const { recordBalanceObservation } = await import('@inrp2p/treasury');
  const sources = w.chain.balanceSources();
  const readings = await Promise.all(sources.map((s) => s.getSolidifiedBalance(address, w.chain.tokenContract)));
  await executeCommand(opts.db ?? w.app, {
    authorize: async () => {},
    handle: (ctx) => recordBalanceObservation(ctx, {
      address, tokenContract: w.chain.tokenContract, quality: 'AGREED', balanceMinor: readings[0]!.balanceMinor, solidifiedBlock: readings[0]!.solidifiedBlock,
      trxSun: readings[0]!.trxSun, providers: sources.map((s) => s.name), independentSources: sources.length,
    }),
  }, { name: 'custody.observe_balance', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { address }, financial: false });
}

/** The deposit address a trade's client USDT arrived at (where its client funds are, D-16). */
export async function clientDepositAddressOf(w: World, tradeId: string): Promise<{ id: string; address: string }> {
  const row = await w.app
    .selectFrom('deposit_assignment as a')
    .innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
    .select(['d.id', 'd.address'])
    .where('a.trade_id', '=', tradeId)
    .executeTakeFirstOrThrow();
  return row;
}

/** A SETTLEMENT_OPERATOR whose TOTP step-up is older than the freshness window. */
export async function createStaleSettlementOperator(w: World): Promise<TestOperator> {
  return createTestOperator(w.t.owner, ['SETTLEMENT_OPERATOR'], 'stale');
}

/** How the bank shows the scenario client's own account as a sender (ADR 0018, ADR 0019). */
export const CLIENT_SENDER = 'ACME PAY PVT LTD';

export const newUtr = (prefix = 'UTR') => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 14).toUpperCase()}`;

/** Ledger balance of an account code (DR − CR), optionally restricted to one route obligation. */
export async function balanceOf(db: Db, code: string, currency: 'INR' | 'USDT', opts: { routeObligationId?: string; tradeId?: string } = {}): Promise<bigint> {
  const r = await sql<{ net: string }>`
    select coalesce(sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end), 0)::text as net
    from ledger_entry e join ledger_account a on a.id = e.account_id
    where a.code like ${`${code}%`} and e.currency = ${currency}
      ${opts.routeObligationId ? sql`and e.route_obligation_id = ${opts.routeObligationId}` : sql``}
      ${opts.tradeId ? sql`and e.trade_id = ${opts.tradeId}` : sql``}`.execute(db);
  return BigInt(r.rows[0]!.net);
}

/** Every journal that carries a movement id, so tests can assert "exactly one journal per movement" (FI-27). */
export async function journalsFor(db: Db, movementId: string): Promise<string[]> {
  const r = await db.selectFrom('ledger_journal').select('posting_key').where('posting_key', 'like', `%${movementId}%`).execute();
  return r.map((x) => x.posting_key);
}
