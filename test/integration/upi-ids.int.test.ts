import { randomBytes, randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { createTestClientLogin, runAs } from '@inrp2p/identity/testing';
import { addBankAccount, addUpiId, addWallet, archiveUpiId, createClient, listUpiIds, pendingUpiIds, reviewUpiId, updateUpiId, upiUsedToday } from '@inrp2p/clients';
import { clientInbox, clientNotificationHandler } from '@inrp2p/notifications';
import type { OutboxEvent } from '@inrp2p/outbox';
import { createRequest } from '@inrp2p/quotes';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { RAIL_NO_UPI_ID, chooseClientPayMethod, claimIncomingFiat, p2pDeal, runP2pDeadlines } from '@inrp2p/settlement';
import { applyAsTrader, confirmOrderPaymentReceived, orderDeliveryAddress, submitOrderPayment } from '@inrp2p/traders';
import { settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { type TraderPerson, confirmOnChain, sendUsdt } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsTrade, railsTrader } from './rails-world.ts';

/**
 * UPI IDs as payment destinations of their own (ADR 0029, migration 0050), end to end on the exchange's own rails: a client
 * or trader registers as many as it has, with no bank details; a person verifies each against the client's own names; a
 * deal is paid by UPI only to a verified one, within its limits, fixed for the deal; a payer may say it paid from its own;
 * and an address a deal is being paid to is not archived from under it by its owner.
 */
let w: RailsWorld;
let seller: Awaited<ReturnType<typeof railsTrader>>;
let buyer: Awaited<ReturnType<typeof railsTrader>>;
/** A deal whose time to pay opened while its seller had no verified UPI ID. */
let noUpiDeal = '';

const utr12 = () => String(randomInt(1e11, 1e12));
const vpaOf = (name: string) => `${name}.${randomBytes(3).toString('hex')}@okhdfcbank`;
const statusOf = async (id: string) => (await w.app.selectFrom('upi_id').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
const eventsOf = async (aggregateId: string, types: readonly string[]): Promise<OutboxEvent[]> =>
  (await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).where('aggregate_id', '=', aggregateId).where('type', 'in', [...types]).orderBy('created_at').execute())
    .map((e) => ({ id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id }));

/** A client's administrator adds a UPI ID; it waits for a person. */
const submit = (who: { actor: Parameters<typeof addUpiId>[0]; ref: unknown }, clientId: string, vpa: string, extra: Record<string, unknown> = {}) =>
  runAs(w.app, addUpiId(who.actor), who.ref as never, 'client_upi.add', { clientId, vpa, holderName: 'whatever the session typed', ...extra });
/** The desk looks it up and records the name the app shows. */
const verify = (upiId: string, resolvedName: string, note?: string) =>
  runAs(w.app, reviewUpiId(w.owner.actor), w.owner.ref, 'client_upi.review', { upiId, decision: 'VERIFY' as const, resolvedName, ...(note ? { note } : {}) });
/** A verified UPI ID of this client, in one go. */
async function verifiedUpi(who: { actor: Parameters<typeof addUpiId>[0]; ref: unknown }, clientId: string, resolvedName: string, extra: Record<string, unknown> = {}) {
  const vpa = vpaOf('pay');
  const { upiId } = await submit(who, clientId, vpa, extra);
  await verify(upiId, resolvedName);
  return { upiId, vpa };
}

/** A client's BUY whose seller's USDT is final in escrow: the buyer's move. 700 USDT at 106.50 is ₹74,550. */
async function fundedBuy(trader = seller, amount = '700') {
  const trade = await railsTrade(w, trader, { direction: 'BUY_USDT', amount, clientRate: '106.500000', plannedClientRate: '106.500000' });
  const order = await w.app.selectFrom('trader_order').select('base_minor').where('id', '=', trade.orderId).executeTakeFirstOrThrow();
  const { address } = await runAs(w.app, orderDeliveryAddress(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
  await sendUsdt(w, trader.walletAddress, address, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
  await confirmOnChain(w);
  return trade;
}

beforeAll(async () => {
  w = await createRailsWorld('upi_ids');
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, riskPolicy: null, reason: 'UPI IDs' });
  seller = await railsTrader(w, 'Kaveri Exports', { sell: { capacity: '500000', rate: '105.20', min: '10', max: '200000' } }, '5000');
  buyer = await railsTrader(w, 'Narmada Traders', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '5000');
});
afterAll(async () => w.close());

describe('a UPI ID is registered on its own, and used by nothing until a person verifies it', () => {
  it('is added without bank details, waits for the desk, and is verified only in the client’s own name', async () => {
    const vpa = vpaOf('kaveri');
    const added = await submit(seller.admin, seller.clientId, ` ${vpa.toUpperCase()} `, { perPaymentLimit: '50000', dailyLimit: '200000', label: 'Main' });
    expect(added.status).toBe('PENDING_REVIEW');
    expect(await w.app.selectFrom('upi_id').select(['vpa', 'per_payment_limit_minor', 'daily_limit_minor']).where('id', '=', added.upiId).executeTakeFirstOrThrow())
      .toEqual({ vpa, per_payment_limit_minor: 5_000_000n, daily_limit_minor: 20_000_000n });
    expect((await pendingUpiIds(w.app)).some((p) => p.id === added.upiId && p.clientId === seller.clientId)).toBe(true);

    // The desk looks it up: the name the app shows must be the client's own, not whatever the session typed beside it.
    await expect(verify(added.upiId, 'Whatever The Session Typed')).rejects.toMatchObject({ code: 'UPI_NAME_MISMATCH' });
    await expect(verify(added.upiId, 'SURESH PATEL')).rejects.toMatchObject({ code: 'UPI_NAME_MISMATCH' });
    expect(await statusOf(added.upiId)).toBe('PENDING_REVIEW');
    // Its legal name, as a UPI app prints it, verifies it.
    expect(await verify(added.upiId, 'KAVERI EXPORTS LLP')).toEqual({ status: 'ACTIVE', verdict: 'MATCH' });
    const [view] = (await listUpiIds(w.app, seller.clientId)).filter((u) => u.id === added.upiId);
    expect(view).toMatchObject({ status: 'ACTIVE', verifiedName: 'KAVERI EXPORTS LLP', perPaymentLimit: '50000.00', dailyLimit: '200000.00', usedToday: '0.00', label: 'Main' });
    // Every member hears a UPI ID is now live — the message someone who took over a session cannot hide.
    expect(await eventsOf(seller.clientId, ['client.destination_added'])).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ destination: 'UPI_ID', id: added.upiId }) })]));
    await runAs(w.app, archiveUpiId(seller.admin.actor), seller.admin.ref, 'client_upi.archive', { upiId: added.upiId, reason: 'test setup' });
  });

  it('refuses a made-up account address, the same live address for two clients, and limits UPI itself does not carry', async () => {
    await expect(submit(seller.admin, seller.clientId, '50100123458219@hdfc0001234.ifsc.npci')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'vpa' } });
    await expect(submit(seller.admin, seller.clientId, vpaOf('x'), { perPaymentLimit: '100001' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', details: { field: 'perPaymentLimit' } });
    await expect(submit(seller.admin, seller.clientId, vpaOf('x'), { perPaymentLimit: '50000', dailyLimit: '20000' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', details: { field: 'dailyLimit' } });
    const shared = vpaOf('shared');
    await submit(seller.admin, seller.clientId, shared);
    await expect(submit(buyer.admin, buyer.clientId, shared)).rejects.toMatchObject({ code: 'DUPLICATE_DESTINATION' });
    // Only an administrator of the client adds one.
    await expect(submit(seller.member, seller.clientId, vpaOf('y'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a rejected one tells the client why, and is never paid to', async () => {
    const { upiId } = await submit(seller.admin, seller.clientId, vpaOf('wrong'));
    await expect(runAs(w.app, reviewUpiId(w.owner.actor), w.owner.ref, 'client_upi.review', { upiId, decision: 'REJECT' as const })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await runAs(w.app, reviewUpiId(w.owner.actor), w.owner.ref, 'client_upi.review', { upiId, decision: 'REJECT' as const, note: 'It shows another person’s name.' });
    expect(await statusOf(upiId)).toBe('REJECTED');
    const told = await eventsOf(seller.clientId, ['client.destination_rejected']);
    expect(told).toHaveLength(1);
    await clientNotificationHandler(w.app).run(told[0]!);
    expect((await clientInbox(w.app, seller.clientId, { limit: 200 })).find((n) => n.kind === 'DESTINATION_REJECTED')).toMatchObject({
      title: 'Your UPI ID was not verified', href: '/destinations', body: expect.stringContaining('It shows another person’s name.'),
    });
    // The database refuses to make it live by any other way.
    await expect(sql`update upi_id set status = 'ACTIVE' where id = ${upiId}::uuid`.execute(w.app)).rejects.toThrow();
  });
});

describe('a deal is paid by UPI only to the payee’s verified UPI ID', () => {
  it('with none, the buyer is offered no UPI at all — never an address made up from the account number', async () => {
    const trade = await fundedBuy();
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(deal.payTo).toMatchObject({ upiId: null, upiName: null, upiLink: null });
    expect(deal.payWindow!.method).toBe('IMPS');
    expect(deal.payWindow!.methods.find((m) => m.rail === 'UPI')).toMatchObject({ possible: false, limit: RAIL_NO_UPI_ID });
    expect(JSON.stringify(deal)).not.toContain('.npci');
    await expect(runAs(w.app, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef: trade.tradeRef, method: 'UPI' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('no verified UPI ID') });
    // Its time to pay opens on a bank transfer, and stays so: a UPI ID verified later is for the deals that open after it.
    await runP2pDeadlines(w.app);
    expect(await w.app.selectFrom('p2p_pay_window').select(['payee_upi_id', 'method']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow()).toEqual({ payee_upi_id: null, method: 'IMPS' });
    noUpiDeal = trade.tradeId;
  });

  it('with one, the buyer is shown that address and the name it resolves to, fixed for the deal — and its owner cannot archive it mid-deal', async () => {
    const { upiId, vpa } = await verifiedUpi(seller.admin, seller.clientId, 'Kaveri Exports LLP');
    const trade = await fundedBuy();
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(deal.payWindow!.method).toBe('UPI');
    expect(deal.payTo).toMatchObject({ upiId: vpa, upiName: 'Kaveri Exports LLP' });
    expect(deal.payTo!.upiLink).toBe(`upi://pay?pa=${encodeURIComponent(vpa)}&pn=Kaveri%20Exports%20LLP&am=74550.00&cu=INR&tn=${encodeURIComponent(deal.payTo!.remarks)}`);
    // The deadlines open the window on it, and the database holds the deal to it (IX146).
    await runP2pDeadlines(w.app);
    expect((await w.app.selectFrom('p2p_pay_window').select('payee_upi_id').where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow()).payee_upi_id).toBe(upiId);
    expect(await upiUsedToday(w.app, upiId)).toBe(7_455_000n);
    // The deal opened before it was verified keeps its bank transfer.
    expect((await w.app.selectFrom('p2p_pay_window').select('payee_upi_id').where('trade_id', '=', noUpiDeal).executeTakeFirstOrThrow()).payee_upi_id).toBeNull();
    // Its owner cannot pull it from under the deal; the desk can, and the deal then goes by bank transfer.
    await expect(runAs(w.app, archiveUpiId(seller.admin.actor), seller.admin.ref, 'client_upi.archive', { upiId, reason: 'switching banks' })).rejects.toMatchObject({ code: 'DESTINATION_IN_USE' });
    await runAs(w.app, archiveUpiId(w.owner.actor), w.owner.ref, 'client_upi.archive', { upiId, reason: 'reported compromised' });
    const after = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(after.payTo).toMatchObject({ upiId: null, upiLink: null });
    expect(after.payWindow!.methods.find((m) => m.rail === 'UPI')).toMatchObject({ possible: false });
  });

  it('respects its limits: one payment above it, or the rest of its day, goes by bank transfer', async () => {
    const { upiId } = await verifiedUpi(seller.admin, seller.clientId, 'KAVERI EXPORTS LLP', { perPaymentLimit: '100000', dailyLimit: '100000' });
    // The first deal of the day takes ₹74,550 of its ₹1,00,000; a second of the same size would pass the day's limit.
    const first = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await w.app.selectFrom('p2p_pay_window').select('payee_upi_id').where('trade_id', '=', first.tradeId).executeTakeFirstOrThrow()).payee_upi_id).toBe(upiId);
    const second = await fundedBuy();
    await runP2pDeadlines(w.app);
    const window = await w.app.selectFrom('p2p_pay_window').select(['payee_upi_id', 'method']).where('trade_id', '=', second.tradeId).executeTakeFirstOrThrow();
    expect(window).toEqual({ payee_upi_id: null, method: 'IMPS' });
    // Raising the day's limit (confirmed again) lets the next deal use it.
    await runAs(w.app, updateUpiId(seller.admin.actor), seller.admin.ref, 'client_upi.update', { upiId, dailyLimit: '300000' });
    const third = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await w.app.selectFrom('p2p_pay_window').select('payee_upi_id').where('trade_id', '=', third.tradeId).executeTakeFirstOrThrow()).payee_upi_id).toBe(upiId);
    // A limit for one payment below the deal: no UPI for it.
    await runAs(w.app, updateUpiId(seller.admin.actor), seller.admin.ref, 'client_upi.update', { upiId, perPaymentLimit: '50000' });
    const fourth = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await w.app.selectFrom('p2p_pay_window').select('payee_upi_id').where('trade_id', '=', fourth.tradeId).executeTakeFirstOrThrow()).payee_upi_id).toBeNull();
  });
});

describe('a payer may say it paid from its own verified UPI ID', () => {
  it('a client buying files its payment from its UPI ID, and its seller confirms the name that address shows', async () => {
    const mine = await verifiedUpi(w.acceptor, w.clientId, 'ACME PAY PRIVATE LIMITED');
    const theirs = await verifiedUpi(buyer.admin, buyer.clientId, 'NARMADA TRADERS LLP');
    const trade = await fundedBuy();
    const claim = (p: Record<string, unknown>) =>
      runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'UPI' as const, utr: utr12(), ...p });
    await expect(claim({ fromUpiId: theirs.upiId })).rejects.toMatchObject({ code: 'NOT_OWN_ACCOUNT' });
    await expect(claim({ fromUpiId: mine.upiId, fromBankAccountId: w.bankAccountId })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(claim({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await claim({ fromUpiId: mine.upiId });
    const filed = await w.app.selectFrom('fiat_transfer as f').innerJoin('transfer_allocation as a', 'a.fiat_transfer_id', 'f.id').innerJoin('settlement_leg as l', 'l.id', 'a.settlement_leg_id')
      .select(['f.payer_upi_id', 'f.payer_bank_account_id']).where('l.trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(filed).toEqual({ payer_upi_id: mine.upiId, payer_bank_account_id: null });
    // Its own UPI ID cannot be archived while that payment is being confirmed.
    await expect(runAs(w.app, archiveUpiId(w.acceptor.actor), w.acceptor.ref, 'client_upi.archive', { upiId: mine.upiId, reason: 'done' })).rejects.toMatchObject({ code: 'DESTINATION_IN_USE' });
    // The seller's bank shows the name the UPI ID resolves to: that is the buyer's own, and the escrow releases.
    const out = await runAs(w.app, confirmOrderPaymentReceived(seller.admin.actor, w.traderDeps), seller.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName: 'ACME PAY PRIVATE LIMITED' });
    expect(out).toMatchObject({ verdict: 'MATCH', confirmed: true });
    // Confirmed, the payment no longer holds it: its owner may archive it now.
    await runAs(w.app, archiveUpiId(w.acceptor.actor), w.acceptor.ref, 'client_upi.archive', { upiId: mine.upiId, reason: 'done' });
  });

  it('a trader paying a client’s sale declares its own UPI ID, and the client is paid to the client’s', async () => {
    const clientUpi = await verifiedUpi(w.acceptor, w.clientId, 'Acme Pay Private Limited');
    const traderUpi = await verifiedUpi(buyer.admin, buyer.clientId, 'Narmada Traders LLP');
    const trade = await railsTrade(w, buyer, { direction: 'SELL_USDT', amount: '500', clientRate: '103.500000', plannedClientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    // The trader pays: it is shown the client's verified UPI ID (₹51,750 is UPI's by the amount).
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'TRADER' }))!;
    expect(deal.payTo).toMatchObject({ upiId: expect.any(String), upiName: 'Acme Pay Private Limited' });
    expect(deal.payTo!.upiId).toBe((await w.app.selectFrom('upi_id').select('vpa').where('id', '=', clientUpi.upiId).executeTakeFirstOrThrow()).vpa);
    await runAs(w.app, submitOrderPayment(buyer.admin.actor), buyer.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'UPI' as const, utr: utr12(), fromUpiId: traderUpi.upiId });
    const filed = await w.app.selectFrom('fiat_transfer as f').innerJoin('transfer_allocation as a', 'a.fiat_transfer_id', 'f.id').innerJoin('settlement_leg as l', 'l.id', 'a.settlement_leg_id')
      .select(['f.payer_upi_id', 'f.payer_bank_account_id']).where('l.trade_id', '=', trade.tradeId).where('l.asset', '=', 'INR').executeTakeFirstOrThrow();
    expect(filed).toEqual({ payer_upi_id: traderUpi.upiId, payer_bank_account_id: null });
    // Another client's UPI ID is never the trader's.
    const other = await railsTrade(w, buyer, { direction: 'SELL_USDT', amount: '300', clientRate: '103.500000', plannedClientRate: '103.500000' });
    await settleFirstLeg(w, other.tradeId);
    await expect(runAs(w.app, submitOrderPayment(buyer.admin.actor), buyer.admin.ref, 'trader_order.submit_payment', { ref: other.orderRef, rail: 'UPI' as const, utr: utr12(), fromUpiId: clientUpi.upiId }))
      .rejects.toMatchObject({ code: 'NOT_OWN_ACCOUNT' });
  });

  it('the database refuses a payment declared from two sources, or from a UPI ID that is not the payer’s (IX145)', async () => {
    const someone = await verifiedUpi(buyer.admin, buyer.clientId, 'NARMADA TRADERS LLP');
    const route = await w.app.selectFrom('liquidity_route').select('id').where('trader_id', '=', seller.traderId).executeTakeFirstOrThrow();
    const base = { rail: 'UPI', utr: utr12(), amount_minor: 100n, payer_type: 'CLIENT', payer_id: w.clientId, payee_type: 'ROUTE', payee_id: route.id, destination_masked: 'test', recorded_by: 'test' } as const;
    await expect(w.app.insertInto('fiat_transfer').values({ ...base, payer_upi_id: someone.upiId }).execute()).rejects.toMatchObject({ code: 'IX145' });
  });
});

describe('a client pays from a verified UPI ID alone, and a trader names one when it applies', () => {
  it('a client with no bank account asks to buy once a UPI ID of its own is verified — not while it waits', async () => {
    const c = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: 'Priya Nair', displayName: 'Priya Nair', type: 'INDIVIDUAL' as const, typicalDirection: 'BUY_USDT' as const });
    const wallet = await runAs(w.app, addWallet(w.owner.actor), w.owner.ref, 'client_wallet.add', { clientId: c.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'DESTINATION' as const, label: 'Wallet' });
    const ask = () => runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: c.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '100', walletId: wallet.walletId });
    const upi = await runAs(w.app, addUpiId(w.owner.actor), w.owner.ref, 'client_upi.add', { clientId: c.clientId, vpa: vpaOf('priya'), holderName: 'Priya Nair' });
    // The desk adding one is the desk's own verification: live at once.
    expect(upi.status).toBe('ACTIVE');
    expect((await ask()).ref).toMatch(/\w/);
    await runAs(w.app, archiveUpiId(w.owner.actor), w.owner.ref, 'client_upi.archive', { upiId: upi.upiId, reason: 'test' });
    await expect(ask()).rejects.toMatchObject({ code: 'PAYER_ACCOUNT_REQUIRED' });
    // Bank details are still one way: nothing else changed for a client that has them.
    await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', { clientId: c.clientId, holderName: 'Priya Nair', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100888877766' });
    expect((await ask()).ref).toMatch(/\w/);
  });

  it('a trader’s application may name a UPI ID: it waits for the desk on its own, and never holds up approval', async () => {
    const login = await createTestClientLogin(w.t.owner, { emailVerified: true, stepUp: 'fresh' });
    const who: TraderPerson = { userId: login.userId, actor: { kind: 'CLIENT', userId: login.userId, sessionId: login.sessionId }, ref: login.ref as TraderPerson['ref'] };
    const vpa = vpaOf('ravi');
    await runAs(w.app, applyAsTrader(who.actor, w.traderDeps), who.ref, 'trader.apply', {
      fullName: 'Ravi Iyer', entityType: 'INDIVIDUAL' as const, telegram: '@ravi_p2p', experience: 'BINANCE' as const,
      offersBuy: false, offersSell: true, typicalUsdt: '2000', dailyUsdt: '15000',
      bank: { holderName: 'Ravi Iyer', bankName: 'HDFC Bank', accountNumber: String(650000000000 + randomInt(1e6)), ifsc: 'HDFC0001234' },
      wallet: { address: encodeTronAddress(randomBytes(20)), label: 'Trading wallet' }, upi: { vpa: ` ${vpa} ` }, confirmOwnership: true,
    });
    const clientId = (await w.app.selectFrom('client_user').select('client_id').where('user_id', '=', who.userId).executeTakeFirstOrThrow()).client_id;
    const ids = await listUpiIds(w.app, clientId);
    expect(ids).toEqual([expect.objectContaining({ vpa, status: 'PENDING_REVIEW', holderName: 'Ravi Iyer' })]);
    // The desk verifies it against the applicant's own name.
    expect(await verify(ids[0]!.id, 'RAVI IYER')).toEqual({ status: 'ACTIVE', verdict: 'MATCH' });
    // Someone else's address on an application is refused, and nothing of the application is written.
    const other = await createTestClientLogin(w.t.owner, { emailVerified: true, stepUp: 'fresh' });
    await expect(runAs(w.app, applyAsTrader({ kind: 'CLIENT', userId: other.userId, sessionId: other.sessionId }, w.traderDeps), other.ref as TraderPerson['ref'], 'trader.apply', {
      fullName: 'Not Ravi', entityType: 'INDIVIDUAL' as const, telegram: '@not_ravi', experience: 'NONE' as const, offersBuy: false, offersSell: true, typicalUsdt: '10', dailyUsdt: '10',
      bank: { holderName: 'Not Ravi', bankName: 'HDFC Bank', accountNumber: String(660000000000 + randomInt(1e6)), ifsc: 'HDFC0001234' },
      wallet: { address: encodeTronAddress(randomBytes(20)), label: 'w' }, upi: { vpa }, confirmOwnership: true,
    })).rejects.toMatchObject({ code: 'DUPLICATE_DESTINATION' });
    expect(await w.app.selectFrom('client_user').select('id').where('user_id', '=', other.userId).execute()).toEqual([]);
  });
});
