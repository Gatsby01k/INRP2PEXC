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
import { RAIL_NO_UPI_ID, chooseClientPayMethod, claimIncomingFiat, confirmClientReceipt, p2pDeal, reportClientPayeeName, runP2pDeadlines } from '@inrp2p/settlement';
import { applyAsTrader, confirmOrderPaymentReceived, orderDeliveryAddress, reportOrderPayeeName, submitOrderPayment } from '@inrp2p/traders';
import { settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { type TraderPerson, confirmOnChain, sendUsdt } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsTrade, railsTrader } from './rails-world.ts';

/**
 * UPI IDs as payment destinations of their own (ADR 0029, migration 0050), checked by the one who pays them (ADR 0030,
 * migration 0051), end to end on the exchange's own rails: a client or trader registers as many as it has, with no bank
 * details, and each is live at once — up to ₹25,000 until a deal to it is confirmed; a deal is paid by UPI only to a live
 * one, within its limits, fixed for the deal; its payer is told the payee's own name, says its app showed it before it says
 * it paid, or says what it showed instead — which pauses the address for a person and moves the deal to the bank account.
 */
let w: RailsWorld;
let seller: Awaited<ReturnType<typeof railsTrader>>;
let buyer: Awaited<ReturnType<typeof railsTrader>>;
/** A deal whose time to pay opened while its seller had no UPI ID. */
let noUpiDeal = '';

const utr12 = () => String(randomInt(1e11, 1e12));
const vpaOf = (name: string) => `${name}.${randomBytes(3).toString('hex')}@okhdfcbank`;
const upiRow = (id: string) => w.app.selectFrom('upi_id').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const windowOf = (tradeId: string) => w.app.selectFrom('p2p_pay_window').selectAll().where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
const eventsOf = async (aggregateId: string, types: readonly string[]): Promise<OutboxEvent[]> =>
  (await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).where('aggregate_id', '=', aggregateId).where('type', 'in', [...types]).orderBy('created_at').execute())
    .map((e) => ({ id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id }));
/** The holder of the account a payee's deal is paid to: the name a payer is told to expect. */
const holderOf = async (bankAccountId: string) => (await w.app.selectFrom('bank_account').select('holder_name').where('id', '=', bankAccountId).executeTakeFirstOrThrow()).holder_name;
const traderBank = async (t: { traderId: string }) => (await w.app.selectFrom('trader_profile').select('bank_account_id').where('id', '=', t.traderId).executeTakeFirstOrThrow()).bank_account_id!;

/** A client's administrator adds a UPI ID: live at once. Whatever name the session types is not what a payer is told. */
const add = (who: { actor: Parameters<typeof addUpiId>[0]; ref: unknown }, clientId: string, vpa: string, extra: Record<string, unknown> = {}) =>
  runAs(w.app, addUpiId(who.actor), who.ref as never, 'client_upi.add', { clientId, vpa, holderName: 'whatever the session typed', ...extra });
/** A UPI ID of this client, live, on its first deals' limit. */
async function freshUpi(who: { actor: Parameters<typeof addUpiId>[0]; ref: unknown }, clientId: string, extra: Record<string, unknown> = {}) {
  const vpa = vpaOf('pay');
  const { upiId } = await add(who, clientId, vpa, extra);
  return { upiId, vpa };
}
/** One the desk adds after looking it up: its full limits at once. */
async function deskUpi(clientId: string, holderName: string, extra: Record<string, unknown> = {}) {
  const vpa = vpaOf('desk');
  const { upiId } = await runAs(w.app, addUpiId(w.owner.actor), w.owner.ref, 'client_upi.add', { clientId, vpa, holderName, ...extra });
  return { upiId, vpa };
}
/** A client's live UPI IDs are archived between tests: each test chooses the one a deal is paid to. */
async function clearUpi(clientId: string) {
  for (const u of await w.app.selectFrom('upi_id').select('id').where('client_id', '=', clientId).where('status', 'in', ['ACTIVE', 'PENDING_REVIEW']).execute()) {
    await runAs(w.app, archiveUpiId(w.owner.actor), w.owner.ref, 'client_upi.archive', { upiId: u.id, reason: 'between tests' });
  }
}

/** A client's BUY whose seller's USDT is final in escrow: the buyer's move. 700 USDT at 106.50 is ₹74,550; 200 is ₹21,300. */
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

