import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, parseTrx } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import { budgetFigures, recordNetworkDeposit } from '@inrp2p/network';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { claimIncomingFiat, confirmClientReceipt, p2pDeal, p2pPayments, runP2pDeadlines } from '@inrp2p/settlement';
import { confirmOrderPaymentReceived, orderDeliveryAddress, runTraderSweep, submitOrderPayment } from '@inrp2p/traders';
import { CLIENT_SENDER, balanceOf, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { confirmOnChain, sendUsdt, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsSettle, railsTrade, railsTrader, railsTurn } from './rails-world.ts';

/**
 * P2P escrow (ADR 0019), end to end on the exchange's own rails: the rupees go once, straight between the client's and
 * the trader's own accounts; the USDT waits at the deal's address until the one who received the rupees says so, and
 * who sent them; the signer then pays out, and the exchange's margin — USDT — stays at the address. The platform's TRX
 * budget pays the network; the traders have none.
 */
let w: RailsWorld;
let inrTrader: Awaited<ReturnType<typeof railsTrader>>;
let usdtTrader: Awaited<ReturnType<typeof railsTrader>>;

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
  // No trader deposits TRX: on a P2P route the platform pays the network, out of the client's price.
  inrTrader = await railsTrader(w, 'INR Provider', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '0');
  usdtTrader = await railsTrader(w, 'USDT Provider', { sell: { capacity: '500000', rate: '105.20', min: '10', max: '200000' } }, '0');
  const from = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
  const txid = w.net.externalTrxTransfer({ from, to: w.budgetAddress, amountSun: parseTrx('5000') });
  const facts = await w.rails.network.trxTransfer(txid);
  if (facts.status !== 'FINAL') throw new Error(`platform top-up not final: ${facts.status}`);
  await runAs(w.app, recordNetworkDeposit(w.finance.actor, facts.transfer), w.finance.ref, 'network_deposit.record', { txHash: txid, platform: true });
});
afterAll(async () => w.close());

describe('a P2P route', () => {
  it('belongs to every trader once the programme says P2P, and its traders need no network deposit', async () => {
    const routes = await w.app.selectFrom('liquidity_route').select(['execution_mode']).where('trader_id', 'in', [inrTrader.traderId, usdtTrader.traderId]).execute();
    expect(routes.map((r) => r.execution_mode)).toEqual(['P2P', 'P2P']);
    expect((await budgetFigures(w.app, inrTrader.traderId)).availableSun).toBe(0n);
    expect((await budgetFigures(w.app, null)).availableSun).toBeGreaterThanOrEqual(parseTrx('5000'));
  });

  it('is offered only with the client rate the desk will quote', async () => {
    const { assignRequest } = await import('@inrp2p/traders');
    const { createRequest } = await import('@inrp2p/quotes');
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'BUY_USDT', fixedSide: 'BASE' as const, amount: '100', walletId: w.walletId });
    const miss = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId }).catch((e) => e);
    expect(miss).toMatchObject({ code: 'TRADER_NONE_ELIGIBLE' });
    expect(JSON.stringify(miss.details)).toContain('NEEDS_CLIENT_RATE');
  });

  it('refuses a quote whose USDT margin would not pay for the network', async () => {
    // ₹0.01 a USDT over the trader's rate on 100 USDT: about 0.01 USDT of margin, far below ~18 TRX of fees.
    const refused = await p2pTrade(usdtTrader, { direction: 'BUY_USDT', amount: '100', clientRate: '105.210000' }).catch((e) => e);
    expect(refused).toMatchObject({ code: 'QUOTE_UNPROFITABLE' });
    expect(refused.details).toHaveProperty('networkFeeUsdt');
    const { releaseOrder } = await import('@inrp2p/traders');
    const live = await w.app.selectFrom('trader_order').select('id').where('status', 'in', ['OFFERED', 'ACCEPTED']).execute();
    for (const o of live) await runAs(w.app, releaseOrder(w.dealer.actor), w.dealer.ref, 'trader_order.release', { orderId: o.id, reason: 'test' });
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
    // Nobody is told where to pay before the trader's USDT is in: no collection account, no reward, platform TRX.
    expect(await w.app.selectFrom('trade_collection').select('trade_id').where('trade_id', '=', trade.tradeId).executeTakeFirst()).toBeUndefined();
    const fee = await w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', trade.quote.quoteId).executeTakeFirstOrThrow();
    expect(fee).toMatchObject({ funder_trader_id: null, reward_inr_minor: 0n });
    expect(fee.net_margin_usdt_minor).toBe(econ.gross_margin_base_minor! - fee.fee_usdt_minor!);
    const hold = await w.app.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.trader_id).toBeNull();

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
    expect(payout).toMatchObject({ from_address: address, to_address: await clientWallet(), amount_minor: econ.base_minor, status: 'CONFIRMED' });
    expect(w.chain.balanceOf(await clientWallet()) - before).toBe(econ.base_minor);
    expect(w.chain.balanceOf(address)).toBe(econ.gross_margin_base_minor);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect((await w.app.selectFrom('route_obligation').select('status').where('id', '=', obligation.id).executeTakeFirstOrThrow()).status).toBe('SETTLED');
    expect(-(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'USDT', { tradeId: trade.tradeId }))).toBe(econ.gross_margin_base_minor);
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(0n);
    // The platform's TRX paid the network, not the trader's.
    const spent = await w.app.selectFrom('network_budget_hold').select(['trader_id', 'status']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(spent.trader_id).toBeNull();
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
    expect(payment).toMatchObject({ from_address: deposit.address, to_address: inrTrader.walletAddress, amount_minor: econ.route_base_minor, status: 'CONFIRMED' });
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
    expect(back).toMatchObject({ from_address: address, to_address: usdtTrader.walletAddress, amount_minor: order.base_minor, status: 'CONFIRMED', bearer: 'PLATFORM' });
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

  it('hands the desk a SELL whose trader did not pay in time, and closes the case once it pays', async () => {
    const trade = await p2pTrade(inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    await runP2pDeadlines((await late()).db);
    const open = () => w.app.selectFrom('exception_case').select(['type', 'status', 'severity']).where('trade_id', '=', trade.tradeId).where('type', '=', 'P2P_PAYMENT_OVERDUE').execute();
    expect(await open()).toEqual([{ type: 'P2P_PAYMENT_OVERDUE', status: 'OPEN', severity: 'WARNING' }]);
    await runP2pDeadlines((await late()).db);
    expect(await open()).toHaveLength(1);
    const paid = await runAs(w.app, submitOrderPayment(inrTrader.admin.actor, w.traderDeps), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() });
    expect((await open())[0]!.status).toBe('RESOLVED');

    // The client does not answer: the desk is told; a late confirmation still counts and closes it.
    await runP2pDeadlines((await late(62)).db);
    const leg = await w.app.selectFrom('settlement_leg').select('id').where('ref', '=', paid.settlementRef).executeTakeFirstOrThrow();
    const receipt = () => w.app.selectFrom('exception_case').select('status').where('type', '=', 'P2P_RECEIPT_OVERDUE').where('subject_id', '=', leg.id).executeTakeFirst();
    expect(await receipt()).toEqual({ status: 'OPEN' });
    const profile = await w.app.selectFrom('trader_profile').select('bank_account_id').where('id', '=', inrTrader.traderId).executeTakeFirstOrThrow();
    await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: await refOf(trade.tradeId), legRef: paid.settlementRef, senderName: await traderHolder(profile.bank_account_id!) });
    expect(await receipt()).toEqual({ status: 'RESOLVED' });
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});
