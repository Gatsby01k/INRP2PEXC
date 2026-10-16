import { randomUUID } from 'node:crypto';
import { parseTrx } from '@inrp2p/kernel';
import { type FakeTronGateway, FakeTronNetwork } from '@inrp2p/adapters/testing';
import { HdWalletCustodyAdapter, TronSendNetwork } from '@inrp2p/adapters';
import { HdSigner } from '@inrp2p/adapters/signer';
import { runAs } from '@inrp2p/identity/testing';
import { recordCustodyHdAccount } from '@inrp2p/treasury';
import { claimNetworkDeposit, publishTrxRate } from '@inrp2p/network';
import { type OnchainDeps, runAutopay, runFeeRefresh, runHoldClosing, runMonitor, runSender } from '@inrp2p/onchain';
import { acceptOrder, assignRequest, submitOrderPayment } from '@inrp2p/traders';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { confirmRouteSettlement } from '@inrp2p/settlement';
import type { QuoteDeps } from '@inrp2p/quotes';
import { type TradersWorld, type TraderSetup, configureProgram, createTradersWorld, liveTrader, traderClient, utr } from './traders-world.ts';
import { seeOwnSender } from '../../packages/settlement/test/world.ts';

/** The BIP-39 test mnemonic: its addresses are TronWeb's vectors (packages/adapters/test/tron-tx.unit.test.ts). */
export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'; // secret-scan:allow — BIP-39's published test vector, never a wallet with money

export interface RailsWorld extends TradersWorld {
  readonly net: FakeTronNetwork;
  readonly gateways: readonly FakeTronGateway[];
  readonly signer: HdSigner;
  readonly custody: HdWalletCustodyAdapter;
  readonly rails: OnchainDeps;
  readonly railsDeps: QuoteDeps;
  readonly budgetAddress: string;
}

/**
 * A traders world running on the exchange's own rails (ADR 0017): deposit addresses derived from the HD account, a
 * TRON network the signer actually signs for (two independent providers), real chain fees, a TRX price, and the
 * budget wallet. Everything about money goes through the real commands and jobs.
 */
export async function createRailsWorld(label: string, opts: { policy?: OnchainDeps['policy']; usdtPerTrx?: string } = {}): Promise<RailsWorld> {
  const w = await createTradersWorld(label);
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true });
  const signer = HdSigner.fromMnemonic(TEST_MNEMONIC);
  const custody = new HdWalletCustodyAdapter({ accountXpub: signer.accountXpub });
  const pool = await w.app.selectFrom('treasury_wallet').select('address').where('role', '=', 'DEPOSIT_POOL').executeTakeFirstOrThrow();
  await runAs(w.app, recordCustodyHdAccount(w.finance.actor, custody), w.finance.ref, 'custody.record_hd_account', {
    accountXpub: signer.accountXpub, feeWalletAddress: signer.feeWalletAddress, depositPoolAddress: pool.address,
  });
  const net = new FakeTronNetwork(w.chain);
  const gateways = [net.gateway('node-a'), net.gateway('node-b')];
  const rails: OnchainDeps = {
    network: new TronSendNetwork(gateways), signer, chain: w.chain, clock: () => net.headTime,
    policy: { validitySeconds: 120, expiryMarginSeconds: 6, rebroadcastSeconds: 0, unresolvedAfterMinutes: 30, ...(opts.policy ?? {}) },
  };
  await runFeeRefresh(w.app, rails);
  await runAs(w.app, publishTrxRate(w.finance.actor), w.finance.ref, 'network.publish_trx_rate', { usdtPerTrx: opts.usdtPerTrx ?? '0.300000', source: 'test', confirmLargeChange: true });
  return {
    ...w, net, gateways, signer, custody, rails,
    railsDeps: { ...w.deps, custody },
    traderDeps: { ...w.traderDeps, custody },
    budgetAddress: signer.feeWalletAddress,
  };
}

