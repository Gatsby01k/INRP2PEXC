import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, formatTrx, parseTrx } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import { budgetFigures, currentNetworkCosts, networkAvailable, reservePerSendSun } from '@inrp2p/network';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { acceptOrder, assignRequest } from '@inrp2p/traders';
import {
  approveRefundSend, confirmPayout, createPayoutLeg, createRefundLeg, decideRestoreFenceLift, raiseChainSendCap, raiseRestoreFence, raiseTradeNetworkHold, recordLegEvidence, refundAndCancel,
  requestRestoreFenceLift, sendPayoutLeg, setNewBusiness, recordRouteSettlement,
} from '@inrp2p/settlement';
import { orderDeliveryAddress, releaseOrder, runTraderSweep } from '@inrp2p/traders';
import { runFeeRefresh, runSender } from '@inrp2p/onchain';
import { decideNetworkWithdrawal, requestNetworkWithdrawal } from '@inrp2p/network';
import { payoutsHeld } from '@inrp2p/trades';
import { deskTradeNetwork } from '@inrp2p/desk';
import { balanceOf, newUtr, observe, settleFirstLeg, seeOwnSender } from '../../packages/settlement/test/world.ts';
import { configureProgram, confirmOnChain, sendUsdt, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, depositTrx, railsSettle, railsTrade, railsTrader, railsTurn, traderPaysInr } from './rails-world.ts';

/**
 * USDT TRC20 on the exchange's own rails (ADR 0017), end to end with real signing: a deal address per trade derived
 * from the HD account, the price that covers the trader's reward and the network fee, the TRX budget the trader
 * prefunded, a top-up of the deal address, one signed USDT transfer straight to whoever is paid, the chain's answer
 * settling it, and the trader paid back for the TRX it fronted.
 */
let w: RailsWorld;
let inrTrader: Awaited<ReturnType<typeof railsTrader>>;
let usdtTrader: Awaited<ReturnType<typeof railsTrader>>;

const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const inr = (d: string) => Money.parse(d, 'INR').minor;
const sends = (tradeId: string) => w.app.selectFrom('chain_send').selectAll().where('trade_id', '=', tradeId).orderBy('created_at').execute();
const attemptsOf = (sendId: string) => w.app.selectFrom('chain_send_attempt').selectAll().where('send_id', '=', sendId).orderBy('seq').execute();
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow()).lifecycle_state;
const depositOf = (tradeId: string) => w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
  .select(['d.id', 'd.address', 'd.custody_reference', 'd.source']).where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow();

/** A client buying USDT through the USDT trader, its INR in and the trader's USDT final at the order's address. */
async function fundedBuy(amount = '1000', clientRate = '106.500000') {
  const trade = await railsTrade(w, usdtTrader, { direction: 'BUY_USDT', amount, clientRate });
  await settleFirstLeg(w, trade.tradeId);
  const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
  await sendUsdt(w, usdtTrader.walletAddress, address, amount);
  await confirmOnChain(w);
  return trade;
}

async function payInrFromCollection(tradeId: string, amount: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.collectionAccountId });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr('PO') });
  return confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: crypto.randomUUID() });
}

beforeAll(async () => {
  w = await createRailsWorld('rails');
  inrTrader = await railsTrader(w, 'INR Provider', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '2000');
  usdtTrader = await railsTrader(w, 'USDT Provider', { sell: { capacity: '500000', rate: '105.20', min: '10', max: '200000' } }, '2000');
});
afterAll(async () => w.close());

describe('the price says everything before the client commits', () => {
  it('counts the trader’s reward and the network fee, and refuses a quote that would not pay for them', async () => {
    // ₹0.50 a USDT over the trader’s rate on 1,000 USDT: ₹500 gross, less ₹104.70 reward, less ~18 TRX of network fee.
    const refused = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '104.200000' }).catch((e) => e);
    expect(refused).toMatchObject({ code: 'QUOTE_UNPROFITABLE' });
    // The dealer is told the client rate that would pay for everything (at most, for a client selling).
    expect(Number.parseFloat(refused.details.breakEvenClientRate)).toBeLessThan(104.2);
    expect(refused.details).toMatchObject({ reward: '104.70', minNetMargin: '0.01' });
    // Its offer is released for the next quote.
    const { releaseOrder } = await import('@inrp2p/traders');
    const live = await w.app.selectFrom('trader_order').select('id').where('status', '=', 'ACCEPTED').execute();
    for (const o of live) await runAs(w.app, releaseOrder(w.dealer.actor), w.dealer.ref, 'trader_order.release', { orderId: o.id, reason: 'quote refused as unprofitable' });
  });

  it('freezes the network fee, the reward and the net margin on the quote; the client’s amounts are exactly the quoted ones', async () => {
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '103.500000' });
    const fee = await w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', trade.quote.quoteId).executeTakeFirstOrThrow();
    expect(fee.reward_inr_minor).toBe(inr('104.70'));
    expect(fee.fee_inr_minor).toBeGreaterThan(inr('400'));
    expect(fee.net_margin_inr_minor).toBe(inr('1200') - fee.reward_inr_minor - fee.fee_inr_minor);
    expect(trade.quote.networkFeeInr).toBe(Money.ofMinor(fee.fee_inr_minor, 'INR').toDecimalString());
    const econ = await w.app.selectFrom('trade_economics').select(['quote_inr_minor', 'base_minor']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(econ).toEqual({ quote_inr_minor: inr('103500.00'), base_minor: usdt('1000') });
    // The deal address is derived from the HD account, never created by hand.
    const deposit = await depositOf(trade.tradeId);
    expect(deposit.source).toBe('DERIVED');
    expect(w.signer.addressOf(deposit.custody_reference)).toBe(deposit.address);
    // The trader's TRX holds the worst case of this trade: its transfer and the return of the client's USDT.
    const hold = await w.app.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.trader_id).toBe(inrTrader.traderId);
    expect(hold.sends).toBe(2);
    expect(hold.amount_sun).toBe(fee.reserve_sun);
  });
});

