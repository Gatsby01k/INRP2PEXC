import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { createTestClientLogin, runAs } from '@inrp2p/identity/testing';
import type { OutboxEvent } from '@inrp2p/outbox';
import { addBankAccount, addUpiId, addWallet, archiveBankAccount, archiveWallet, createClient } from '@inrp2p/clients';
import { clientInbox, clientNotificationHandler, traderNotificationHandler } from '@inrp2p/notifications';
import { createRequest } from '@inrp2p/quotes';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { chooseClientPayMethod, claimIncomingFiat, p2pDeal, runP2pDeadlines } from '@inrp2p/settlement';
import { applyAsTrader, approveTrader, orderDeliveryAddress, reviewTraderDestination, runTraderSweep, setAvailability, submitOrderPayment, updateBlock } from '@inrp2p/traders';
import { settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { type TraderPerson, confirmOnChain, sendUsdt, traderIdOf } from './traders-world.ts';
import { type RailsWorld, completeDeal, createRailsWorld, railsTrade, railsTrader } from './rails-world.ts';

/**
 * The launch audit of 2026-11-10, as regressions. Each test is a journey a first-time trader or client walks, and a place
 * where the product contradicted itself:
 *
 * - a deal's timed steps changed hands without telling the side whose step it had become (migration 0049);
 * - a trader's own "Clients pay you by" was asked for, saved, and then ignored by the deal — which offered UPI anyway;
 * - a client could accept a price to buy USDT with no bank account to pay from, and only find out with the clock running;
 * - a bank account an open trade pays to, or a trader settles with, could be archived for good in the middle of a deal;
 * - a side that had used up its capacity stopped taking orders in silence;
 * - the trader's application could not say "UPI" at all.
 */
let w: RailsWorld;
let usdtTrader: Awaited<ReturnType<typeof railsTrader>>;
let inrTrader: Awaited<ReturnType<typeof railsTrader>>;

const utr12 = () => String(randomInt(1e11, 1e12));
/** One aggregate's own events of these types, as the dispatcher hands them to a handler. */
const eventsOf = async (aggregateId: string, types: readonly string[]): Promise<OutboxEvent[]> =>
  (await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).where('aggregate_id', '=', aggregateId).where('type', 'in', [...types]).orderBy('created_at').execute())
    .map((e) => ({ id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id }));
const inboxOf = (clientId: string) => clientInbox(w.app, clientId, { limit: 200 });
const blockOf = (traderId: string, side: 'BUY_USDT' | 'SELL_USDT') => w.app.selectFrom('trader_block').select(['id', 'version', 'rails', 'capacity_minor', 'reserved_minor']).where('trader_id', '=', traderId).where('side', '=', side).executeTakeFirstOrThrow();

/** A client's BUY as it opens: nothing in escrow yet. 700 USDT at 106.50 is ₹74,550 — UPI's, by the amount. */
const openBuy = (trader = usdtTrader, amount = '700') => railsTrade(w, trader, { direction: 'BUY_USDT', amount, clientRate: '106.500000', plannedClientRate: '106.500000' });

