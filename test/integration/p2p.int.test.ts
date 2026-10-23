import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, parseTrx } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import { budgetFigures } from '@inrp2p/network';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { answerClientDispute, claimIncomingFiat, confirmClientReceipt, decideP2pPayment, openClientDispute, p2pDeal, p2pDecisionView, p2pPayments, resolveException, runP2pDeadlines } from '@inrp2p/settlement';
import { answerOrderDispute, confirmOrderPaymentReceived, disputeOrderPayment, orderDeliveryAddress, runTraderSweep, submitOrderPayment } from '@inrp2p/traders';
import { CLIENT_SENDER, balanceOf, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { confirmOnChain, sendUsdt, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsSettle, railsTrade, railsTrader, railsTurn } from './rails-world.ts';

/**
 * P2P escrow (ADR 0019), end to end on the exchange's own rails: the rupees go once, straight between the client's and
 * the trader's own accounts; the USDT waits at the deal's address until the one who received the rupees says so, and
 * who sent them; the signer then pays out, and the exchange's margin — USDT — stays at the address. Each trader's own
 * network deposit pays the network of its deals and nothing is paid back (migration 0040): the platform has no TRX.
 */
let w: RailsWorld;
let inrTrader: Awaited<ReturnType<typeof railsTrader>>;
let usdtTrader: Awaited<ReturnType<typeof railsTrader>>;
let platformBudget: bigint;

const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const inr = (d: string) => Money.parse(d, 'INR').minor;
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow()).lifecycle_state;
const refOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('ref').where('id', '=', tradeId).executeTakeFirstOrThrow()).ref;
const sends = (tradeId: string) => w.app.selectFrom('chain_send').selectAll().where('trade_id', '=', tradeId).orderBy('created_at').execute();
const econOf = (tradeId: string) => w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
const orderOf = (orderId: string) => w.app.selectFrom('trader_order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
const clientWallet = async () => (await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow()).address;
const traderHolder = async (bankAccountId: string) => (await w.app.selectFrom('bank_account').select('holder_name').where('id', '=', bankAccountId).executeTakeFirstOrThrow()).holder_name;

/** A P2P assignment names the client rate: the rupees are one amount for the client and the trader. */
async function p2pTrade(trader: typeof inrTrader, input: { direction: 'SELL_USDT' | 'BUY_USDT'; amount: string; clientRate: string }) {
  return railsTrade(w, trader, { ...input, plannedClientRate: input.clientRate });
}

beforeAll(async () => {
  w = await createRailsWorld('p2p');
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, executionMode: 'P2P' as const, reason: 'no INR account: P2P escrow' });
  // Each trader prefunds the network of its own deals; the platform's budget stays empty.
  inrTrader = await railsTrader(w, 'INR Provider', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '1000');
  usdtTrader = await railsTrader(w, 'USDT Provider', { sell: { capacity: '500000', rate: '105.20', min: '10', max: '200000' } }, '1000');
  platformBudget = (await budgetFigures(w.app, null)).availableSun;
});
afterAll(async () => w.close());