describe('a UPI ID is live as soon as it is added', () => {
  it('needs no bank details and no person, takes the client’s own name — not what the session typed — and starts on the first deals’ limit', async () => {
    const vpa = vpaOf('kaveri');
    const added = await add(seller.admin, seller.clientId, ` ${vpa.toUpperCase()} `, { perPaymentLimit: '50000', dailyLimit: '200000', label: 'Main' });
    expect(added.status).toBe('ACTIVE');
    const row = await upiRow(added.upiId);
    expect(row).toMatchObject({ vpa, per_payment_limit_minor: 5_000_000n, daily_limit_minor: 20_000_000n, name_confirmed_at: null, verified_name: null });
    expect(row.holder_name).toBe(await holderOf(await traderBank(seller)));
    expect(row.holder_name).not.toBe('whatever the session typed');
    // Nobody waits on it: the desk's queue is for what payers report.
    expect((await pendingUpiIds(w.app)).some((p) => p.id === added.upiId)).toBe(false);
    const [view] = (await listUpiIds(w.app, seller.clientId)).filter((u) => u.id === added.upiId);
    expect(view).toMatchObject({ status: 'ACTIVE', nameConfirmed: false, reportedName: null, perPaymentLimit: '50000.00', dailyLimit: '200000.00', usedToday: '0.00', label: 'Main' });
    // Every member hears a UPI ID is now live — the message someone who took over a session cannot hide — and its limit.
    const told = (await eventsOf(seller.clientId, ['client.destination_added'])).filter((e) => (e.payload as { id?: string }).id === added.upiId);
    expect(told).toHaveLength(1);
    await clientNotificationHandler(w.app).run(told[0]!);
    expect((await clientInbox(w.app, seller.clientId, { limit: 200 })).find((n) => n.kind === 'DESTINATION_ADDED' && n.body.includes('₹25,000'))).toMatchObject({ title: 'A UPI ID was added', href: '/destinations' });
    await clearUpi(seller.clientId);
  });

  it('refuses a made-up account address, the same live address for two clients, and limits UPI itself does not carry', async () => {
    await expect(add(seller.admin, seller.clientId, '50100123458219@hdfc0001234.ifsc.npci')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', details: { field: 'vpa' } });
    await expect(add(seller.admin, seller.clientId, vpaOf('x'), { perPaymentLimit: '100001' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', details: { field: 'perPaymentLimit' } });
    await expect(add(seller.admin, seller.clientId, vpaOf('x'), { perPaymentLimit: '50000', dailyLimit: '20000' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT', details: { field: 'dailyLimit' } });
    const shared = vpaOf('shared');
    await add(seller.admin, seller.clientId, shared);
    await expect(add(buyer.admin, buyer.clientId, shared)).rejects.toMatchObject({ code: 'DUPLICATE_DESTINATION' });
    // Only an administrator of the client adds one.
    await expect(add(seller.member, seller.clientId, vpaOf('y'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await clearUpi(seller.clientId);
  });
});

describe('a deal is paid by UPI only to the payee’s live UPI ID', () => {
  it('with none, the buyer is offered no UPI at all — never an address made up from the account number', async () => {
    const trade = await fundedBuy();
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(deal.payTo).toMatchObject({ upiId: null, upiName: null, upiLink: null });
    expect(deal.payWindow!.method).toBe('IMPS');
    expect(deal.payWindow!.methods.find((m) => m.rail === 'UPI')).toMatchObject({ possible: false, limit: RAIL_NO_UPI_ID });
    expect(JSON.stringify(deal)).not.toContain('.npci');
    await expect(runAs(w.app, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef: trade.tradeRef, method: 'UPI' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('no UPI ID') });
    // Its time to pay opens on a bank transfer, and stays so: a UPI ID added later is for the deals that open after it.
    await runP2pDeadlines(w.app);
    expect(await w.app.selectFrom('p2p_pay_window').select(['payee_upi_id', 'method']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow()).toEqual({ payee_upi_id: null, method: 'IMPS' });
    noUpiDeal = trade.tradeId;
  });

  it('a new one takes small deals only, shows the payee’s own name, is fixed for the deal — and its owner cannot archive it mid-deal', async () => {
    const { upiId, vpa } = await freshUpi(seller.admin, seller.clientId);
    const holder = await holderOf(await traderBank(seller));
    // ₹74,550 is above what an address no deal has confirmed takes: a bank transfer.
    const big = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await windowOf(big.tradeId)).payee_upi_id).toBeNull();
    // ₹21,300 is within it: UPI, to that address, with the name the payer must see — the payee's own.
    const trade = await fundedBuy(seller, '200');
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(deal.payWindow!.method).toBe('UPI');
    expect(deal.payTo).toMatchObject({ upiId: vpa, upiName: holder, upiConfirmed: false });
    expect(deal.payTo!.upiLink).toBe(`upi://pay?pa=${encodeURIComponent(vpa)}&pn=${encodeURIComponent(holder)}&am=21300.00&cu=INR&tn=${encodeURIComponent(deal.payTo!.remarks)}`);
    // The deadlines open the window on it, and the database holds the deal to it (IX146).
    await runP2pDeadlines(w.app);
    expect((await windowOf(trade.tradeId)).payee_upi_id).toBe(upiId);
    expect(await upiUsedToday(w.app, upiId)).toBe(2_130_000n);
    // A second small deal the same day would pass ₹25,000: a bank transfer.
    const second = await fundedBuy(seller, '200');
    await runP2pDeadlines(w.app);
    expect((await windowOf(second.tradeId)).payee_upi_id).toBeNull();
    // The deal opened before it was added keeps its bank transfer.
    expect((await windowOf(noUpiDeal)).payee_upi_id).toBeNull();
    // Its owner cannot pull it from under the deal; the desk can, and the deal then goes by bank transfer.
    await expect(runAs(w.app, archiveUpiId(seller.admin.actor), seller.admin.ref, 'client_upi.archive', { upiId, reason: 'switching banks' })).rejects.toMatchObject({ code: 'DESTINATION_IN_USE' });
    await runAs(w.app, archiveUpiId(w.owner.actor), w.owner.ref, 'client_upi.archive', { upiId, reason: 'reported compromised' });
    const after = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(after.payTo).toMatchObject({ upiId: null, upiLink: null });
    expect(after.payWindow!.methods.find((m) => m.rail === 'UPI')).toMatchObject({ possible: false });
  });

  it('one the desk looked up has its own limits at once: one payment above them, or the rest of its day, goes by bank transfer', async () => {
    await clearUpi(seller.clientId);
    const { upiId } = await deskUpi(seller.clientId, 'KAVERI EXPORTS LLP', { perPaymentLimit: '100000', dailyLimit: '100000' });
    expect((await upiRow(upiId)).name_confirmed_at).not.toBeNull();
    // The first deal of the day takes ₹74,550 of its ₹1,00,000; a second of the same size would pass the day's limit.
    const first = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await windowOf(first.tradeId)).payee_upi_id).toBe(upiId);
    const second = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect(await w.app.selectFrom('p2p_pay_window').select(['payee_upi_id', 'method']).where('trade_id', '=', second.tradeId).executeTakeFirstOrThrow()).toEqual({ payee_upi_id: null, method: 'IMPS' });
    // Raising the day's limit (confirmed again) lets the next deal use it.
    await runAs(w.app, updateUpiId(seller.admin.actor), seller.admin.ref, 'client_upi.update', { upiId, dailyLimit: '300000' });
    const third = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await windowOf(third.tradeId)).payee_upi_id).toBe(upiId);
    // A limit for one payment below the deal: no UPI for it.
    await runAs(w.app, updateUpiId(seller.admin.actor), seller.admin.ref, 'client_upi.update', { upiId, perPaymentLimit: '50000' });
    const fourth = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await windowOf(fourth.tradeId)).payee_upi_id).toBeNull();
    await clearUpi(seller.clientId);
  });
});

describe('the one who pays a UPI ID checks its name', () => {
  it('a client buying says its app showed the seller’s name; once the seller confirms the rupees, the address has its own limits', async () => {
    await clearUpi(seller.clientId);
    const { upiId } = await freshUpi(seller.admin, seller.clientId);
    const trade = await fundedBuy(seller, '200');
    await runP2pDeadlines(w.app);
    expect((await windowOf(trade.tradeId)).payee_upi_id).toBe(upiId);
    const claim = (p: Record<string, unknown>) =>
      runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'UPI' as const, utr: utr12(), fromBankAccountId: w.bankAccountId, ...p });
    // Paying the UPI ID without saying the name was checked is refused, with what to do.
    await expect(claim({})).rejects.toMatchObject({ code: 'UPI_NAME_UNCHECKED' });
    await expect(claim({ payeeNameConfirmed: false })).rejects.toMatchObject({ code: 'UPI_NAME_UNCHECKED' });
    await claim({ payeeNameConfirmed: true });
    expect((await windowOf(trade.tradeId)).payee_name_confirmed_at).not.toBeNull();
    expect((await upiRow(upiId)).name_confirmed_at).toBeNull();
    // The seller's bank shows the buyer's own account sent it: confirmed — and with it, the address is the seller's own.
    const out = await runAs(w.app, confirmOrderPaymentReceived(seller.admin.actor, w.traderDeps), seller.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName: await holderOf(w.bankAccountId) });
    expect(out).toMatchObject({ verdict: 'MATCH', confirmed: true });
    expect(await upiRow(upiId)).toMatchObject({ name_confirmed_trade_id: trade.tradeId, status: 'ACTIVE' });
    expect((await listUpiIds(w.app, seller.clientId)).find((u) => u.id === upiId)).toMatchObject({ nameConfirmed: true });
    // Now ₹74,550 goes to it by UPI.
    const big = await fundedBuy();
    await runP2pDeadlines(w.app);
    expect((await windowOf(big.tradeId)).payee_upi_id).toBe(upiId);
    expect((await p2pDeal(w.app, w.deps.protector, { tradeId: big.tradeId, viewer: 'CLIENT' }))!.payTo).toMatchObject({ upiConfirmed: true });
    // A payment of the same deal by bank transfer asks nothing about the UPI ID's name.
    await runAs(w.app, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef: big.tradeRef, method: 'IMPS' });
    await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: big.tradeRef, rail: 'IMPS' as const, utr: utr12(), fromBankAccountId: w.bankAccountId });
    expect((await windowOf(big.tradeId)).payee_name_confirmed_at).toBeNull();
    await clearUpi(seller.clientId);
  });

  it('another name: the address is paused for a person, the deal moves to the bank account, and the owner is told', async () => {
    await clearUpi(seller.clientId);
    const { upiId, vpa } = await freshUpi(seller.admin, seller.clientId);
    const trade = await fundedBuy(seller, '200');
    await runP2pDeadlines(w.app);
    const before = await windowOf(trade.tradeId);
    expect(before).toMatchObject({ payee_upi_id: upiId, method: 'UPI', changes: 0 });
    // Only the payer says what its app shows — and it says what it saw.
    await expect(runAs(w.app, reportOrderPayeeName(seller.admin.actor), seller.admin.ref, 'trader_order.report_name', { ref: trade.orderRef, shownName: 'SURESH PATEL' })).rejects.toMatchObject({ code: 'NOT_THE_PAYER' });
    await expect(runAs(w.app, reportClientPayeeName(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.report_name', { tradeRef: trade.tradeRef, shownName: ' ' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const moved = await runAs(w.app, reportClientPayeeName(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.report_name', { tradeRef: trade.tradeRef, shownName: 'SURESH PATEL' });
    expect(moved.method).toBe('IMPS');
    // The deal goes on: IMPS's time from the same start, not one of the buyer's three changes.
    const after = await windowOf(trade.tradeId);
    expect(after).toMatchObject({ method: 'IMPS', changes: 0, payee_upi_id: upiId });
    expect(after.due_at.getTime() - after.opened_at.getTime()).toBe(30 * 60_000);
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!;
    expect(deal.payTo).toMatchObject({ upiId: null, upiLink: null, accountNumber: expect.any(String) });
    expect(deal.payWindow!.methods.find((m) => m.rail === 'UPI')).toMatchObject({ possible: false });
    // The address is paused with what was seen, and waits for the desk.
    expect(await upiRow(upiId)).toMatchObject({ status: 'PENDING_REVIEW', reported_name: 'SURESH PATEL', reported_trade_id: trade.tradeId });
    expect((await pendingUpiIds(w.app)).find((p) => p.id === upiId)).toMatchObject({ vpa, reportedName: 'SURESH PATEL', tradeRef: trade.tradeRef });
    // Nothing more is paid to it: the next small deal goes by bank transfer.
    const next = await fundedBuy(seller, '100');
    await runP2pDeadlines(w.app);
    expect((await windowOf(next.tradeId)).payee_upi_id).toBeNull();
    // Its owner — a trader — is told, without the client's trade reference.
    const told = await eventsOf(seller.clientId, ['client.destination_paused']);
    expect(told.at(-1)!.payload).toMatchObject({ id: upiId, destination: 'UPI_ID' });
    expect(told.at(-1)!.payload).not.toHaveProperty('tradeId');
    await clientNotificationHandler(w.app).run(told.at(-1)!);
    expect((await clientInbox(w.app, seller.clientId, { limit: 200 })).find((n) => n.kind === 'DESTINATION_PAUSED')).toMatchObject({ title: 'Your UPI ID is paused', href: '/destinations' });
    // The desk looks it up: another name is never put back; the owner's own name puts it back, with its full limits.
    await expect(runAs(w.app, reviewUpiId(w.owner.actor), w.owner.ref, 'client_upi.review', { upiId, decision: 'VERIFY' as const, resolvedName: 'SURESH PATEL' })).rejects.toMatchObject({ code: 'UPI_NAME_MISMATCH' });
    expect(await runAs(w.app, reviewUpiId(w.owner.actor), w.owner.ref, 'client_upi.review', { upiId, decision: 'VERIFY' as const, resolvedName: 'KAVERI EXPORTS LLP' })).toEqual({ status: 'ACTIVE', verdict: 'MATCH' });
    expect(await upiRow(upiId)).toMatchObject({ status: 'ACTIVE', verified_name: 'KAVERI EXPORTS LLP' });
    expect((await upiRow(upiId)).name_confirmed_at).not.toBeNull();
    await clearUpi(seller.clientId);
  });

  it('a paused one the desk rejects tells its owner why, and is never paid to again', async () => {
    await clearUpi(seller.clientId);
    const { upiId } = await freshUpi(seller.admin, seller.clientId);
    const trade = await fundedBuy(seller, '150');
    await runP2pDeadlines(w.app);
    await runAs(w.app, reportClientPayeeName(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.report_name', { tradeRef: trade.tradeRef, shownName: 'MOHAN LAL' });
    await expect(runAs(w.app, reviewUpiId(w.owner.actor), w.owner.ref, 'client_upi.review', { upiId, decision: 'REJECT' as const })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await runAs(w.app, reviewUpiId(w.owner.actor), w.owner.ref, 'client_upi.review', { upiId, decision: 'REJECT' as const, note: 'It shows another person’s name.' });
    expect((await upiRow(upiId)).status).toBe('REJECTED');
    const told = await eventsOf(seller.clientId, ['client.destination_rejected']);
    await clientNotificationHandler(w.app).run(told.at(-1)!);
    expect((await clientInbox(w.app, seller.clientId, { limit: 200 })).find((n) => n.kind === 'DESTINATION_REJECTED')).toMatchObject({
      title: 'Your UPI ID was not verified', href: '/destinations', body: expect.stringContaining('It shows another person’s name.'),
    });
    // The database refuses to make it live by any other way.
    await expect(sql`update upi_id set status = 'ACTIVE' where id = ${upiId}::uuid`.execute(w.app)).rejects.toThrow();
  });

  it('a trader paying a client’s sale checks the client’s name and may pay from its own UPI ID; the client’s confirmation confirms the client’s address', async () => {
    await clearUpi(w.clientId);
    const clientUpi = await freshUpi(w.acceptor, w.clientId);
    const traderUpi = await deskUpi(buyer.clientId, 'Narmada Traders LLP');
    // ₹20,700 fits a new address.
    const trade = await railsTrade(w, buyer, { direction: 'SELL_USDT', amount: '200', clientRate: '103.500000', plannedClientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'TRADER' }))!;
    expect(deal.payTo).toMatchObject({ upiId: clientUpi.vpa, upiName: await holderOf(w.bankAccountId), upiConfirmed: false });
    const pay = (p: Record<string, unknown>) =>
      runAs(w.app, submitOrderPayment(buyer.admin.actor), buyer.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'UPI' as const, utr: utr12(), fromUpiId: traderUpi.upiId, ...p });
    await expect(pay({})).rejects.toMatchObject({ code: 'UPI_NAME_UNCHECKED' });
    // Another client's UPI ID is never the trader's.
    await expect(pay({ fromUpiId: clientUpi.upiId, payeeNameConfirmed: true })).rejects.toMatchObject({ code: 'NOT_OWN_ACCOUNT' });
    const paid = await pay({ payeeNameConfirmed: true });
    const filed = await w.app.selectFrom('fiat_transfer as f').innerJoin('transfer_allocation as a', 'a.fiat_transfer_id', 'f.id').innerJoin('settlement_leg as l', 'l.id', 'a.settlement_leg_id')
      .select(['f.payer_upi_id', 'f.payer_bank_account_id']).where('l.trade_id', '=', trade.tradeId).where('l.asset', '=', 'INR').executeTakeFirstOrThrow();
    expect(filed).toEqual({ payer_upi_id: traderUpi.upiId, payer_bank_account_id: null });
    // The client's bank shows the name the trader's UPI ID resolves to: confirmed, and the client's address is its own.
    const out = await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: trade.tradeRef, legRef: paid.settlementRef, senderName: 'NARMADA TRADERS LLP' });
    expect(out).toMatchObject({ verdict: 'MATCH', confirmed: true });
    expect(await upiRow(clientUpi.upiId)).toMatchObject({ name_confirmed_trade_id: trade.tradeId });
    await clearUpi(w.clientId);
    await clearUpi(buyer.clientId);
  });

  it('a client pays from its own UPI ID, judged by its own name; the database refuses one that is not the payer’s (IX145)', async () => {
    const mine = await freshUpi(w.acceptor, w.clientId);
    const theirs = await deskUpi(buyer.clientId, 'NARMADA TRADERS LLP');
    const trade = await fundedBuy(seller, '300');
    const claim = (p: Record<string, unknown>) =>
      runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'IMPS' as const, utr: utr12(), ...p });
    await expect(claim({ fromUpiId: theirs.upiId })).rejects.toMatchObject({ code: 'NOT_OWN_ACCOUNT' });
    await expect(claim({ fromUpiId: mine.upiId, fromBankAccountId: w.bankAccountId })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(claim({})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await claim({ fromUpiId: mine.upiId });
    // Its own UPI ID cannot be archived while that payment is being confirmed.
    await expect(runAs(w.app, archiveUpiId(w.acceptor.actor), w.acceptor.ref, 'client_upi.archive', { upiId: mine.upiId, reason: 'done' })).rejects.toMatchObject({ code: 'DESTINATION_IN_USE' });
    // The sender the seller's bank shows is judged by the client's own name — the session never typed it.
    const out = await runAs(w.app, confirmOrderPaymentReceived(seller.admin.actor, w.traderDeps), seller.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName: await holderOf(w.bankAccountId) });
    expect(out).toMatchObject({ verdict: 'MATCH', confirmed: true });
    await runAs(w.app, archiveUpiId(w.acceptor.actor), w.acceptor.ref, 'client_upi.archive', { upiId: mine.upiId, reason: 'done' });
    const route = await w.app.selectFrom('liquidity_route').select('id').where('trader_id', '=', seller.traderId).executeTakeFirstOrThrow();
    const base = { rail: 'UPI', utr: utr12(), amount_minor: 100n, payer_type: 'CLIENT', payer_id: w.clientId, payee_type: 'ROUTE', payee_id: route.id, destination_masked: 'test', recorded_by: 'test' } as const;
    await expect(w.app.insertInto('fiat_transfer').values({ ...base, payer_upi_id: theirs.upiId }).execute()).rejects.toMatchObject({ code: 'IX145' });
    await clearUpi(buyer.clientId);
  });
});