/** The trader locks its USDT in the order's escrow, and the chain makes it final. */
async function fundEscrow(trader: typeof usdtTrader, trade: { orderId: string; orderRef: string }) {
  const order = await w.app.selectFrom('trader_order').select('base_minor').where('id', '=', trade.orderId).executeTakeFirstOrThrow();
  const { address } = await runAs(w.app, orderDeliveryAddress(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
  await sendUsdt(w, trader.walletAddress, address, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
  await confirmOnChain(w);
}

beforeAll(async () => {
  w = await createRailsWorld('launch_audit');
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, riskPolicy: null, reason: 'launch audit' });
  usdtTrader = await railsTrader(w, 'USDT Seller', { sell: { capacity: '500000', rate: '105.20', min: '10', max: '200000' } }, '5000');
  // ADR 0029: buyers pay the seller by UPI only to a verified UPI ID of its own — the desk adds one, live at once.
  await runAs(w.app, addUpiId(w.owner.actor), w.owner.ref, 'client_upi.add', { clientId: usdtTrader.clientId, vpa: 'usdt.seller@okaxis', holderName: 'USDT Seller LLP' });
  inrTrader = await railsTrader(w, 'INR Payer', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '5000');
});
afterAll(async () => w.close());

describe('a deal says whose move it is, the moment it becomes theirs', () => {
  it('a client buys: the seller is told to lock its USDT, the buyer that its time to pay has started, the seller that the buyer says it paid', async () => {
    const trade = await openBuy();
    const trader = traderNotificationHandler(w.app);
    const client = clientNotificationHandler(w.app);

    // 1. The trade opens. The seller's escrow clock runs from now: it is told so, not "you will be told when it is your turn".
    for (const e of await eventsOf(trade.orderId, ['trader.order_started'])) await trader.run(e);
    const started = (await inboxOf(usdtTrader.clientId)).find((n) => n.kind === 'TRADER_ORDER_ACCEPTED' && n.subjectRef === trade.orderRef)!;
    expect(started.title).toMatch(/^Your move: put [\d,.]+ USDT in escrow/);
    expect(started.body).toContain('within 30 minutes');
    expect(started.body).not.toContain('You will be told when it is your turn');
    // Nothing tells the buyer to pay while there is nothing in escrow to pay for.
    expect(await eventsOf(trade.tradeId, ['p2p.pay_window_opened'])).toEqual([]);

    // 2. The seller's USDT is final in escrow: the buyer's window opens, and the buyer hears of it then — with its deadline.
    await fundEscrow(usdtTrader, trade);
    expect((await runP2pDeadlines(w.app)).failures).toEqual([]);
    const opened = await eventsOf(trade.tradeId, ['p2p.pay_window_opened', 'trader.p2p_pay_window_opened']);
    expect(opened.map((e) => e.type).sort()).toEqual(['p2p.pay_window_opened', 'trader.p2p_pay_window_opened']);
    expect(opened[0]!.payload).toMatchObject({ payer: 'CLIENT', method: 'UPI' });
    for (const e of opened) {
      if (client.handles(e.type)) await client.run(e);
      if (trader.handles(e.type)) await trader.run(e);
    }
    const payNow = (await inboxOf(w.clientId)).find((n) => n.kind === 'P2P_PAY_NOW' && n.subjectRef === trade.tradeRef)!;
    expect(payNow).toMatchObject({ title: 'Pay now — the seller’s USDT is locked', href: `/trades/${trade.tradeRef}` });
    expect(payNow.body).toMatch(/Pay ₹74,550 by \d\d:\d\d IST/);
    // The seller is not told to pay anything; and a second turn of the clock tells nobody twice.
    expect((await inboxOf(usdtTrader.clientId)).filter((n) => n.kind === 'P2P_PAY_NOW')).toEqual([]);
    await runP2pDeadlines(w.app);
    expect(await eventsOf(trade.tradeId, ['p2p.pay_window_opened'])).toHaveLength(1);

    // 3. The buyer says it paid: the seller hears at once, in its inbox — not only in a Telegram chat it may never have linked.
    await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'UPI' as const, utr: utr12(), fromBankAccountId: w.bankAccountId, payeeNameConfirmed: true });
    const claimed = await eventsOf(trade.tradeId, ['desk.client_payment_claimed']);
    expect(claimed).toHaveLength(1);
    expect(trader.handles('desk.client_payment_claimed')).toBe(true);
    await trader.run(claimed[0]!);
    expect((await inboxOf(usdtTrader.clientId)).find((n) => n.kind === 'P2P_PAYMENT_SENT' && n.subjectRef === trade.orderRef)).toMatchObject({
      title: 'The buyer says they paid', href: `/traders/orders/${trade.orderRef}`, body: expect.stringContaining('₹74,550 by UPI'),
    });
  });

  it('a client sells: the buyer is told to wait for the escrow, and the client that its trader says it paid', async () => {
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '500', clientRate: '103.500000', plannedClientRate: '103.500000' });
    const trader = traderNotificationHandler(w.app);
    const client = clientNotificationHandler(w.app);
    // The trader buys: its turn comes after the client's USDT is locked, and it is told exactly that.
    for (const e of await eventsOf(trade.orderId, ['trader.order_started'])) await trader.run(e);
    const started = (await inboxOf(inrTrader.clientId)).find((n) => n.kind === 'TRADER_ORDER_ACCEPTED' && n.subjectRef === trade.orderRef)!;
    expect(started.title).toBe(`Order ${trade.orderRef} is confirmed`);
    expect(started.body).toContain('You are told the moment it is locked');

    await settleFirstLeg(w, trade.tradeId);
    await runAs(w.app, submitOrderPayment(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr12() });
    const sent = await eventsOf(trade.tradeId, ['client.p2p_payment_sent']);
    expect(sent).toHaveLength(1);
    expect(client.handles('client.p2p_payment_sent')).toBe(true);
    await client.run(sent[0]!);
    // Told when the trader says it paid — before, the first it heard was "has the payment arrived?" once it was late.
    expect((await inboxOf(w.clientId)).find((n) => n.kind === 'P2P_PAYMENT_SENT' && n.subjectRef === trade.tradeRef)).toMatchObject({
      title: 'The buyer says they paid', href: `/trades/${trade.tradeRef}`, body: expect.stringContaining('₹51,750 by IMPS'),
    });
  });
});