describe('a P2P route', () => {
  it('belongs to every trader once the programme says P2P, and is funded by its traders, not the platform', async () => {
    const routes = await w.app.selectFrom('liquidity_route').select(['execution_mode']).where('trader_id', 'in', [inrTrader.traderId, usdtTrader.traderId]).execute();
    expect(routes.map((r) => r.execution_mode)).toEqual(['P2P', 'P2P']);
    expect((await budgetFigures(w.app, inrTrader.traderId)).availableSun).toBe(parseTrx('1000'));
  });

  it('is not offered to a trader whose network deposit cannot cover the deal', async () => {
    const broke = await railsTrader(w, 'Broke Provider', { sell: { capacity: '500000', rate: '105.00', min: '10', max: '200000' } }, '0');
    const { assignRequest, releaseOrder } = await import('@inrp2p/traders');
    const { createRequest } = await import('@inrp2p/quotes');
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'BUY_USDT', fixedSide: 'BASE' as const, amount: '100', walletId: w.walletId });
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '106.000000' });
    // The cheaper trader has no TRX: the order goes to the one that prefunded its network.
    const refOfTrader = async (id: string) => (await w.app.selectFrom('trader_profile').select('ref').where('id', '=', id).executeTakeFirstOrThrow()).ref;
    expect(assigned.traderRef).toBe(await refOfTrader(usdtTrader.traderId));
    expect(assigned.traderRef).not.toBe(await refOfTrader(broke.traderId));
    const live = await w.app.selectFrom('trader_order').select('id').where('status', 'in', ['OFFERED', 'ACCEPTED']).execute();
    for (const o of live) await runAs(w.app, releaseOrder(w.dealer.actor), w.dealer.ref, 'trader_order.release', { orderId: o.id, reason: 'test' });
  });

  it('is offered only with the client rate the desk will quote', async () => {
    const { assignRequest } = await import('@inrp2p/traders');
    const { createRequest } = await import('@inrp2p/quotes');
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'BUY_USDT', fixedSide: 'BASE' as const, amount: '100', walletId: w.walletId });
    const miss = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId }).catch((e) => e);
    expect(miss).toMatchObject({ code: 'TRADER_NONE_ELIGIBLE' });
    expect(JSON.stringify(miss.details)).toContain('NEEDS_CLIENT_RATE');
  });

  it('keeps its whole USDT margin: the network is the trader’s cost, not taken from the margin', async () => {
    // ₹0.01 a USDT over the trader's rate on 100 USDT: about 0.01 USDT of margin, far below ~18 TRX of fees — still a
    // quote, because the trader's deposit pays those fees.
    const trade = await p2pTrade(usdtTrader, { direction: 'BUY_USDT', amount: '100', clientRate: '105.210000' });
    const econ = await econOf(trade.tradeId);
    const fee = await w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', trade.quote.quoteId).executeTakeFirstOrThrow();
    expect(fee.funder_trader_id).toBe(usdtTrader.traderId);
    expect(fee.fee_usdt_minor!).toBeGreaterThan(econ.gross_margin_base_minor!);
    expect(fee.net_margin_usdt_minor).toBe(econ.gross_margin_base_minor);
    const { runP2pDeadlines: deadlines } = await import('@inrp2p/settlement');
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 31 * 60_000));
    await deadlines(clock.db);
    expect(await stateOf(trade.tradeId)).toBe('CANCELLED');
  });
});