describe('a client sells USDT; the exchange pays the trader its USDT, signed and sent once', () => {
  it('runs end to end: deposit, the trader’s INR, a top-up, one USDT transfer straight to the trader, the client paid, the trader paid back', async () => {
    const fundsBefore = await budgetFigures(w.app, inrTrader.traderId);
    const traderUsdtBefore = w.chain.balanceOf(inrTrader.walletAddress);
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '103.500000' });
    const deposit = await depositOf(trade.tradeId);
    await settleFirstLeg(w, trade.tradeId);
    // Nothing goes to the trader before it paid (DVP).
    expect((await railsTurn(w)).autopay.routePaymentsPlanned).toBe(0);
    await traderPaysInr(w, inrTrader, trade.orderRef);

    const turns = await railsSettle(w, trade.tradeId);
    expect(turns).toBeLessThanOrEqual(4);
    const all = await sends(trade.tradeId);
    expect(all.map((s) => [s.purpose, s.status])).toEqual([['ROUTE_PAYMENT', 'CONFIRMED'], ['TOPUP', 'CONFIRMED']]);
    const payment = all.find((s) => s.purpose === 'ROUTE_PAYMENT')!;
    expect(payment.from_address).toBe(deposit.address);
    expect(payment.to_address).toBe(inrTrader.walletAddress);
    expect(payment.amount_minor).toBe(usdt('1000'));
    // One signed transaction for the payment, and the USDT is where it should be — no hop through another wallet.
    expect(await attemptsOf(payment.id)).toHaveLength(1);
    expect(w.chain.balanceOf(inrTrader.walletAddress) - traderUsdtBefore).toBe(usdt('1000'));
    expect(w.chain.balanceOf(deposit.address)).toBe(0n);
    const rs = await w.app.selectFrom('route_settlement').select(['status', 'chain_send_id', 'flow']).where('chain_send_id', '=', payment.id).executeTakeFirstOrThrow();
    expect(rs).toMatchObject({ status: 'CONFIRMED', flow: 'TO_ROUTE' });

    // The client is paid its INR by the desk, from the trader's INR.
    const paid = await payInrFromCollection(trade.tradeId, '103500.00');
    expect(paid.completed).toBe(true);
    expect((await runTraderSweep(w.app)).completed).toBeGreaterThanOrEqual(1);
    await railsTurn(w, { mine: false });

    // The trader fronted the TRX; it is paid back in INR at the quote's TRX price, with its reward.
    const hold = await w.app.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.status).toBe('CLOSED');
    expect(hold.spent_sun).toBeGreaterThan(0n);
    expect(hold.reimbursed_sun).toBe(hold.spent_sun);
    expect(hold.reimbursed_inr_minor).toBeGreaterThan(0n);
    const reimbursed = await w.app.selectFrom('ledger_journal').select('id').where('posting_key', '=', `network_fee:${trade.tradeId}:reimburse`).executeTakeFirst();
    expect(reimbursed).toBeDefined();
    const fundsAfter = await budgetFigures(w.app, inrTrader.traderId);
    expect(fundsBefore.balanceSun - fundsAfter.balanceSun).toBe(hold.spent_sun);
    expect(fundsAfter.heldSun).toBe(fundsBefore.heldSun);
    // The budget wallet on chain lost exactly what the budget's records say was spent.
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('a client buys USDT; the exchange pays the client from the trader’s USDT, signed and sent once', () => {
  it('pays the client straight from the order’s delivery address once its INR is confirmed and the trader’s USDT is final', async () => {
    const trade = await railsTrade(w, usdtTrader, { direction: 'BUY_USDT', amount: '500', clientRate: '107.000000' });
    await settleFirstLeg(w, trade.tradeId); // ₹53,500 into the payout account
    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    const delivery = await w.app.selectFrom('deposit_address').select(['source', 'custody_reference']).where('address', '=', address).executeTakeFirstOrThrow();
    expect(delivery.source).toBe('DERIVED');
    // Before the trader's USDT is final there is nothing to pay the client with.
    expect((await railsTurn(w)).autopay.payoutsPlanned).toBe(0);
    await sendUsdt(w, usdtTrader.walletAddress, address, '500');
    await confirmOnChain(w);

    await railsSettle(w, trade.tradeId);
    const all = await sends(trade.tradeId);
    expect(all.map((s) => [s.purpose, s.status])).toEqual([['CLIENT_PAYOUT', 'CONFIRMED'], ['TOPUP', 'CONFIRMED']]);
    const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
    expect(w.chain.balanceOf(client.address)).toBe(usdt('500'));
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    const leg = await w.app.selectFrom('settlement_leg').select(['status', 'confirmed_by', 'sent_by']).where('trade_id', '=', trade.tradeId).where('side', '=', 'EXCHANGE_TO_CLIENT').executeTakeFirstOrThrow();
    expect(leg.status).toBe('COMPLETED');
    expect(leg.confirmed_by).toMatch(/^SYSTEM:/);

    // The trader is paid its INR from the client's INR by the desk; the order completes, the budget hold closes.
    const toTrader = await runAs(w.app, recordRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'TO_ROUTE' as const, amount: '52600.00', rail: 'IMPS' as const, utr: utr('OUT'), inrAccountId: w.inrAccountId,
    });
    const { confirmRouteSettlement } = await import('@inrp2p/settlement');
    await seeOwnSender(w.app, w.finance, { routeSettlementId: toTrader.routeSettlementId });
    await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: toTrader.routeSettlementId });
    await runTraderSweep(w.app);
    await railsTurn(w, { mine: false });
    const hold = await w.app.selectFrom('network_budget_hold').select(['status', 'spent_sun', 'reimbursed_sun']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.status).toBe('CLOSED');
    expect(hold.reimbursed_sun).toBe(hold.spent_sun);
    expect(await balanceOf(w.app, `ASSET:INR_SETTLEMENT:${w.inrAccountId}`, 'INR', { tradeId: trade.tradeId })).toBe(inr('53500.00') - inr('52600.00'));
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('cancellation and refunds', () => {
  it('returns the client’s USDT when the trader never pays — its network cost borne by the trader, never the client', async () => {
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '300', clientRate: '102.000000' });
    await settleFirstLeg(w, trade.tradeId);
    const deposit = await depositOf(trade.tradeId);
    const source = await w.app.selectFrom('crypto_wallet').select('id').where('address', '=', w.clientSourceAddress).executeTakeFirstOrThrow();
    await observe(w, deposit.address);
    const refund = await runAs(w.app, createRefundLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'refund_leg.create', { tradeId: trade.tradeId, sourceDepositAddressId: deposit.id });
    // The person who created a refund never sends it.
    await expect(runAs(w.app, approveRefundSend(w.settlementOp.actor), w.settlementOp.ref, 'refund_leg.approve_send', { legId: refund.legId, bearer: 'TRADER' as const, toWalletId: source.id, reason: 'trader did not pay' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, approveRefundSend(w.finance.actor), w.finance.ref, 'refund_leg.approve_send', { legId: refund.legId, bearer: 'TRADER' as const, toWalletId: source.id, reason: 'the trader did not pay its INR' });
    await railsSettle(w, trade.tradeId);
    expect(w.chain.balanceOf(deposit.address)).toBe(0n);
    const legs = await w.app.selectFrom('settlement_leg').select(['side', 'status']).where('trade_id', '=', trade.tradeId).where('side', '=', 'REFUND_TO_CLIENT').execute();
    expect(legs).toEqual([{ side: 'REFUND_TO_CLIENT', status: 'COMPLETED' }]);
    const routePayments = (await sends(trade.tradeId)).filter((s) => s.purpose === 'ROUTE_PAYMENT');
    expect(routePayments).toEqual([]);
    const refundSend = (await sends(trade.tradeId)).find((s) => s.purpose === 'REFUND')!;
    expect(refundSend.bearer).toBe('TRADER');
    expect(refundSend.approved_by).toBe(w.finance.actor.userId);
    // The trade unwinds; what the return cost is the trader's (it never paid), so nothing is paid back to it.
    await runAs(w.app, refundAndCancel(w.owner.actor), w.owner.ref, 'trade.refund_and_cancel', { tradeId: trade.tradeId, reason: 'the trader did not pay' });
    await railsTurn(w, { mine: false });
    const hold = await w.app.selectFrom('network_budget_hold').select(['status', 'spent_sun', 'reimbursed_sun']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.status).toBe('CLOSED');
    expect(hold.spent_sun).toBeGreaterThan(0n);
    expect(hold.reimbursed_sun).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('holds what a refund costs from acceptance on, so a trader cannot spend it on other orders first', async () => {
    const before = await networkAvailable(w.app, inrTrader.traderId);
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '200', clientRate: '101.000000' });
    const hold = await w.app.selectFrom('network_budget_hold').select(['amount_sun', 'per_send_sun', 'sends']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.amount_sun).toBe(hold.per_send_sun * 2n);
    expect(before - (await networkAvailable(w.app, inrTrader.traderId))).toBe(hold.amount_sun);
  });
});

describe('without real cover, nothing is sent', () => {
  it('refuses to accept a trade its trader’s network deposit cannot cover', async () => {
    const poor = await railsTrader(w, 'Thin Deposit', { buy: { capacity: '50000000', rate: '104.90', min: '100', max: '20000000' } }, '20');
    // Routing passes it over: it could not pay for one more order's transfers.
    const request = await import('@inrp2p/quotes').then((q) => runAs(w.app, q.createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: w.bankAccountId,
    }));
    const { assignRequest } = await import('@inrp2p/traders');
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId });
    expect(assigned.traderRef).not.toBe((await w.app.selectFrom('trader_profile').select('ref').where('id', '=', poor.traderId).executeTakeFirstOrThrow()).ref);
    expect(formatTrx(await networkAvailable(w.app, poor.traderId))).toBe('20.000000');
  });

  it('blocks a top-up the budget wallet does not hold on chain, and goes on once it does', async () => {
    const trade = await fundedBuy();
    // The records say the trader's TRX is there; the chain says the budget wallet is nearly empty.
    const onChain = w.net.trxOf(w.budgetAddress);
    w.net.externalTrxTransfer({ from: w.budgetAddress, to: w.clientSourceAddress, amountSun: 0n + onChain - parseTrx('1') }); // drained by someone outside
    await railsTurn(w); // plans the payout and its top-up
    await railsTurn(w); // the top-up cannot be signed
    const topup = (await sends(trade.tradeId)).find((s) => s.purpose === 'TOPUP')!;
    expect(topup.status).toBe('BLOCKED');
    expect(topup.blocked_reason).toMatch(/holds 1\.000000 TRX on chain/);
    const caseRow = await w.app.selectFrom('exception_case').select(['type', 'status']).where('subject_id', '=', topup.id).executeTakeFirstOrThrow();
    expect(caseRow).toEqual({ type: 'NETWORK_BUDGET_SHORT', status: 'OPEN' });
    // Funded again on chain: the desk sends it on (or the signer retries it by itself a little later), and the client is paid.
    w.net.externalTrxTransfer({ from: w.clientSourceAddress, to: w.budgetAddress, amountSun: onChain });
    const { unblockChainSend } = await import('@inrp2p/settlement');
    await runAs(w.app, unblockChainSend(w.finance.actor), w.finance.ref, 'chain_send.unblock', { sendId: topup.id, reason: 'the budget wallet was topped up on chain' });
    await railsSettle(w, trade.tradeId, 10);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });
});