/** A trader whose TRX network deposit arrived on chain from its registered wallet and was claimed by its hash. */
export async function railsTrader(w: RailsWorld, name: string, sides: Parameters<typeof liveTrader>[2], deposit = '1000'): Promise<TraderSetup & { traderId: string }> {
  const setup = await traderClient(w, name);
  const { traderId } = await liveTrader(w, setup, { ...sides, networkDeposit: null });
  if (deposit !== '0') await depositTrx(w, setup, deposit);
  return { ...setup, traderId };
}

export async function depositTrx(w: RailsWorld, setup: TraderSetup, amount: string): Promise<string> {
  const txid = w.net.externalTrxTransfer({ from: setup.walletAddress, to: w.budgetAddress, amountSun: parseTrx(amount) });
  const facts = await w.rails.network.trxTransfer(txid);
  if (facts.status !== 'FINAL') throw new Error(`deposit not final: ${facts.status}`);
  await runAs(w.app, claimNetworkDeposit(setup.admin.actor, facts.transfer), setup.admin.ref, 'network_deposit.claim', { txHash: txid });
  return txid;
}

/** Request → offer to the trader → trader accepts → desk quotes on its route → client accepts — on the rails. */
export async function railsTrade(w: RailsWorld, trader: TraderSetup, input: { direction: 'SELL_USDT' | 'BUY_USDT'; amount: string; clientRate: string }) {
  const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction: input.direction, fixedSide: 'BASE' as const, amount: input.amount,
    ...(input.direction === 'SELL_USDT' ? { bankAccountId: w.bankAccountId } : { walletId: w.walletId }),
  });
  const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId });
  await runAs(w.app, acceptOrder(trader.admin.actor), trader.admin.ref, 'trader_order.accept', { ref: assigned.ref });
  const order = await w.app.selectFrom('trader_order').select(['id', 'route_id']).where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: input.clientRate, validitySeconds: 300 });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
  const obligation = await w.app.selectFrom('route_obligation').select('id').where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
  return { tradeId: accepted.tradeId, orderId: order.id, orderRef: assigned.ref, routeObligationId: obligation.id, quote };
}

/** The INR trader's payment for its order: its own reference, confirmed by FINANCE against the bank. */
export async function traderPaysInr(w: RailsWorld, trader: TraderSetup, orderRef: string) {
  const claim = await runAs(w.app, submitOrderPayment(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.submit_payment', { ref: orderRef, rail: 'IMPS' as const, utr: utr() });
  const rs = await w.app.selectFrom('route_settlement').select('id').where('ref', '=', claim.settlementRef).executeTakeFirstOrThrow();
  await seeOwnSender(w.app, w.finance, { routeSettlementId: rs.id });
  await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: rs.id });
}

/**
 * One turn of the worker's rails jobs, then a block: what is due is planned, what can be signed is signed and
 * broadcast, the chain includes it, and what is final settles. Repeated until nothing moves.
 */
export async function railsTurn(w: RailsWorld, opts: { mine?: boolean } = {}) {
  const autopay = await runAutopay(w.app, w.rails);
  const sender = await runSender(w.app, w.rails);
  if (opts.mine ?? true) w.net.mine();
  const monitor = await runMonitor(w.app, w.rails);
  const holds = await runHoldClosing(w.app);
  return { autopay, sender, monitor, holds };
}

/** Turns until no send of the trade is open (or `max` turns). */
export async function railsSettle(w: RailsWorld, tradeId: string, max = 8): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await railsTurn(w);
    const open = await w.app.selectFrom('chain_send').select('id').where('trade_id', '=', tradeId).where('status', 'not in', ['CONFIRMED', 'CANCELLED']).execute();
    const due = await w.app.selectFrom('chain_send').select('id').where('trade_id', '=', tradeId).execute();
    if (open.length === 0 && due.length > 0) return i;
  }
  return max;
}

export const idem = () => randomUUID();