describe('a deal offers only the ways to pay its trader’s side uses', () => {
  it('a trader that takes no UPI is not paid by UPI: no code, no fifteen-minute window, and UPI cannot be chosen', async () => {
    const before = await blockOf(usdtTrader.traderId, 'SELL_USDT');
    await runAs(w.app, updateBlock(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader.update_block', { side: 'SELL_USDT' as const, expectedVersion: before.version, rails: ['IMPS', 'NEFT'] as const });
    try {
      const trade = await openBuy();
      await fundEscrow(usdtTrader, trade);
      // ₹74,550 is UPI's by the amount alone — and was offered by UPI, with UPI's time, whatever the trader had said.
      const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
      expect(deal.step).toBe('PAY');
      expect(deal.payWindow).toMatchObject({ method: 'IMPS', chosen: false });
      expect(deal.payWindow!.methods.map((m) => [m.rail, m.possible])).toEqual([['IMPS', true], ['NEFT', true], ['UPI', false], ['RTGS', false]]);
      expect(deal.payWindow!.methods.find((m) => m.rail === 'UPI')).toMatchObject({ possible: false, limit: 'not used on this deal' });
      expect(deal.payTo).toMatchObject({ upiLink: null, rails: ['IMPS', 'NEFT'] });
      await expect(runAs(w.app, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef: trade.tradeRef, method: 'UPI' }))
        .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('UPI is not used on this deal') });
      // The clock the deadlines open is IMPS's thirty minutes, not UPI's fifteen.
      await runP2pDeadlines(w.app);
      const window = await w.app.selectFrom('p2p_pay_window').select(['method', 'opened_at', 'due_at']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
      expect(window.method).toBe('IMPS');
      expect(window.due_at.getTime() - window.opened_at.getTime()).toBe(30 * 60_000);
      // What the buyer may still choose is among the trader's ways.
      await runAs(w.app, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef: trade.tradeRef, method: 'NEFT' });
      // "I've paid" is never refused for its rail: money that moved is filed, whatever way it went.
      await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'UPI' as const, utr: utr12(), fromBankAccountId: w.bankAccountId, payeeNameConfirmed: true });
    } finally {
      const now = await blockOf(usdtTrader.traderId, 'SELL_USDT');
      await runAs(w.app, updateBlock(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader.update_block', { side: 'SELL_USDT' as const, expectedVersion: now.version, rails: ['UPI', 'IMPS', 'NEFT', 'RTGS'] as const });
    }
  });

  it('with every way on, the amount decides as before — UPI and its code up to ₹1 lakh', async () => {
    const trade = await openBuy();
    await fundEscrow(usdtTrader, trade);
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(deal.payWindow).toMatchObject({ method: 'UPI' });
    expect(deal.payTo!.upiLink).toMatch(/^upi:\/\/pay\?/);
    expect(deal.payTo!.rails).toEqual(['UPI', 'IMPS', 'NEFT']);
  });
});

describe('a client buying USDT has a bank account to pay from before it is given a price', () => {
  it('refuses the request of a client with a wallet and no bank account, and takes it once one is on file', async () => {
    const c = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: 'Wallet Only Private Limited', displayName: 'Wallet Only', type: 'COMPANY' as const, typicalDirection: 'BUY_USDT' as const });
    const wallet = await runAs(w.app, addWallet(w.owner.actor), w.owner.ref, 'client_wallet.add', { clientId: c.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'DESTINATION' as const, label: 'Receiving wallet' });
    const ask = () => runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: c.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '100', walletId: wallet.walletId });
    await expect(ask()).rejects.toMatchObject({ code: 'PAYER_ACCOUNT_REQUIRED', details: { field: 'bankAccountId' } });
    expect(await w.app.selectFrom('trade_request').select('id').where('client_id', '=', c.clientId).execute()).toEqual([]);
    await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', { clientId: c.clientId, holderName: 'Wallet Only Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100777766655' });
    expect((await ask()).ref).toMatch(/\w/);
  });
});

