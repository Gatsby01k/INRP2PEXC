import { randomInt, randomUUID } from 'node:crypto';
import { parseTrx } from '@inrp2p/kernel';
import { FakeGasFree, type FakeTronGateway, FakeTronNetwork } from '@inrp2p/adapters/testing';
import { HdWalletCustodyAdapter, TronSendNetwork } from '@inrp2p/adapters';
import { HdSigner } from '@inrp2p/adapters/signer';
import { runAs } from '@inrp2p/identity/testing';
import { recordCustodyHdAccount } from '@inrp2p/treasury';
import { claimNetworkDeposit, publishTrxRate, setNetworkFeePolicy } from '@inrp2p/network';
import { type OnchainDeps, runAutopay, runFeeRefresh, runGasFreeFeeRefresh, runHoldClosing, runMonitor, runSender, runUnwindClosing } from '@inrp2p/onchain';
import { acceptOrder, assignRequest, confirmOrderPaymentReceived, orderDeliveryAddress, submitOrderPayment } from '@inrp2p/traders';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { claimIncomingFiat, confirmClientReceipt } from '@inrp2p/settlement';
import type { QuoteDeps } from '@inrp2p/quotes';
import { CLIENT_SENDER, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { type TradersWorld, type TraderSetup, configureProgram, confirmOnChain, createTradersWorld, liveTrader, sendUsdt, traderClient } from './traders-world.ts';

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
  /** ADR 0022: GasFree on the same fake network — its controller's views and its relayer. */
  readonly gasFree: FakeGasFree;
}

/**
 * A traders world running on the exchange's own rails (ADR 0017): deposit addresses derived from the HD account, a
 * TRON network the signer actually signs for (two independent providers), real chain fees, a TRX price, and the
 * budget wallet. Everything about money goes through the real commands and jobs. It fuels transfers by burning TRX
 * (`BURN`, ADR 0017) unless asked to deal on GasFree (`GASFREE`, ADR 0022): new deal addresses are GasFree accounts that pay their own network in USDT.
 */
export async function createRailsWorld(label: string, opts: { policy?: OnchainDeps['policy']; usdtPerTrx?: string; resourceMode?: 'BURN' | 'GASFREE' } = {}): Promise<RailsWorld> {
  const w = await createTradersWorld(label);
  await configureProgram(w, { reserve: '500' });
  const signer = HdSigner.fromMnemonic(TEST_MNEMONIC);
  const custody = new HdWalletCustodyAdapter({ accountXpub: signer.accountXpub });
  const pool = await w.app.selectFrom('treasury_wallet').select('address').where('role', '=', 'DEPOSIT_POOL').executeTakeFirstOrThrow();
  await runAs(w.app, recordCustodyHdAccount(w.finance.actor, custody), w.finance.ref, 'custody.record_hd_account', {
    accountXpub: signer.accountXpub, feeWalletAddress: signer.feeWalletAddress, depositPoolAddress: pool.address,
  });
  const net = new FakeTronNetwork(w.chain);
  const gateways = [net.gateway('node-a'), net.gateway('node-b')];
  const gasFree = new FakeGasFree(net);
  const rails: OnchainDeps = {
    network: new TronSendNetwork(gateways), signer, chain: w.chain, clock: () => net.headTime, gasFree,
    policy: { validitySeconds: 120, expiryMarginSeconds: 6, rebroadcastSeconds: 0, unresolvedAfterMinutes: 30, ...(opts.policy ?? {}) },
  };
  await runFeeRefresh(w.app, rails);
  await runAs(w.app, publishTrxRate(w.finance.actor), w.finance.ref, 'network.publish_trx_rate', { usdtPerTrx: opts.usdtPerTrx ?? '0.300000', source: 'test', confirmLargeChange: true });
  if (opts.resourceMode === 'GASFREE') {
    // As in production: GasFree's fees are read from its controller before a person switches deals to it.
    await runGasFreeFeeRefresh(w.app, rails);
    await runAs(w.app, setNetworkFeePolicy(w.owner.actor), w.owner.ref, 'settings.network_fees', { resourceMode: 'GASFREE', reason: 'this world deals on GasFree accounts' });
  }
  return {
    ...w, net, gateways, signer, custody, rails, gasFree,
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
export async function railsTrade(w: RailsWorld, trader: TraderSetup, input: { direction: 'SELL_USDT' | 'BUY_USDT'; amount: string; clientRate: string; plannedClientRate?: string }) {
  const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
    clientId: w.clientId, direction: input.direction, fixedSide: 'BASE' as const, amount: input.amount,
    ...(input.direction === 'SELL_USDT' ? { bankAccountId: w.bankAccountId } : { walletId: w.walletId }),
  });
  const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: input.plannedClientRate ?? null });
  await runAs(w.app, acceptOrder(trader.admin.actor), trader.admin.ref, 'trader_order.accept', { ref: assigned.ref });
  const order = await w.app.selectFrom('trader_order').select(['id', 'route_id']).where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
  const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: input.clientRate, validitySeconds: 300 });
  await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
  const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
  const obligation = await w.app.selectFrom('route_obligation').select('id').where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
  return { tradeId: accepted.tradeId, tradeRef: accepted.tradeRef, orderId: order.id, orderRef: assigned.ref, routeObligationId: obligation.id, quote };
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
  const unwound = await runUnwindClosing(w.app);
  const holds = await runHoldClosing(w.app);
  return { autopay, sender, monitor, unwound, holds };
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

/**
 * A deal on the rails to its end, whichever way it goes. A sale: the client's USDT into the escrow, the trader's rupees
 * to the client, who confirms them; the signer pays the trader. A purchase: the trader's USDT into the escrow, the
 * client's rupees to the trader, who confirms them; the signer pays the client.
 */
export async function completeDeal(w: RailsWorld, trader: TraderSetup, trade: { tradeId: string; tradeRef: string; orderRef: string }, opts: { utr?: string } = {}): Promise<{ utr: string }> {
  const direction = (await w.app.selectFrom('trade').select('direction').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).direction;
  const reference = opts.utr ?? String(randomInt(1e11, 1e12));
  if (direction === 'SELL_USDT') {
    await settleFirstLeg(w, trade.tradeId);
    const paid = await runAs(w.app, submitOrderPayment(trader.admin.actor), trader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: reference });
    const holder = (await w.app.selectFrom('bank_account').select('holder_name').where('id', '=', trader.bankAccountId).executeTakeFirstOrThrow()).holder_name;
    await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: trade.tradeRef, legRef: paid.settlementRef, senderName: holder });
  } else {
    const { address, amount } = await runAs(w.app, orderDeliveryAddress(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    await sendUsdt(w, trader.walletAddress, address, amount);
    await confirmOnChain(w);
    await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'IMPS' as const, utr: reference, fromBankAccountId: w.bankAccountId });
    await runAs(w.app, confirmOrderPaymentReceived(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName: CLIENT_SENDER });
  }
  await railsSettle(w, trade.tradeId);
  return { utr: reference };
}

export const idem = () => randomUUID();