describe('a client buys USDT: the trader’s USDT into escrow, the client’s rupees to the trader, the trader confirms', () => {
  it('runs end to end, and the margin is the USDT left at the deal address', async () => {
    const trade = await p2pTrade(usdtTrader, { direction: 'BUY_USDT', amount: '1000', clientRate: '106.500000' });
    const econ = await econOf(trade.tradeId);
    const order = await orderOf(trade.orderId);
    // One rupee amount: what the client pays is what the trader receives. Two USDT amounts: the trader delivers more.
    expect(econ.route_execution_mode).toBe('P2P');
    expect(econ.quote_inr_minor).toBe(inr('106500.00'));
    expect(econ.route_value_inr_minor).toBe(econ.quote_inr_minor);
    expect(econ.gross_margin_inr_minor).toBe(0n);
    expect(order.inr_minor).toBe(econ.quote_inr_minor);
    expect(order.base_minor).toBe(econ.route_base_minor);
    expect(econ.route_base_minor! - econ.base_minor).toBe(econ.gross_margin_base_minor);
    expect(econ.gross_margin_base_minor!).toBeGreaterThan(usdt('12'));
    // Nobody is told where to pay before the trader's USDT is in: no collection account, no reward, the trader's TRX.
    expect(await w.app.selectFrom('trade_collection').select('trade_id').where('trade_id', '=', trade.tradeId).executeTakeFirst()).toBeUndefined();
    const fee = await w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', trade.quote.quoteId).executeTakeFirstOrThrow();
    expect(fee).toMatchObject({ funder_trader_id: usdtTrader.traderId, reward_inr_minor: 0n });
    expect(fee.net_margin_usdt_minor).toBe(econ.gross_margin_base_minor);
    const hold = await w.app.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.trader_id).toBe(usdtTrader.traderId);

    const tradeRef = await refOf(trade.tradeId);
    const claim = (utrValue = utr()) => runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef, rail: 'IMPS' as const, utr: utrValue, fromBankAccountId: w.bankAccountId });
    await expect(claim()).rejects.toMatchObject({ code: 'ESCROW_NOT_FUNDED' });

    // (1) The trader funds the escrow.
    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    await sendUsdt(w, usdtTrader.walletAddress, address, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
    await confirmOnChain(w);
    expect(w.chain.balanceOf(address)).toBe(econ.route_base_minor);
    // The client's screen: the escrow is locked, it is the client's move, and only now does it see the seller's account.
    const deal = await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' });
    expect(deal).toMatchObject({ step: 'PAY', turn: 'BUYER', escrowFunded: true, inr: '106500.00' });
    expect(deal!.payTo).toMatchObject({ holderName: 'USDT Provider LLP', accountNumber: expect.stringMatching(/^\d{12}$/) });
    expect((await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'TRADER' }))!.payTo).toBeNull();
    // Nothing leaves the escrow before the trader confirms the rupees.
    expect((await railsTurn(w)).autopay.payoutsPlanned ?? 0).toBe(0);

    // (2) The client pays the trader directly and says so.
    const claimed = await claim();
    expect(await stateOf(trade.tradeId)).toBe('FIRST_LEG_DETECTED');
    const payments = await p2pPayments(w.app, trade.tradeId);
    expect(payments).toMatchObject([{ ref: claimed.legRef, side: 'CLIENT_TO_EXCHANGE', amount: '106500.00', status: 'PROCESSING', verdict: 'NOT_CHECKED' }]);

    // (3) The trader confirms, naming the sender its bank shows — the client's own account.
    const confirm = (senderName: string) => runAs(w.app, confirmOrderPaymentReceived(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName });
    expect(await confirm(CLIENT_SENDER)).toMatchObject({ verdict: 'MATCH', confirmed: true });
    const obligation = await w.app.selectFrom('route_obligation').selectAll().where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    const direct = await w.app.selectFrom('route_settlement').select(['flow', 'asset', 'amount_minor', 'status']).where('route_obligation_id', '=', obligation.id).where('flow', '=', 'DIRECT_FROM_CLIENT').execute();
    expect(direct).toEqual([{ flow: 'DIRECT_FROM_CLIENT', asset: 'INR', amount_minor: econ.quote_inr_minor, status: 'CONFIRMED' }]);
    // No exchange cash account ever held these rupees.
    expect(await balanceOf(w.app, 'ASSET:INR_SETTLEMENT:', 'INR', { tradeId: trade.tradeId })).toBe(0n);

    // (4) The signer pays the client its USDT out of the escrow; the margin stays.
    const before = w.chain.balanceOf(await clientWallet());
    await railsSettle(w, trade.tradeId);
    const all = await sends(trade.tradeId);
    const payout = all.find((s) => s.purpose === 'CLIENT_PAYOUT');
    expect(payout).toMatchObject({ from_address: address, to_address: await clientWallet(), amount_minor: econ.base_minor, status: 'CONFIRMED', bearer: 'TRADER', funder_trader_id: usdtTrader.traderId });
    expect(w.chain.balanceOf(await clientWallet()) - before).toBe(econ.base_minor);
    expect(w.chain.balanceOf(address)).toBe(econ.gross_margin_base_minor);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect((await w.app.selectFrom('route_obligation').select('status').where('id', '=', obligation.id).executeTakeFirstOrThrow()).status).toBe('SETTLED');
    expect(-(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'USDT', { tradeId: trade.tradeId }))).toBe(econ.gross_margin_base_minor);
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    // The trader's TRX paid the network, and nothing of it is paid back: no INR to pay it with, no platform TRX.
    const spent = await w.app.selectFrom('network_budget_hold').select(['trader_id', 'status', 'spent_sun', 'reimbursed_sun', 'reimbursed_inr_minor']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(spent).toMatchObject({ trader_id: usdtTrader.traderId, status: 'CLOSED', reimbursed_sun: 0n, reimbursed_inr_minor: 0n });
    expect(spent.spent_sun!).toBeGreaterThan(0n);
    expect(await balanceOf(w.app, 'LIAB:TRADER_REWARD_PAYABLE', 'INR')).toBe(0n);
    expect((await budgetFigures(w.app, null)).availableSun).toBe(platformBudget);
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('does not count rupees the trader’s bank shows came from someone else', async () => {
    const trade = await p2pTrade(usdtTrader, { direction: 'BUY_USDT', amount: '500', clientRate: '106.500000' });
    const order = await orderOf(trade.orderId);
    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    await sendUsdt(w, usdtTrader.walletAddress, address, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
    await confirmOnChain(w);
    await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: await refOf(trade.tradeId), rail: 'IMPS' as const, utr: utr(), fromBankAccountId: w.bankAccountId });
    const out = await runAs(w.app, confirmOrderPaymentReceived(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName: 'RANDOM STRANGER ENTERPRISES' });
    expect(out).toMatchObject({ verdict: 'MISMATCH', confirmed: false });
    expect(out.exceptionId).not.toBeNull();
    await railsSettle(w, trade.tradeId, 2);
    expect((await sends(trade.tradeId)).filter((s) => s.purpose === 'CLIENT_PAYOUT')).toEqual([]);
    expect(w.chain.balanceOf(address)).toBe(order.base_minor);
  });
});