describe('a bank account or wallet a live deal depends on is not archived by its own client', () => {
  it('refuses the account an open trade pays to, and the account and wallet a trader settles with — and still archives one nothing uses', async () => {
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '300', clientRate: '103.500000', plannedClientRate: '103.500000' });
    const archive = (who: { actor: Parameters<typeof archiveBankAccount>[0]; ref: unknown }, bankAccountId: string) =>
      runAs(w.app, archiveBankAccount(who.actor), who.ref as never, 'client_bank.archive', { bankAccountId, reason: 'no longer used' });

    // The client's own payout account, in the middle of its sale: archiving cannot be undone, and its buyer would be shown no account.
    // (It names the oldest of its open trades — an earlier sale here is still open too.)
    expect(trade.tradeRef).toMatch(/^IX-/);
    await expect(archive(w.acceptor, w.bankAccountId)).rejects.toMatchObject({ code: 'DESTINATION_IN_USE', message: expect.stringMatching(/^Trade IX-[\d-]+ is still open and pays to this bank account/) });
    // The trader's registered account and wallet: changed on Traders → Settlement details, never archived from under its orders.
    await expect(archive(inrTrader.admin, inrTrader.bankAccountId)).rejects.toMatchObject({ code: 'DESTINATION_IN_USE', message: expect.stringContaining('trader account settles with') });
    await expect(runAs(w.app, archiveWallet(inrTrader.admin.actor), inrTrader.admin.ref, 'client_wallet.archive', { walletId: inrTrader.walletId, reason: 'no longer used' }))
      .rejects.toMatchObject({ code: 'DESTINATION_IN_USE' });
    const still = await w.app.selectFrom('bank_account').select(['id', 'status']).where('id', 'in', [w.bankAccountId, inrTrader.bankAccountId]).execute();
    expect(still.map((b) => b.status)).toEqual(['ACTIVE', 'ACTIVE']);
    expect((await w.app.selectFrom('crypto_wallet').select('status').where('id', '=', inrTrader.walletId).executeTakeFirstOrThrow()).status).toBe('ACTIVE');

    // An account nothing depends on is archived as before.
    const spare = await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', { clientId: w.clientId, holderName: 'Acme Pay Private Limited', bankName: 'Axis Bank', ifsc: 'UTIB0000123', accountNumber: '917020011223344' });
    await archive(w.acceptor, spare.bankAccountId);
    expect((await w.app.selectFrom('bank_account').select('status').where('id', '=', spare.bankAccountId).executeTakeFirstOrThrow()).status).toBe('ARCHIVED');
    // The desk can still archive one a deal uses — a compromised account — and then moves the trade's destination itself.
    const second = await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', { clientId: inrTrader.clientId, holderName: 'INR Payer LLP', bankName: 'Axis Bank', ifsc: 'UTIB0000123', accountNumber: '917020099887766' });
    await runAs(w.app, archiveBankAccount(w.owner.actor), w.owner.ref, 'client_bank.archive', { bankAccountId: second.bankAccountId, reason: 'added by mistake' });
  });
});