describe('exactly once, whatever happens', () => {
  it('a broadcast that times out after reaching the node is never signed again: the chain’s answer settles it', async () => {
    const trade = await fundedBuy();
    for (const g of w.gateways) g.timeoutAfterBroadcast = true;
    try {
      await railsSettle(w, trade.tradeId, 6);
    } finally {
      for (const g of w.gateways) g.timeoutAfterBroadcast = false;
    }
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    expect(payout.status).toBe('CONFIRMED');
    expect(await attemptsOf(payout.id)).toHaveLength(1);
  });

  it('a crash between signing and broadcasting broadcasts the same bytes on restart, and a lost transaction is re-signed only once it provably expired', async () => {
    const trade = await fundedBuy();
    // Up to the top-up being final: the payout is next.
    await railsTurn(w);
    await railsTurn(w);
    // The worker signs and dies before any broadcast reaches a node.
    for (const g of w.gateways) g.loseBroadcast = true;
    await runSender(w.app, w.rails);
    for (const g of w.gateways) g.loseBroadcast = false;
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    const [signed] = await attemptsOf(payout.id);
    expect(signed!.status).toBe('SIGNED');
    // A node now takes the same bytes — and then drops them: they are never included.
    w.net.swallowed.add(signed!.txid);
    await railsTurn(w);
    expect(w.net.received.filter((t) => t === signed!.txid).length).toBeGreaterThanOrEqual(1);
    // While it could still land, nothing else is signed — however often the jobs run.
    for (let i = 0; i < 3; i++) await railsTurn(w);
    expect(await attemptsOf(payout.id)).toHaveLength(1);
    // Past its expiration on every provider's solidified head it is proved dead, and only then signed again.
    w.net.advance(200_000);
    await railsSettle(w, trade.tradeId, 6);
    const attempts = await attemptsOf(payout.id);
    expect(attempts.map((a) => a.status)).toEqual(['EXPIRED', 'CONFIRMED']);
    expect(attempts[0]!.txid).toBe(signed!.txid);
    const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
    const leg = await w.app.selectFrom('settlement_leg').select('amount_minor').where('trade_id', '=', trade.tradeId).where('side', '=', 'EXCHANGE_TO_CLIENT').executeTakeFirstOrThrow();
    expect(leg.amount_minor).toBe(usdt('1000'));
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    void client;
  });

  it('a provider that contradicts the others leaves the send blocked: never settled, never re-signed, never cancellable', async () => {
    const trade = await fundedBuy();
    await railsTurn(w);
    await railsTurn(w);
    w.gateways[1]!.liar = true;
    try {
      await railsTurn(w);
      await railsTurn(w);
      const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
      expect(payout.status).toBe('SENDING');
      expect(await attemptsOf(payout.id)).toHaveLength(1);
      const { cancelChainSend } = await import('@inrp2p/settlement');
      await expect(runAs(w.app, cancelChainSend(w.finance.actor), w.finance.ref, 'chain_send.cancel', { sendId: payout.id, reason: 'stuck' })).rejects.toMatchObject({ code: 'CHAIN_SEND_IN_FLIGHT' });
    } finally {
      w.gateways[1]!.liar = false;
    }
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });

  it('a transaction that fails on chain moves nothing; the send is fuelled and signed again', async () => {
    const trade = await fundedBuy();
    await railsTurn(w);
    await railsTurn(w);
    await railsTurn(w, { mine: false }); // the payout signed, not yet included
    const before = [w.net.params.energyToHolder, w.net.params.energyToNewHolder] as const;
    // The contract got dearer between the estimate and the block.
    w.net.params.energyToHolder = 400_000n;
    w.net.params.energyToNewHolder = 400_000n;
    w.net.mine();
    await railsTurn(w, { mine: false });
    [w.net.params.energyToHolder, w.net.params.energyToNewHolder] = before;
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    const first = await attemptsOf(payout.id);
    expect(first[0]!.status).toBe('FAILED');
    expect(first[0]!.result).toBe('OUT_OF_ENERGY');
    await railsSettle(w, trade.tradeId, 8);
    const attempts = await attemptsOf(payout.id);
    expect(attempts.map((a) => a.status)).toEqual(['FAILED', 'CONFIRMED']);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });

  it('the database refuses a second transaction for a send while one may still land', async () => {
    const live = await w.app.selectFrom('chain_send_attempt').select(['send_id']).where('status', '=', 'CONFIRMED').executeTakeFirstOrThrow();
    await expect(sql`insert into chain_send_attempt (send_id, seq, txid, raw_data_hex, signature_hex, ref_block_num, expiration)
                     values (${live.send_id}, 99, ${'ab'.repeat(32)}, ${'0a'.repeat(20)}, ${'0'.repeat(130)}, 1, now())`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX104');
  });
});

describe('concurrent operations', () => {
  it('two workers signing at once make one transaction', async () => {
    const trade = await fundedBuy();
    await railsTurn(w);
    await railsTurn(w);
    await Promise.all([runSender(w.app, w.rails), runSender(w.app, w.rails), runSender(w.app, w.rails)]);
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    expect(await attemptsOf(payout.id)).toHaveLength(1);
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });

  it('two acceptances racing for a trader’s last TRX: one is accepted, the other refused', async () => {
    const lean = await railsTrader(w, 'Lean Deposit', { sell: { capacity: '500000', rate: '100.10', min: '10', max: '200000' } }, '0');
    const costs = await currentNetworkCosts(w.app);
    const need = reservePerSendSun(costs.snapshot, costs.policy);
    // One and a half orders' worth: enough for routing to offer it both, not for both trades to hold their transfer.
    await depositTrx(w, lean, formatTrx((need * 3n) / 2n));
    const quoteFor = async () => {
      const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', walletId: w.walletId });
      const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId });
      expect(assigned.traderRef).toBe((await w.app.selectFrom('trader_profile').select('ref').where('id', '=', lean.traderId).executeTakeFirstOrThrow()).ref);
      await runAs(w.app, acceptOrder(lean.admin.actor), lean.admin.ref, 'trader_order.accept', { ref: assigned.ref });
      const order = await w.app.selectFrom('trader_order').select('route_id').where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
      const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: '102.000000', validitySeconds: 300 });
      await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
      return quote.quoteId;
    };
    const [qa, qb] = [await quoteFor(), await quoteFor()];
    const results = await Promise.allSettled([qa, qb].map((quoteId) => runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.code ?? pgErrorCode(refused.reason)).toMatch(/NETWORK_BUDGET_INSUFFICIENT|IX108/);
    expect(await networkAvailable(w.app, lean.traderId)).toBeGreaterThanOrEqual(0n);
  });

});