describe('a client pays from a UPI ID alone, and a trader names one when it applies', () => {
  it('a client with no bank account asks to buy once it has a UPI ID of its own', async () => {
    const c = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: 'Priya Nair', displayName: 'Priya Nair', type: 'INDIVIDUAL' as const, typicalDirection: 'BUY_USDT' as const });
    const wallet = await runAs(w.app, addWallet(w.owner.actor), w.owner.ref, 'client_wallet.add', { clientId: c.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'DESTINATION' as const, label: 'Wallet' });
    const ask = () => runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: c.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '100', walletId: wallet.walletId });
    const upi = await runAs(w.app, addUpiId(w.owner.actor), w.owner.ref, 'client_upi.add', { clientId: c.clientId, vpa: vpaOf('priya'), holderName: 'Priya Nair' });
    expect(upi.status).toBe('ACTIVE');
    expect((await ask()).ref).toMatch(/\w/);
    await runAs(w.app, archiveUpiId(w.owner.actor), w.owner.ref, 'client_upi.archive', { upiId: upi.upiId, reason: 'test' });
    await expect(ask()).rejects.toMatchObject({ code: 'PAYER_ACCOUNT_REQUIRED' });
    // Bank details are still one way: nothing else changed for a client that has them.
    await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', { clientId: c.clientId, holderName: 'Priya Nair', bankName: 'HDFC Bank', ifsc: 'HDFC0001234', accountNumber: '50100888877766' });
    expect((await ask()).ref).toMatch(/\w/);
  });

  it('a trader’s application may name a UPI ID: live at once, in the account holder’s name, and never holds up approval', async () => {
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
    expect(await listUpiIds(w.app, clientId)).toEqual([expect.objectContaining({ vpa, status: 'ACTIVE', nameConfirmed: false, holderName: 'Ravi Iyer' })]);
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