describe('a client sells USDT: the client’s USDT into escrow, the trader’s rupees to the client, the client confirms', () => {
  it('runs end to end, and the margin is the USDT left at the deal address', async () => {
    const trade = await p2pTrade(inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '103.500000' });
    const econ = await econOf(trade.tradeId);
    const order = await orderOf(trade.orderId);
    expect(econ.quote_inr_minor).toBe(inr('103500.00'));
    expect(order.inr_minor).toBe(econ.quote_inr_minor);
    expect(order.base_minor).toBe(econ.route_base_minor);
    expect(econ.base_minor - econ.route_base_minor!).toBe(econ.gross_margin_base_minor);

    // The trader pays only once the client's USDT is in escrow.
    const pay = () => runAs(w.app, submitOrderPayment(inrTrader.admin.actor, w.traderDeps), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() });
    await expect(pay()).rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_DUE' });
    await settleFirstLeg(w, trade.tradeId);
    const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();

    // (2) The trader pays the client directly, from its own registered account — the client's, shown only to it, now.
    expect(await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'TRADER' })).toMatchObject({ step: 'PAY', turn: 'BUYER', payTo: { holderName: 'Acme Pay Private Limited', accountNumber: '50100123458219' } });
    expect((await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!.payTo).toBeNull();
    const paid = await pay();
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'CLIENT' })).toMatchObject({ step: 'CONFIRM', turn: 'SELLER' });
    await expect(pay()).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await p2pPayments(w.app, trade.tradeId)).toMatchObject([{ ref: paid.settlementRef, side: 'EXCHANGE_TO_CLIENT', amount: '103500.00', status: 'PROCESSING' }]);
    // Nothing goes to the trader before the client confirms.
    expect((await railsTurn(w)).autopay.routePaymentsPlanned).toBe(0);

    // (3) The client confirms — and who sent it.
    const tradeRef = await refOf(trade.tradeId);
    const profile = await w.app.selectFrom('trader_profile').select('bank_account_id').where('id', '=', inrTrader.traderId).executeTakeFirstOrThrow();
    const holder = await traderHolder(profile.bank_account_id!);
    const out = await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef, legRef: paid.settlementRef, senderName: holder });
    expect(out).toMatchObject({ verdict: 'MATCH', confirmed: true });

    // (4) The signer pays the trader its USDT out of the escrow; the margin stays.
    const before = w.chain.balanceOf(inrTrader.walletAddress);
    await railsSettle(w, trade.tradeId);
    const payment = (await sends(trade.tradeId)).find((s) => s.purpose === 'ROUTE_PAYMENT');
    expect(payment).toMatchObject({ from_address: deposit.address, to_address: inrTrader.walletAddress, amount_minor: econ.route_base_minor, status: 'CONFIRMED', bearer: 'TRADER', funder_trader_id: inrTrader.traderId });
    expect(w.chain.balanceOf(inrTrader.walletAddress) - before).toBe(econ.route_base_minor);
    expect(w.chain.balanceOf(deposit.address)).toBe(econ.gross_margin_base_minor);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect(-(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'USDT', { tradeId: trade.tradeId }))).toBe(econ.gross_margin_base_minor);
    expect(await balanceOf(w.app, 'ASSET:INR_SETTLEMENT:', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('the time limits: whoever does not act in time, the other side gets its money back', () => {
  const late = async (minutes = 31) => {
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + minutes * 60_000));
    return clock;
  };

  it('cancels a funded BUY its client never paid, and sends the trader its own USDT back from the escrow', async () => {
    const trade = await p2pTrade(usdtTrader, { direction: 'BUY_USDT', amount: '700', clientRate: '106.500000' });
    const order = await orderOf(trade.orderId);
    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    await sendUsdt(w, usdtTrader.walletAddress, address, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
    await confirmOnChain(w);
    const before = w.chain.balanceOf(usdtTrader.walletAddress);

    // Not yet: the client still has its window.
    expect((await runP2pDeadlines(w.app)).cancelled).toBe(0);
    const out = await runP2pDeadlines((await late()).db);
    expect(out.failures).toEqual([]);
    expect(await stateOf(trade.tradeId)).toBe('CANCELLED');
    const obligation = await w.app.selectFrom('route_obligation').select('status').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    expect(obligation.status).toBe('CANCELLED');
    const told = await w.app.selectFrom('outbox_event').select('payload').where('aggregate_id', '=', trade.tradeId).where('type', '=', 'client.trade_cancelled').executeTakeFirstOrThrow();
    expect(told.payload).toMatchObject({ expiredUnpaid: true, reason: expect.stringContaining('not paid within the payment window') });
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'TRADER' })).toMatchObject({ step: 'CANCELLED', escrowReturn: { status: 'PENDING' } });
    // Too late to pay now.
    await expect(runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: await refOf(trade.tradeId), rail: 'IMPS' as const, utr: utr(), fromBankAccountId: w.bankAccountId }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    await railsSettle(w, trade.tradeId);
    const back = (await sends(trade.tradeId)).find((s) => s.purpose === 'ESCROW_RETURN');
    expect(back).toMatchObject({ from_address: address, to_address: usdtTrader.walletAddress, amount_minor: order.base_minor, status: 'CONFIRMED', bearer: 'TRADER', funder_trader_id: usdtTrader.traderId });
    expect(w.chain.balanceOf(usdtTrader.walletAddress) - before).toBe(order.base_minor);
    expect(w.chain.balanceOf(address)).toBe(0n);
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'TRADER' })).toMatchObject({ step: 'CANCELLED', escrowReturn: { status: 'SENT' } });
    // The route owes and is owed nothing on this deal; nothing is left to send; the TRX the trade held is released.
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'USDT', { routeObligationId: trade.routeObligationId })).toBe(0n);
    expect(await balanceOf(w.app, 'LIAB:ROUTE_PAYABLE', 'INR', { routeObligationId: trade.routeObligationId })).toBe(0n);
    expect((await railsTurn(w)).autopay.escrowReturnsPlanned).toBe(0);
    const hold = await w.app.selectFrom('network_budget_hold').select('status').where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.status).not.toBe('ACTIVE');
    await runTraderSweep(w.app);
    expect((await orderOf(trade.orderId)).status).toBe('CANCELLED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('cancels a BUY whose trader never funded the escrow, with nothing to send back', async () => {
    const trade = await p2pTrade(usdtTrader, { direction: 'BUY_USDT', amount: '1000', clientRate: '106.500000' });
    await runP2pDeadlines((await late()).db);
    expect(await stateOf(trade.tradeId)).toBe('CANCELLED');
    const told = await w.app.selectFrom('outbox_event').select('payload').where('aggregate_id', '=', trade.tradeId).where('type', '=', 'client.trade_cancelled').executeTakeFirstOrThrow();
    expect(told.payload).toMatchObject({ reason: 'the trader did not fund the escrow in time' });
    await railsSettle(w, trade.tradeId, 2);
    expect(await sends(trade.tradeId)).toEqual([]);
  });

  it('unwinds a SELL whose trader did not pay in time: the client’s USDT goes back, and the trader can no longer pay', async () => {
    const trade = await p2pTrade(inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '103.500000' });
    const econ = await econOf(trade.tradeId);
    await settleFirstLeg(w, trade.tradeId);
    expect((await runP2pDeadlines(w.app)).unwound).toBe(0);
    const out = await runP2pDeadlines((await late()).db);
    expect(out).toMatchObject({ unwound: 1, failures: [] });
    expect(await w.app.selectFrom('p2p_unwind').select(['reason', 'p2p_dispute_id', 'refund_leg_id']).where('trade_id', '=', trade.tradeId).executeTakeFirst())
      .toEqual({ reason: 'PAY_WINDOW_MISSED', p2p_dispute_id: null, refund_leg_id: null });
    expect((await runP2pDeadlines((await late()).db)).unwound).toBe(0);
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'CLIENT' })).toMatchObject({ step: 'REFUND', turn: 'INRP2P', dueBy: null, unwind: { reason: 'PAY_WINDOW_MISSED', status: 'WAITING', amount: '1000.000000' } });
    const told = await w.app.selectFrom('outbox_event').select('type').where('aggregate_id', '=', trade.tradeId).where('type', 'in', ['p2p.unwind_started', 'trader.p2p_unwind_started']).execute();
    expect(told.map((e) => e.type).sort()).toEqual(['p2p.unwind_started', 'trader.p2p_unwind_started']);
    // Too late to pay now: the order says so, and so does the database.
    await expect(runAs(w.app, submitOrderPayment(inrTrader.admin.actor, w.traderDeps), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() }))
      .rejects.toMatchObject({ code: 'P2P_PAYMENT_WINDOW_CLOSED' });

    const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    const before = w.chain.balanceOf(w.clientSourceAddress);
    await railsSettle(w, trade.tradeId);
    const refund = (await sends(trade.tradeId)).find((x) => x.purpose === 'REFUND');
    expect(refund).toMatchObject({ from_address: deposit.address, to_address: w.clientSourceAddress, amount_minor: econ.base_minor, status: 'CONFIRMED', bearer: 'TRADER', funder_trader_id: inrTrader.traderId });
    expect(w.chain.balanceOf(w.clientSourceAddress) - before).toBe(econ.base_minor);
    expect(w.chain.balanceOf(deposit.address)).toBe(0n);
    expect(await stateOf(trade.tradeId)).toBe('CANCELLED');
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'CLIENT' })).toMatchObject({ step: 'CANCELLED', unwind: { status: 'SENT', amount: '1000.000000' } });
    expect(await w.app.selectFrom('exception_case').select('id').where('trade_id', '=', trade.tradeId).where('status', 'in', ['OPEN', 'IN_PROGRESS']).execute()).toEqual([]);
    expect((await railsTurn(w)).autopay.refundsPlanned).toBe(0);
    await runTraderSweep(w.app);
    expect((await orderOf(trade.orderId)).status).toBe('CANCELLED');
    expect(await balanceOf(w.app, 'LIAB:CLIENT_PAYABLE', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('hands INRP2P a payment its payee never answered, and a late confirmation still counts', async () => {
    const trade = await p2pTrade(inrTrader, { direction: 'SELL_USDT', amount: '400', clientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    const paid = await runAs(w.app, submitOrderPayment(inrTrader.admin.actor, w.traderDeps), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() });
    await runP2pDeadlines((await late(62)).db);
    const leg = await w.app.selectFrom('settlement_leg').select('id').where('ref', '=', paid.settlementRef).executeTakeFirstOrThrow();
    const receipt = () => w.app.selectFrom('exception_case').select('status').where('type', '=', 'P2P_RECEIPT_OVERDUE').where('subject_id', '=', leg.id).executeTakeFirst();
    expect(await receipt()).toEqual({ status: 'OPEN' });
    expect(await p2pDecisionView(w.app, trade.tradeId)).toMatchObject({ payee: 'CLIENT', overdue: true, decidable: true, dispute: null, payment: { ref: paid.settlementRef, amount: '41400.00' } });
    const profile = await w.app.selectFrom('trader_profile').select('bank_account_id').where('id', '=', inrTrader.traderId).executeTakeFirstOrThrow();
    await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: await refOf(trade.tradeId), legRef: paid.settlementRef, senderName: await traderHolder(profile.bank_account_id!) });
    expect(await receipt()).toEqual({ status: 'RESOLVED' });
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('a seller whose rupees did not arrive says so at once, and INRP2P decides from its bank (TD-35)', () => {
  const late = async (minutes: number) => {
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + minutes * 60_000));
    return clock;
  };
  const caseOf = (tradeId: string, type: string) => w.app.selectFrom('exception_case').select(['id', 'status', 'severity', 'resolution_command']).where('trade_id', '=', tradeId).where('type', '=', type as never).execute();
  const holdOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('hold').where('id', '=', tradeId).executeTakeFirstOrThrow()).hold;
  const traderHolderOf = async (traderId: string) => traderHolder((await w.app.selectFrom('trader_profile').select('bank_account_id').where('id', '=', traderId).executeTakeFirstOrThrow()).bank_account_id!);

  async function sellPaidByTrader(amount: string) {
    const trade = await p2pTrade(inrTrader, { direction: 'SELL_USDT', amount, clientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    const paid = await runAs(w.app, submitOrderPayment(inrTrader.admin.actor, w.traderDeps), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() });
    return { trade, paid, tradeRef: await refOf(trade.tradeId) };
  }

  async function buyClaimedByClient(amount: string) {
    const trade = await p2pTrade(usdtTrader, { direction: 'BUY_USDT', amount, clientRate: '106.500000' });
    const order = await orderOf(trade.orderId);
    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    await sendUsdt(w, usdtTrader.walletAddress, address, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
    await confirmOnChain(w);
    const tradeRef = await refOf(trade.tradeId);
    const claimed = await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef, rail: 'IMPS' as const, utr: utr(), fromBankAccountId: w.bankAccountId });
    return { trade, order, address, tradeRef, claimed };
  }

  const clientDisputes = (tradeRef: string, note: string | null = 'Nothing from them in my HDFC statement') =>
    runAs(w.app, openClientDispute(w.acceptor.actor), w.acceptor.ref, 'escrow_dispute.open', { tradeRef, reason: 'NO_CREDIT' as const, note });
  const decide = (op: typeof w.dealer, tradeId: string, input: { decision: 'PAID' | 'NOT_PAID'; notes: string; senderName?: string }) =>
    runAs(w.app, decideP2pPayment(op.actor, w.settlementDeps), op.ref, 'escrow_payment.decide', { tradeId, ...input });

  it('stops a SELL the moment its client says the trader’s rupees did not arrive; paid, the escrow releases', async () => {
    const { trade, paid, tradeRef } = await sellPaidByTrader('600');
    // Not before anyone says so: the payee still has its window.
    await expect(decide(w.settlementOp, trade.tradeId, { decision: 'PAID', notes: 'early', senderName: 'X' })).rejects.toMatchObject({ code: 'NOT_DUE' });

    const opened = await clientDisputes(tradeRef);
    expect(opened.ref).toMatch(/^DSP-/);
    expect(await holdOf(trade.tradeId)).toBe(true);
    expect(await caseOf(trade.tradeId, 'P2P_DISPUTE')).toMatchObject([{ status: 'OPEN', severity: 'BLOCKING' }]);
    await expect(clientDisputes(tradeRef)).rejects.toMatchObject({ code: 'DISPUTE_EXISTS' });
    // Each side sees the dispute, and only its own words.
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'CLIENT' })).toMatchObject({
      step: 'CONFIRM', turn: 'INRP2P', dueBy: null, dispute: { ref: opened.ref, reason: 'NO_CREDIT', status: 'OPEN', yourNote: 'Nothing from them in my HDFC statement', buyerAnswered: false },
    });
    await runAs(w.app, answerOrderDispute(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.answer_dispute', { ref: trade.orderRef, note: 'Paid by IMPS from ICICI at 14:02, UTR on the order' });
    expect((await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'TRADER' }))!.dispute).toMatchObject({ yourNote: 'Paid by IMPS from ICICI at 14:02, UTR on the order', buyerAnswered: true });
    expect((await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!.dispute).toMatchObject({ yourNote: 'Nothing from them in my HDFC statement', buyerAnswered: true });
    // The case is closed only by deciding the payment, and the payee's window no longer runs.
    const [c] = await caseOf(trade.tradeId, 'P2P_DISPUTE');
    await expect(runAs(w.app, resolveException(w.settlementOp.actor), w.settlementOp.ref, 'exception.resolve', { exceptionId: c!.id, resolution: 'escalate' as const, notes: 'x' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await runP2pDeadlines((await late(62)).db);
    expect(await caseOf(trade.tradeId, 'P2P_RECEIPT_OVERDUE')).toEqual([]);
    expect(await p2pDecisionView(w.app, trade.tradeId)).toMatchObject({ decidable: true, dispute: { payeeNote: 'Nothing from them in my HDFC statement', payerNote: 'Paid by IMPS from ICICI at 14:02, UTR on the order' } });

    // A stranger's rupees are never decided paid.
    await expect(decide(w.settlementOp, trade.tradeId, { decision: 'PAID', notes: 'statement line 4', senderName: 'RANDOM STRANGER ENTERPRISES' })).rejects.toMatchObject({ code: 'INR_UNEXPECTED_SENDER' });
    expect((await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!.dispute!.status).toBe('OPEN');
    const out = await decide(w.settlementOp, trade.tradeId, { decision: 'PAID', notes: 'The client’s HDFC statement shows the credit at 14:09', senderName: await traderHolderOf(inrTrader.traderId) });
    expect(out).toEqual({ decision: 'PAID', legRef: paid.settlementRef });
    expect(await holdOf(trade.tradeId)).toBe(false);
    expect(await caseOf(trade.tradeId, 'P2P_DISPUTE')).toMatchObject([{ status: 'RESOLVED', resolution_command: 'p2p_decide' }]);
    const decided = await w.app.selectFrom('p2p_dispute').select(['status', 'decided_via']).where('ref', '=', opened.ref).executeTakeFirstOrThrow();
    expect(decided).toEqual({ status: 'PAID', decided_via: 'INRP2P' });
    const events = await w.app.selectFrom('outbox_event').select(['type', 'payload']).where('aggregate_id', '=', trade.tradeId).where('type', 'in', ['p2p.dispute_decided', 'trader.p2p_dispute_decided']).execute();
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toMatchObject({ decision: 'PAID', via: 'INRP2P', payee: 'CLIENT' });
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('unwinds a SELL INRP2P finds unpaid: the trader cannot pay again, and the client’s USDT goes back', async () => {
    const { trade, paid, tradeRef } = await sellPaidByTrader('500');
    const econ = await econOf(trade.tradeId);
    await clientDisputes(tradeRef, null);
    // Not paid is a cancellation's decision: the settlement desk alone cannot make it.
    await expect(decide(w.settlementOp, trade.tradeId, { decision: 'NOT_PAID', notes: 'no credit' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await decide(w.dealer, trade.tradeId, { decision: 'NOT_PAID', notes: 'The client’s bank statement shows no credit for this UTR' });
    expect((await w.app.selectFrom('settlement_leg').select('status').where('ref', '=', paid.settlementRef).executeTakeFirstOrThrow()).status).toBe('FAILED');
    expect(await caseOf(trade.tradeId, 'BANK_TRANSFER_FAILED')).toEqual([]);
    expect(await w.app.selectFrom('p2p_unwind').select(['reason']).where('trade_id', '=', trade.tradeId).executeTakeFirst()).toEqual({ reason: 'NOT_PAID' });
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'TRADER' })).toMatchObject({ step: 'REFUND', turn: 'INRP2P', dispute: { status: 'NOT_PAID' } });
    await expect(runAs(w.app, submitOrderPayment(inrTrader.admin.actor, w.traderDeps), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() }))
      .rejects.toMatchObject({ code: 'P2P_PAYMENT_WINDOW_CLOSED' });
    const before = w.chain.balanceOf(w.clientSourceAddress);
    await railsSettle(w, trade.tradeId);
    expect(w.chain.balanceOf(w.clientSourceAddress) - before).toBe(econ.base_minor);
    expect(await stateOf(trade.tradeId)).toBe('CANCELLED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('cancels a BUY INRP2P finds unpaid, and the trader’s USDT goes back from the escrow', async () => {
    const { trade, order, address, tradeRef, claimed } = await buyClaimedByClient('300');
    const opened = await runAs(w.app, disputeOrderPayment(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader_order.dispute', { ref: trade.orderRef, reason: 'WRONG_AMOUNT' as const, note: 'Only ₹30,000 arrived' });
    // Only the payee disputes; only the payer answers.
    await expect(clientDisputes(tradeRef)).rejects.toMatchObject({ code: 'NOT_THE_PAYEE' });
    await expect(runAs(w.app, answerOrderDispute(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader_order.answer_dispute', { ref: trade.orderRef, note: 'x' })).rejects.toMatchObject({ code: 'NOT_THE_PAYER' });
    await runAs(w.app, answerClientDispute(w.acceptor.actor), w.acceptor.ref, 'escrow_dispute.answer', { tradeRef, note: 'I sent the full amount by IMPS' });
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'CLIENT' })).toMatchObject({ turn: 'INRP2P', dispute: { ref: opened.ref, reason: 'WRONG_AMOUNT', yourNote: 'I sent the full amount by IMPS', buyerAnswered: true } });
    await decide(w.dealer, trade.tradeId, { decision: 'NOT_PAID', notes: 'Trader’s statement: ₹30,000 only; returned to the client' });
    expect(await stateOf(trade.tradeId)).toBe('CANCELLED');
    expect((await w.app.selectFrom('settlement_leg').select('status').where('ref', '=', claimed.legRef).executeTakeFirstOrThrow()).status).toBe('FAILED');
    expect(await p2pDeal(w.app, null, { tradeId: trade.tradeId, viewer: 'TRADER' })).toMatchObject({ step: 'CANCELLED', dispute: { status: 'NOT_PAID' }, escrowReturn: { status: 'PENDING' } });
    const before = w.chain.balanceOf(usdtTrader.walletAddress);
    await railsSettle(w, trade.tradeId);
    expect(w.chain.balanceOf(usdtTrader.walletAddress) - before).toBe(order.base_minor);
    expect(w.chain.balanceOf(address)).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('lets a payee who disputed confirm after all: the dispute closes, and the deal completes', async () => {
    const { trade } = await buyClaimedByClient('250');
    await runAs(w.app, disputeOrderPayment(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader_order.dispute', { ref: trade.orderRef, reason: 'NO_CREDIT' as const });
    expect(await holdOf(trade.tradeId)).toBe(true);
    const out = await runAs(w.app, confirmOrderPaymentReceived(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName: CLIENT_SENDER });
    expect(out).toMatchObject({ verdict: 'MATCH', confirmed: true });
    expect(await w.app.selectFrom('p2p_dispute').select(['status', 'decided_via']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow()).toEqual({ status: 'PAID', decided_via: 'PAYEE' });
    expect(await holdOf(trade.tradeId)).toBe(false);
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});