/** What a USDT send has drawn on its trade's hold so far, and its cap. */
const drawn = async (sendId: string) => {
  const r = await sql<{ used: string; cap: string }>`
    select inrp2p_send_network_used(${sendId}::uuid)::text as used, network_cap_sun::text as cap from chain_send where id = ${sendId}`.execute(w.app);
  return { used: BigInt(r.rows[0]!.used), cap: BigInt(r.rows[0]!.cap) };
};
const holdOf = async (tradeId: string) => (await w.app.selectFrom('network_budget_hold').select('amount_sun').where('trade_id', '=', tradeId).executeTakeFirstOrThrow()).amount_sun;
const payoutOf = async (tradeId: string) => (await sends(tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT');
const raiseCap = (sendId: string, cap: string, who = w.finance) =>
  runAs(w.app, raiseChainSendCap(who.actor), who.ref, 'chain_send.raise_network_cap', { sendId, cap, reason: 'checked the chain: energy is dearer now, the platform carries it' });

describe('the reward a quote counted is the reward its order earns', () => {
  it('keeps the quote’s reward through a programme change before acceptance — the order, the ledger and the desk say one figure', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: w.bankAccountId,
    });
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId });
    await runAs(w.app, acceptOrder(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.accept', { ref: assigned.ref });
    const order = await w.app.selectFrom('trader_order').select(['id', 'route_id', 'inr_minor']).where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
    const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: '103.500000', validitySeconds: 300 });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
    const frozen = await w.app.selectFrom('quote_network_fee').select(['trader_order_id', 'reward_bps', 'reward_inr_minor']).where('quote_id', '=', quote.quoteId).executeTakeFirstOrThrow();
    expect(frozen).toEqual({ trader_order_id: order.id, reward_bps: 10, reward_inr_minor: (order.inr_minor * 10n) / 10_000n });

    // The programme changes between the quote and the client's acceptance.
    await configureProgram(w, { rewardBps: 50 });
    try {
      const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
      const started = await w.app.selectFrom('trader_order').select(['status', 'reward_bps', 'reward_inr_minor']).where('id', '=', order.id).executeTakeFirstOrThrow();
      expect(started).toEqual({ status: 'IN_PROGRESS', reward_bps: 10, reward_inr_minor: frozen.reward_inr_minor });
      const desk = await deskTradeNetwork(w.app, accepted.tradeId, { economics: true });
      expect(desk!.economics!.reward).toBe(Money.ofMinor(frozen.reward_inr_minor, 'INR').toDecimalString());

      // The trade runs to the end: what the ledger accrues to the trader is the same reward.
      await settleFirstLeg(w, accepted.tradeId);
      await traderPaysInr(w, inrTrader, assigned.ref);
      await railsSettle(w, accepted.tradeId);
      await payInrFromCollection(accepted.tradeId, '103500.00');
      await runTraderSweep(w.app);
      const accrued = await sql<{ amount: string }>`
        select e.amount_minor::text as amount from ledger_entry e join ledger_journal j on j.id = e.journal_id
         where j.posting_key = ${`trader_reward:${order.id}:accrue`} and e.direction = 'CR'`.execute(w.app);
      expect(accrued.rows.map((r) => BigInt(r.amount))).toEqual([frozen.reward_inr_minor]);
    } finally {
      await configureProgram(w, { rewardBps: 10 });
    }
  });

  it('the database refuses a quote that counts another reward than its order’s, or a trader’s route without its order (IX113)', async () => {
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: w.bankAccountId,
    });
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId });
    await runAs(w.app, acceptOrder(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.accept', { ref: assigned.ref });
    const order = await w.app.selectFrom('trader_order').select(['id', 'route_id', 'inr_minor']).where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
    const draft = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: '103.500000', validitySeconds: 300 });
    const row = await w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', draft.quoteId).executeTakeFirstOrThrow();
    const gross = row.net_margin_inr_minor + row.reward_inr_minor + row.fee_inr_minor;
    const insert = (o: { order: string | null; bps: number | null; reward: bigint }) => sql`
      insert into quote_network_fee (quote_id, funder_trader_id, snapshot_id, trx_rate_id, usdt_per_trx_micro, energy_price_sun, sends_priced, fee_sun, fee_inr_minor,
                                     trader_order_id, reward_bps, reward_inr_minor, net_margin_inr_minor, reserve_sends, reserve_sun, min_net_margin_inr_minor)
      values (${row.quote_id}, ${row.funder_trader_id}, ${row.snapshot_id}, ${row.trx_rate_id}, ${row.usdt_per_trx_micro}, ${row.energy_price_sun}, ${row.sends_priced},
              ${row.fee_sun}, ${row.fee_inr_minor}, ${o.order}, ${o.bps}, ${o.reward}, ${gross - o.reward - row.fee_inr_minor}, ${row.reserve_sends}, ${row.reserve_sun},
              ${row.min_net_margin_inr_minor})`.execute(w.app);
    await expect(insert({ order: order.id, bps: 50, reward: (order.inr_minor * 10n) / 10_000n })).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX113');
    await expect(insert({ order: null, bps: null, reward: 0n })).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX113');
    await runAs(w.app, releaseOrder(w.dealer.actor), w.dealer.ref, 'trader_order.release', { orderId: order.id, reason: 'the regression is done with it' });
  });
});