describe('a side that has used up its capacity says so', () => {
  it('tells the trader once its last open order completes and the side can no longer take its smallest order', async () => {
    const small = await railsTrader(w, 'Small Seller', { sell: { capacity: '150', rate: '105.20', min: '100', max: '150' } }, '5000');
    // The desk's routing picks the trader: with the other seller offline for a moment, it is this one.
    const online = (available: boolean) => runAs(w.app, setAvailability(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader.set_availability', { available });
    await online(false);
    const trade = await openBuy(small, '100').finally(() => online(true));
    await completeDeal(w, small, trade);
    await runTraderSweep(w.app);
    const block = await blockOf(small.traderId, 'SELL_USDT');
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', trade.orderId).executeTakeFirstOrThrow()).status).toBe('COMPLETED');
    // The completed order used its capacity up for good: what is left is under the side's smallest order.
    expect(block.reserved_minor).toBe(0n);
    expect(block.capacity_minor).toBeLessThan(Money.parse('100', 'USDT').minor);
    const empty = await eventsOf(block.id, ['trader.side_empty']);
    expect(empty).toHaveLength(1);
    expect(empty[0]!.payload).toMatchObject({ traderId: small.traderId, side: 'SELL_USDT' });
    await traderNotificationHandler(w.app).run(empty[0]!);
    const told = (await inboxOf(small.clientId)).find((n) => n.kind === 'TRADER_SIDE_EMPTY')!;
    expect(told).toMatchObject({ title: 'Your Sell USDT side is out of capacity', href: '/traders' });
    expect(told.body).toContain('until you add USDT capacity on Traders');
    // A side with room for more orders is not announced as empty.
    expect(await eventsOf((await blockOf(usdtTrader.traderId, 'SELL_USDT')).id, ['trader.side_empty'])).toEqual([]);
  });
});

describe('a trader says how it is paid when it registers its bank account — UPI included', () => {
  async function applicant(): Promise<TraderPerson> {
    const login = await createTestClientLogin(w.t.owner, { emailVerified: true });
    return { userId: login.userId, actor: { kind: 'CLIENT', userId: login.userId, sessionId: login.sessionId }, ref: login.ref as TraderPerson['ref'] };
  }
  let accountSeq = 640000000000;
  const application = (holder: string, rails?: readonly ('UPI' | 'IMPS' | 'NEFT' | 'RTGS')[]) => ({
    fullName: holder, entityType: 'INDIVIDUAL' as const, telegram: '@p2p_trader', experience: 'BINANCE' as const,
    offersBuy: true, offersSell: true, typicalInr: '200000', dailyInr: '1500000', typicalUsdt: '2000', dailyUsdt: '15000',
    bank: { holderName: holder, bankName: 'HDFC Bank', accountNumber: String(accountSeq++), ifsc: 'HDFC0001234', ...(rails ? { rails } : {}) },
    wallet: { address: encodeTronAddress(randomBytes(20)), label: 'Trading wallet' }, confirmOwnership: true,
  });
  async function approved(who: TraderPerson, payload: ReturnType<typeof application>) {
    await runAs(w.app, applyAsTrader(who.actor, w.traderDeps), who.ref, 'trader.apply', payload);
    const clientId = (await w.app.selectFrom('client_user').select('client_id').where('user_id', '=', who.userId).executeTakeFirstOrThrow()).client_id;
    const traderId = await traderIdOf(w.app, clientId);
    for (const destination of ['BANK', 'WALLET'] as const) {
      await runAs(w.app, reviewTraderDestination(w.finance.actor), w.finance.ref, 'trader.review_destination', { traderId, destination, decision: 'VERIFY' as const });
    }
    await runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId, requiredReserve: '500' });
    const bank = await w.app.selectFrom('trader_profile as t').innerJoin('bank_account as b', 'b.id', 't.bank_account_id').select('b.rail_preferences').where('t.id', '=', traderId).executeTakeFirstOrThrow();
    const sides = await w.app.selectFrom('trader_block').select(['side', 'rails']).where('trader_id', '=', traderId).orderBy('side').execute();
    return { registered: bank.rail_preferences, sides };
  }

  it('takes UPI at registration, and the trader’s sides start out with exactly what it chose', async () => {
    const out = await approved(await applicant(), application('Asha Menon', ['UPI', 'IMPS']));
    expect(out.registered).toEqual(['UPI', 'IMPS']);
    expect(out.sides).toEqual([{ side: 'BUY_USDT', rails: ['UPI', 'IMPS'] }, { side: 'SELL_USDT', rails: ['UPI', 'IMPS'] }]);
  });

  it('a trader that unticks UPI gets no UPI on its deals from the first one', async () => {
    const out = await approved(await applicant(), application('Ravi Iyer', ['IMPS', 'NEFT', 'RTGS']));
    expect(out.sides.map((s) => s.rails)).toEqual([['IMPS', 'NEFT', 'RTGS'], ['IMPS', 'NEFT', 'RTGS']]);
  });

  it('asked nothing, every way is on — UPI too', async () => {
    const out = await approved(await applicant(), application('Neha Kapoor'));
    expect(out.registered).toEqual(['UPI', 'IMPS', 'NEFT', 'RTGS']);
    expect(out.sides.map((s) => s.rails)).toEqual([['UPI', 'IMPS', 'NEFT', 'RTGS'], ['UPI', 'IMPS', 'NEFT', 'RTGS']]);
  });

  it('an account the desk added carries nobody’s choice: its trader’s sides start with every way, as before', async () => {
    // `railsTrader` registers a desk-added account that lists IMPS only; nothing about it narrows the trader's deals.
    expect((await blockOf(inrTrader.traderId, 'BUY_USDT')).rails).toEqual(['UPI', 'IMPS', 'NEFT', 'RTGS']);
  });
});