describe('after the database changed underneath, nothing leaves — TRX no more than USDT (FI-54)', () => {
  it('signs, plans and broadcasts nothing while the fence is up, and broadcasts the same bytes, once, after it is lifted', async () => {
    const trade = await fundedBuy();
    await railsTurn(w); // the payout is planned, and its top-up
    // The top-up is signed and the worker dies before a node takes it.
    for (const g of w.gateways) g.loseBroadcast = true;
    await runSender(w.app, w.rails);
    for (const g of w.gateways) g.loseBroadcast = false;
    const topup = (await sends(trade.tradeId)).find((s) => s.purpose === 'TOPUP')!;
    const [signed] = await attemptsOf(topup.id);
    expect(signed!.status).toBe('SIGNED');
    const seen = () => w.net.received.filter((t) => t === signed!.txid).length;
    const seenBefore = seen();

    await runAs(w.app, raiseRestoreFence(w.financeOp.actor), w.financeOp.ref, 'operations.raise_restore_fence', { reason: 'restored from the provider console in the test' });
    expect((await payoutsHeld(w.app)).held).toBe(true);
    // The worker restarts and runs its cycle again and again: the signed TRX transfer is not broadcast, nothing is signed.
    for (let i = 0; i < 3; i++) await railsTurn(w);
    expect(seen()).toBe(seenBefore);
    expect(await attemptsOf(topup.id)).toHaveLength(1);
    expect(await attemptsOf((await payoutOf(trade.tradeId))!.id)).toHaveLength(0);
    // The database says the same, whoever asks (IX100): no transaction signed, no TRX send planned.
    await expect(sql`insert into chain_send_attempt (send_id, seq, txid, raw_data_hex, signature_hex, ref_block_num, expiration)
                     values (${topup.id}, 2, ${'cd'.repeat(32)}, ${'0a'.repeat(20)}, ${'0'.repeat(130)}, 1, now())`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX100');
    const fee = await w.app.selectFrom('custody_hd_account').select('fee_wallet_path').executeTakeFirstOrThrow();
    await expect(sql`insert into chain_send (asset, purpose, trade_id, parent_send_id, from_address, from_path, to_address, amount_minor, funder_trader_id, bearer, status, needs_approval, requested_by)
                     values ('TRX', 'TOPUP', ${trade.tradeId}, ${topup.parent_send_id}, ${topup.from_address}, ${fee.fee_wallet_path}, ${topup.to_address}, 1000000,
                             ${topup.funder_trader_id}, 'CLIENT', 'PLANNED', false, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX100');
    // A trader's TRX withdrawal may be asked for, but not approved to leave.
    const asked = await runAs(w.app, requestNetworkWithdrawal(usdtTrader.admin.actor), usdtTrader.admin.ref, 'network_withdrawal.request', { amount: '5' });
    await expect(runAs(w.app, decideNetworkWithdrawal(w.finance.actor), w.finance.ref, 'network_withdrawal.decide', { withdrawalId: asked.withdrawalId, approve: true }))
      .rejects.toMatchObject({ code: 'PAYOUTS_HELD' });
    await runAs(w.app, decideNetworkWithdrawal(w.finance.actor), w.finance.ref, 'network_withdrawal.decide', { withdrawalId: asked.withdrawalId, approve: false, reason: 'after the reconciliation' });

    // One person records the reconciliation, another lifts the fence; new business is its own decision.
    const lift = await runAs(w.app, requestRestoreFenceLift(w.financeOp.actor), w.financeOp.ref, 'operations.request_restore_fence_lift', {
      reconciliation: 'Looked up every signed transaction on the chain: the budget wallet top-up is unseen and unexpired.',
    });
    await runAs(w.app, decideRestoreFenceLift(w.financeOp2.actor), w.financeOp2.ref, 'operations.approve_restore_fence_lift', { liftId: lift.lift!.id, approve: true, note: 'checked' });
    await runAs(w.app, setNewBusiness(w.financeOp.actor), w.financeOp.ref, 'settings.resume_new_business', { paused: false, reason: 'reconciled after the rails restore drill' });

    await railsSettle(w, trade.tradeId, 10);
    expect(seen()).toBeGreaterThan(seenBefore);
    const attempts = await attemptsOf(topup.id);
    expect(attempts.map((a) => [a.txid, a.status])).toEqual([[signed!.txid, 'CONFIRMED']]);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });
});

describe('a transfer never draws more TRX than was fixed for it', () => {
  it('blocks a transfer that dearer gas would take past its cap — the trader’s other TRX untouched — until a person raises it', async () => {
    const trade = await fundedBuy();
    const freeAfterAcceptance = await networkAvailable(w.app, usdtTrader.traderId);
    const heldBefore = await holdOf(trade.tradeId);
    w.net.params.energyPriceSun = 400n;
    await runFeeRefresh(w.app, w.rails);
    try {
      await railsTurn(w);
      const payout = (await payoutOf(trade.tradeId))!;
      expect(payout.status).toBe('BLOCKED');
      expect(payout.blocked_reason).toMatch(/may draw .* TRX in all/);
      expect((await sends(trade.tradeId)).filter((s) => s.purpose === 'TOPUP')).toEqual([]);
      const caseRow = await w.app.selectFrom('exception_case').select(['type', 'status']).where('subject_id', '=', payout.id).executeTakeFirstOrThrow();
      expect(caseRow).toEqual({ type: 'NETWORK_BUDGET_SHORT', status: 'OPEN' });
      // Retrying by itself changes nothing: the cap is the cap.
      await runAs(w.app, (await import('@inrp2p/settlement')).unblockChainSend(w.finance.actor), w.finance.ref, 'chain_send.unblock', { sendId: payout.id, reason: 'try again' });
      await railsTurn(w);
      expect((await payoutOf(trade.tradeId))!.status).toBe('BLOCKED');
      expect(await networkAvailable(w.app, usdtTrader.traderId)).toBe(freeAfterAcceptance);
      expect(await holdOf(trade.tradeId)).toBe(heldBefore);

      // Only a person who may manage the network raises it, upward only, with a reason; the hold rises with it.
      await expect(raiseCap(payout.id, '80', w.dealer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(raiseCap(payout.id, '1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      const raised = await raiseCap(payout.id, '80');
      expect(raised.status).toBe('PLANNED');
      expect(await holdOf(trade.tradeId)).toBe(parseTrx('80'));
      expect(freeAfterAcceptance - (await networkAvailable(w.app, usdtTrader.traderId))).toBe(parseTrx('80') - heldBefore);
      await railsSettle(w, trade.tradeId, 8);
      expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
      const { used, cap } = await drawn(payout.id);
      expect(cap).toBe(parseTrx('80'));
      expect(used).toBeLessThanOrEqual(cap);
    } finally {
      w.net.params.energyPriceSun = 100n;
      await runFeeRefresh(w.app, w.rails);
    }
  });

  it('retries burn their own cap: once the next top-up would pass it, the transfer waits for a person instead of drawing more', async () => {
    const trade = await fundedBuy();
    const freeAfterAcceptance = await networkAvailable(w.app, usdtTrader.traderId);
    // Every block the chain charges more energy than it estimated: each signed attempt fails OUT_OF_ENERGY.
    const failingBlock = () => {
      const before = [w.net.params.energyToHolder, w.net.params.energyToNewHolder] as const;
      w.net.params.energyToHolder = 400_000n;
      w.net.params.energyToNewHolder = 400_000n;
      w.net.mine();
      [w.net.params.energyToHolder, w.net.params.energyToNewHolder] = before;
    };
    for (let i = 0; i < 16 && (await payoutOf(trade.tradeId))?.status !== 'BLOCKED'; i++) {
      await railsTurn(w, { mine: false });
      failingBlock();
    }
    const payout = (await payoutOf(trade.tradeId))!;
    expect(payout.status).toBe('BLOCKED');
    expect(payout.blocked_reason).toMatch(/may draw .* TRX in all/);
    const failed = (await attemptsOf(payout.id)).filter((a) => a.status === 'FAILED');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.length).toBeLessThan(3);
    const { used, cap } = await drawn(payout.id);
    expect(used).toBeLessThanOrEqual(cap);
    // Nothing beyond the trade's hold: the trader's free TRX is what it was right after acceptance.
    expect(await networkAvailable(w.app, usdtTrader.traderId)).toBe(freeAfterAcceptance);

    await raiseCap(payout.id, formatTrx(cap + parseTrx('20')));
    await railsSettle(w, trade.tradeId, 8);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect((await attemptsOf(payout.id)).filter((a) => a.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('a second payout the quote never priced waits for room — a case on the desk — until a person raises the trade’s hold', async () => {
    const trade = await railsTrade(w, usdtTrader, { direction: 'BUY_USDT', amount: '1000', clientRate: '106.500000' });
    await settleFirstLeg(w, trade.tradeId);
    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    // The trader delivers in two parts: the first is paid on as it arrives.
    await sendUsdt(w, usdtTrader.walletAddress, address, '400');
    await confirmOnChain(w);
    await railsSettle(w, trade.tradeId);
    expect((await sends(trade.tradeId)).filter((s) => s.purpose === 'CLIENT_PAYOUT').map((s) => s.status)).toEqual(['CONFIRMED']);
    const freeBefore = await networkAvailable(w.app, usdtTrader.traderId);
    await sendUsdt(w, usdtTrader.walletAddress, address, '600');
    await confirmOnChain(w);
    // The second transfer does not fit in what the trade holds: it is not planned, and the desk is told.
    const turn = await railsTurn(w);
    expect(turn.autopay.skipped).toEqual([expect.objectContaining({ tradeId: trade.tradeId, code: 'NETWORK_BUDGET_INSUFFICIENT' })]);
    expect((await sends(trade.tradeId)).filter((s) => s.purpose === 'CLIENT_PAYOUT')).toHaveLength(1);
    const caseRow = await w.app.selectFrom('exception_case').select(['type', 'severity', 'status']).where('subject_id', '=', trade.tradeId).where('type', '=', 'NETWORK_BUDGET_SHORT').executeTakeFirstOrThrow();
    expect(caseRow).toEqual({ type: 'NETWORK_BUDGET_SHORT', severity: 'WARNING', status: 'OPEN' });
    expect(await networkAvailable(w.app, usdtTrader.traderId)).toBe(freeBefore);

    // A person makes room, from the same trader's free TRX — upward only.
    const raise = (amount: string) => runAs(w.app, raiseTradeNetworkHold(w.finance.actor), w.finance.ref, 'network_budget_hold.raise', { tradeId: trade.tradeId, amount, reason: 'the trader delivered in two parts; the platform carries the second transfer' });
    await expect(raise('1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await raise('45');
    expect(await holdOf(trade.tradeId)).toBe(parseTrx('45'));
    await railsSettle(w, trade.tradeId);
    expect((await sends(trade.tradeId)).filter((s) => s.purpose === 'CLIENT_PAYOUT').map((s) => s.status)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });

  it('fits a trade’s caps in its hold — the client’s transfer at its priced fee, the return at one held transfer — and the database holds every line (IX114, IX115)', async () => {
    // A client selling: the payment to the trader is capped at the fee its price carried, leaving the return its own.
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    await traderPaysInr(w, inrTrader, trade.orderRef);
    await railsSettle(w, trade.tradeId);
    const payment = (await sends(trade.tradeId)).find((s) => s.purpose === 'ROUTE_PAYMENT')!;
    const fee = await w.app.selectFrom('quote_network_fee').select('fee_sun').where('quote_id', '=', trade.quote.quoteId).executeTakeFirstOrThrow();
    const hold = await w.app.selectFrom('network_budget_hold').select(['amount_sun', 'per_send_sun']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(payment.network_cap_sun).toBe(fee.fee_sun);
    expect(hold.amount_sun - (await drawn(payment.id)).used).toBeGreaterThanOrEqual(hold.per_send_sun);

    const budget = await w.app.selectFrom('custody_hd_account').select(['fee_wallet_address', 'fee_wallet_path']).executeTakeFirstOrThrow();
    // A top-up past its send's cap (IX114).
    const open = await fundedBuy();
    await railsTurn(w);
    const parent = (await payoutOf(open.tradeId))!;
    const used = (await drawn(parent.id)).used;
    await expect(sql`insert into chain_send (asset, purpose, trade_id, parent_send_id, from_address, from_path, to_address, amount_minor, funder_trader_id, bearer, status, needs_approval, requested_by)
                     values ('TRX', 'TOPUP', ${open.tradeId}, ${parent.id}, ${budget.fee_wallet_address}, ${budget.fee_wallet_path}, ${parent.from_address},
                             ${parent.network_cap_sun! - used + 1n}, ${parent.funder_trader_id}, 'CLIENT', 'PLANNED', false, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX114');
    // A cap that falls, or rises past the hold, and a hold that falls (IX115).
    await expect(sql`update chain_send set network_cap_sun = network_cap_sun - 1 where id = ${parent.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX115');
    await expect(sql`update chain_send set network_cap_sun = network_cap_sun + 1000000000 where id = ${parent.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX115');
    await expect(sql`update network_budget_hold set amount_sun = amount_sun - 1 where trade_id = ${open.tradeId}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX115');
    await railsSettle(w, open.tradeId);
    expect(await stateOf(open.tradeId)).toBe('COMPLETED');
  });
});
