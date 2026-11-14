import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { DEFAULT_P2P_TIMING, Money } from '@inrp2p/kernel';
import { executeCommand } from '@inrp2p/commands';
import { createTestOperator, runAs, type TestOperator } from '@inrp2p/identity/testing';
import type { OutboxEvent } from '@inrp2p/outbox';
import { clientInbox, clientNotificationHandler, traderNotificationHandler } from '@inrp2p/notifications';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { addUpiId } from '@inrp2p/clients';
import {
  type DealAttachment, attachmentRef, callClientSupport, chatSideOf, chooseClientPayMethod, claimIncomingFiat, dealChatView, dealFile, deskDealChat, p2pDeal,
  postClientDealMessage, postDeskDealMessage, runP2pDeadlines,
} from '@inrp2p/settlement';
import { callOrderSupport, chooseOrderPayMethod, orderDeliveryAddress, postOrderDealMessage, submitOrderPayment } from '@inrp2p/traders';
import { settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { confirmOnChain, sendUsdt, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsTrade, railsTrader } from './rails-world.ts';

/**
 * ADR 0023 end to end on the exchange's own rails: a P2P deal's private chat — who may read and write it, what it takes
 * as a file, calling INRP2P in — and the buyer's time to pay by rail: chosen, bounded, warned, a final period, and never
 * a cancellation once the rupees are said to be sent. The chat moves no money; only the payee's confirmation does.
 */
let w: RailsWorld;
let usdtTrader: Awaited<ReturnType<typeof railsTrader>>;
let inrTrader: Awaited<ReturnType<typeof railsTrader>>;
let support: TestOperator;
let readOnly: TestOperator;

const PNG = (extra = 64) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: extra }, (_, i) => i % 251)]);
const file = (bytes: Uint8Array, name = 'receipt.png', type = 'image/png'): DealAttachment => ({ name, type, bytes });
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select(['lifecycle_state', 'hold']).where('id', '=', tradeId).executeTakeFirstOrThrow());
const refOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('ref').where('id', '=', tradeId).executeTakeFirstOrThrow()).ref;
/** This deal's own events of these types, as the dispatcher hands them to a handler. */
const eventsOf = async (tradeId: string, types: readonly string[]): Promise<OutboxEvent[]> =>
  (await w.app.selectFrom('outbox_event').select(['id', 'type', 'aggregate_type', 'aggregate_id', 'payload', 'correlation_id']).where('aggregate_id', '=', tradeId).where('type', 'in', [...types]).orderBy('created_at').execute())
    .map((e) => ({ id: e.id, type: e.type, aggregateType: e.aggregate_type, aggregateId: e.aggregate_id, payload: e.payload, correlationId: e.correlation_id }));
const windowOf = (tradeId: string) => w.app.selectFrom('p2p_pay_window').selectAll().where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
const at = async (minutes: number) => {
  const clock = await w.t.pinnedClock();
  await clock.set(new Date(Date.now() + minutes * 60_000));
  return clock;
};

/** A client's BUY whose trader's USDT is final in escrow: the client's move. ₹74,550 is UPI's; ₹1,06,500 IMPS's. */
async function fundedBuy(amount = '700') {
  const trade = await railsTrade(w, usdtTrader, { direction: 'BUY_USDT', amount, clientRate: '106.500000', plannedClientRate: '106.500000' });
  const order = await w.app.selectFrom('trader_order').select('base_minor').where('id', '=', trade.orderId).executeTakeFirstOrThrow();
  const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
  await sendUsdt(w, usdtTrader.walletAddress, address, Money.ofMinor(order.base_minor, 'USDT').toDecimalString());
  await confirmOnChain(w);
  return { ...trade, tradeRef: await refOf(trade.tradeId) };
}

const clientPost = (tradeRef: string, p: { body?: string; file?: DealAttachment; legRef?: string }, who = w.acceptor, key: string = randomUUID()) =>
  runAs(w.app, postClientDealMessage(who.actor, p.file), who.ref, 'deal_chat.post', { tradeRef, body: p.body ?? null, file: p.file ? attachmentRef(p.file) : null, legRef: p.legRef ?? null }, key);

beforeAll(async () => {
  w = await createRailsWorld('deal_chat_timing');
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, riskPolicy: null, reason: 'P2P escrow' });
  usdtTrader = await railsTrader(w, 'USDT Seller', { sell: { capacity: '500000', rate: '105.20', min: '10', max: '200000' } }, '5000');
  // ADR 0029: buyers pay the seller by UPI only to a verified UPI ID of its own — the desk adds one, live at once.
  await runAs(w.app, addUpiId(w.owner.actor), w.owner.ref, 'client_upi.add', { clientId: usdtTrader.clientId, vpa: 'usdt.seller.chat@okaxis', holderName: 'USDT Seller LLP' });
  inrTrader = await railsTrader(w, 'INR Payer', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '5000');
  support = await createTestOperator(w.t.owner, ['SUPPORT']);
  readOnly = await createTestOperator(w.t.owner, ['READ_ONLY']);
});
afterAll(async () => w.close());

describe('the chat of a P2P deal', () => {
  it('is the two sides’ and INRP2P’s — each sees the other by its role only — and moves no money', async () => {
    const t = await fundedBuy();
    const before = await stateOf(t.tradeId);
    await clientPost(t.tradeRef, { body: 'Paying by UPI in two minutes' });
    await runAs(w.app, postOrderDealMessage(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader_order.chat', { ref: t.orderRef, body: 'OK, waiting' });
    // A member without authority to accept quotes still talks for its side.
    await clientPost(t.tradeRef, { body: 'Done' }, w.viewer);

    const mine = await dealChatView(w.app, { tradeId: t.tradeId, viewer: 'CLIENT' });
    expect(mine).toMatchObject({ you: 'BUYER', canPost: true, support: 'NONE' });
    expect(mine.messages.map((m) => [m.from, m.body])).toEqual([['YOU', 'Paying by UPI in two minutes'], ['SELLER', 'OK, waiting'], ['YOU', 'Done']]);
    const theirs = await dealChatView(w.app, { tradeId: t.tradeId, viewer: 'TRADER' });
    expect(theirs.messages.map((m) => m.from)).toEqual(['BUYER', 'YOU', 'BUYER']);
    // Never a name, an email or a person on either side's screen.
    expect(JSON.stringify(theirs)).not.toMatch(/@|Acme|USDT Seller/);
    // Each side hears of the other's messages, never of its own.
    const events = await w.app.selectFrom('outbox_event').select(['type', 'payload']).where('aggregate_id', '=', t.tradeId).where('type', 'in', ['p2p.message_posted', 'trader.p2p_message_posted']).execute();
    expect(events.filter((e) => e.type === 'trader.p2p_message_posted')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'p2p.message_posted')).toHaveLength(1);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain('Paying by UPI');
    // The deal is exactly where it was.
    expect(await stateOf(t.tradeId)).toEqual(before);
    expect(await w.app.selectFrom('settlement_leg').select('id').where('trade_id', '=', t.tradeId).where('asset', '=', 'INR').execute()).toEqual([]);
  });

  it('refuses everyone who is not a side of the deal', async () => {
    const t = await fundedBuy();
    // Another trader's people: not the trade's client, not its trader.
    await expect(runAs(w.app, postClientDealMessage(inrTrader.admin.actor), inrTrader.admin.ref, 'deal_chat.post', { tradeRef: t.tradeRef, body: 'hi' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runAs(w.app, postOrderDealMessage(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.chat', { ref: t.orderRef, body: 'hi' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runAs(w.app, callOrderSupport(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.call_support', { ref: t.orderRef })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // An operator who does not work cases does not write in a deal's chat.
    await expect(runAs(w.app, postDeskDealMessage(readOnly.actor), readOnly.ref, 'deal_chat.post', { tradeId: t.tradeId, body: 'hi' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await chatSideOf(w.app, { tradeId: t.tradeId, userId: w.acceptor.userId })).toBe('CLIENT');
    expect(await chatSideOf(w.app, { tradeId: t.tradeId, userId: usdtTrader.admin.userId })).toBe('TRADER');
    expect(await chatSideOf(w.app, { tradeId: t.tradeId, userId: inrTrader.admin.userId })).toBeNull();
  });

  it('takes a picture or a PDF, judged by its bytes, kept private and whole — and nothing else', async () => {
    const t = await fundedBuy();
    const png = file(PNG());
    const sent = await clientPost(t.tradeRef, { file: png });
    const row = await w.app.selectFrom('deal_message as m').innerJoin('deal_file as f', 'f.id', 'm.file_id').select(['f.id', 'f.content_type', 'f.sha256', 'f.name']).where('m.id', '=', sent.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ content_type: 'image/png', sha256: attachmentRef(png).sha256, name: 'receipt.png' });
    expect((await dealFile(w.app, { fileId: row.id }))!.body.equals(Buffer.from(png.bytes))).toBe(true);
    // An HTML page that calls itself a PNG is not one.
    await expect(clientPost(t.tradeRef, { file: file(new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'x.png') })).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    await expect(clientPost(t.tradeRef, { file: file(PNG(3 * 1024 * 1024)) })).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    // A path in the name is never kept.
    const named = await clientPost(t.tradeRef, { file: file(PNG(8), '../../etc/passwd.png') });
    expect((await w.app.selectFrom('deal_message as m').innerJoin('deal_file as f', 'f.id', 'm.file_id').select('f.name').where('m.id', '=', named.id).executeTakeFirstOrThrow()).name).toBe('passwd.png');
    // The bytes must be the ones the payload names.
    await expect(runAs(w.app, postClientDealMessage(w.acceptor.actor, file(PNG(10))), w.acceptor.ref, 'deal_chat.post', { tradeRef: t.tradeRef, file: attachmentRef(file(PNG(11))) }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // Append-only, even for the application.
    await expect(sql`delete from deal_file where id = ${row.id}::uuid`.execute(w.app)).rejects.toThrow();
    await expect(sql`update deal_message set body = 'changed' where id = ${sent.id}::uuid`.execute(w.app)).rejects.toThrow();
  });

  it('writes once for one press, and refuses a different file under the same press', async () => {
    const t = await fundedBuy();
    const key = randomUUID();
    const one = await clientPost(t.tradeRef, { body: 'once', file: file(PNG(20)) }, w.acceptor, key);
    const again = await clientPost(t.tradeRef, { body: 'once', file: file(PNG(20)) }, w.acceptor, key);
    expect(again.id).toBe(one.id);
    expect((await dealChatView(w.app, { tradeId: t.tradeId, viewer: 'CLIENT' })).messages).toHaveLength(1);
    await expect(clientPost(t.tradeRef, { body: 'once', file: file(PNG(21)) }, w.acceptor, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('attaches a receipt only to the payer’s own payment — and a receipt is never a confirmation', async () => {
    const t = await fundedBuy();
    const claimed = await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: t.tradeRef, rail: 'UPI' as const, utr: utr(), fromBankAccountId: w.bankAccountId, payeeNameConfirmed: true });
    await clientPost(t.tradeRef, { file: file(PNG()), legRef: claimed.legRef });
    await expect(clientPost(t.tradeRef, { body: 'no file', legRef: claimed.legRef })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // The trader is the payee of this payment: its receipt it is not.
    await expect(runAs(w.app, postOrderDealMessage(usdtTrader.admin.actor, file(PNG())), usdtTrader.admin.ref, 'trader_order.chat', { ref: t.orderRef, file: attachmentRef(file(PNG())), legRef: claimed.legRef }))
      .rejects.toMatchObject({ code: 'NOT_THE_PAYER' });
    const seen = await p2pDeal(w.app, null, { tradeId: t.tradeId, viewer: 'TRADER' });
    expect(seen!.chat.messages).toMatchObject([{ kind: 'RECEIPT', from: 'BUYER', paymentRef: claimed.legRef }]);
    // The payment waits for the seller's own confirmation: nothing was confirmed, nothing released.
    expect(seen).toMatchObject({ step: 'CONFIRM', turn: 'SELLER' });
    expect(await w.app.selectFrom('settlement_leg').select('status').where('ref', '=', claimed.legRef).executeTakeFirstOrThrow()).toEqual({ status: 'PROCESSING' });
    expect(await w.app.selectFrom('chain_send').select('id').where('trade_id', '=', t.tradeId).where('purpose', '=', 'CLIENT_PAYOUT').execute()).toEqual([]);
  });

  it('calls INRP2P in once, as a case and never a hold; support joins the same chat', async () => {
    const t = await fundedBuy();
    const call = await runAs(w.app, callClientSupport(w.acceptor.actor), w.acceptor.ref, 'deal_chat.call_support', { tradeRef: t.tradeRef, note: 'The account name looks different' });
    expect(call.called).toBe(true);
    expect(await runAs(w.app, callOrderSupport(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader_order.call_support', { ref: t.orderRef })).toEqual({ ref: call.ref, called: false });
    const cases = await w.app.selectFrom('exception_case').select(['type', 'severity', 'status']).where('trade_id', '=', t.tradeId).execute();
    expect(cases).toEqual([{ type: 'P2P_SUPPORT', severity: 'WARNING', status: 'OPEN' }]);
    expect((await stateOf(t.tradeId)).hold).toBe(false);
    expect((await dealChatView(w.app, { tradeId: t.tradeId, viewer: 'TRADER' })).support).toBe('CALLED');

    await runAs(w.app, postDeskDealMessage(support.actor), support.ref, 'deal_chat.post', { tradeId: t.tradeId, body: 'Pay to exactly the account shown here.' });
    const chat = await dealChatView(w.app, { tradeId: t.tradeId, viewer: 'CLIENT' });
    expect(chat.support).toBe('JOINED');
    expect(chat.messages.map((m) => [m.from, m.kind])).toEqual([['YOU', 'SUPPORT_CALLED'], ['INRP2P', 'SUPPORT_JOINED'], ['INRP2P', 'TEXT']]);
    // INRP2P's people see who wrote what; the sides never do.
    const desk = (await deskDealChat(w.app, t.tradeId))!;
    expect(desk).toMatchObject({ clientIs: 'BUYER', support: { ref: call.ref, joined: true } });
    expect(desk.messages[0]).toMatchObject({ author: 'CLIENT', person: expect.any(String) });
    // A second answer does not say "joined" again.
    await runAs(w.app, postDeskDealMessage(support.actor), support.ref, 'deal_chat.post', { tradeId: t.tradeId, body: 'Anything else?' });
    expect((await dealChatView(w.app, { tradeId: t.tradeId, viewer: 'CLIENT' })).messages.filter((m) => m.kind === 'SUPPORT_JOINED')).toHaveLength(1);
  });

  it('tells the other side once per conversation, not once per message', async () => {
    const t = await fundedBuy();
    for (const body of ['one', 'two', 'three']) await runAs(w.app, postOrderDealMessage(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader_order.chat', { ref: t.orderRef, body });
    const client = clientNotificationHandler(w.app);
    for (const e of await eventsOf(t.tradeId, ['p2p.message_posted'])) await client.run(e);
    // The trader wrote these: its own inbox hears nothing of them.
    const trader = traderNotificationHandler(w.app);
    for (const e of await eventsOf(t.tradeId, ['trader.p2p_message_posted'])) await trader.run(e);
    expect(await eventsOf(t.tradeId, ['trader.p2p_message_posted'])).toEqual([]);
    const told = (await clientInbox(w.app, w.clientId, { limit: 200 })).filter((n) => n.kind === 'DEAL_MESSAGE' && n.subjectRef === t.tradeRef);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: 'New message from the seller', href: `/trades/${t.tradeRef}` });
    expect(told[0]!.body).not.toMatch(/one|two|three/);
  });
});

describe('the buyer’s time to pay, by rail', () => {
  it('opens with the rail the amount suggests, and shows the payer exactly where and how to pay', async () => {
    const t = await fundedBuy('700');
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: t.tradeId, viewer: 'CLIENT' }))!;
    expect(deal).toMatchObject({ step: 'PAY', turn: 'BUYER', inr: '74550.00' });
    expect(deal.payWindow).toMatchObject({ method: 'UPI', chosen: false, final: false, changesLeft: 3 });
    expect(deal.payWindow!.methods.map((m) => [m.rail, m.minutes, m.possible])).toEqual([['UPI', 15, true], ['IMPS', 30, true], ['NEFT', 60, true], ['RTGS', 45, false]]);
    expect(Date.parse(deal.dueBy!) - Date.parse(deal.now)).toBeGreaterThan(14 * 60_000);
    // ADR 0029: UPI goes to the seller's own verified UPI ID, with the name it resolves to — never to its account's address.
    expect(deal.payTo).toMatchObject({ ifscValid: true, remarks: `INRP2P ${t.orderRef}`, upiId: 'usdt.seller.chat@okaxis', upiName: 'USDT Seller LLP' });
    expect(deal.payTo!.upiLink).toMatch(/^upi:\/\/pay\?pa=usdt\.seller\.chat%40okaxis&pn=USDT%20Seller%20LLP&am=74550\.00&cu=INR&tn=INRP2P%20/);
    // The payee is never shown its own account to pay; it sees how the buyer pays and until when.
    const seller = (await p2pDeal(w.app, w.deps.protector, { tradeId: t.tradeId, viewer: 'TRADER' }))!;
    expect(seller.payTo).toBeNull();
    expect(seller.payWindow!.method).toBe('UPI');
    // Above UPI's limit: no UPI code, and the bank rails come first.
    const big = (await p2pDeal(w.app, w.deps.protector, { tradeId: (await fundedBuy('3000')).tradeId, viewer: 'CLIENT' }))!;
    expect(big.payTo!.upiLink).toBeNull();
    expect(big.payWindow!.methods.map((m) => [m.rail, m.possible])).toEqual([['IMPS', true], ['RTGS', true], ['NEFT', true], ['UPI', false]]);
  });

  it('lets the buyer choose a slower rail, never past the slowest, a few times at most, and never the seller', async () => {
    const t = await fundedBuy('700');
    const choose = (method: string, db = w.app) => runAs(db, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef: t.tradeRef, method });
    await expect(choose('RTGS')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runAs(w.app, chooseOrderPayMethod(usdtTrader.admin.actor), usdtTrader.admin.ref, 'trader_order.choose_method', { ref: t.orderRef, method: 'NEFT' })).rejects.toMatchObject({ code: 'NOT_THE_PAYER' });
    const neft = await choose('NEFT');
    const window = await w.app.selectFrom('p2p_pay_window').selectAll().where('trade_id', '=', t.tradeId).executeTakeFirstOrThrow();
    expect(window.due_at.getTime() - window.opened_at.getTime()).toBe(60 * 60_000);
    expect(neft).toMatchObject({ method: 'NEFT', changed: true });
    expect(await choose('NEFT')).toMatchObject({ changed: false });
    // Twenty minutes on: UPI's fifteen are over; IMPS's thirty are not.
    const later = await at(20);
    await expect(choose('UPI', later.db)).rejects.toMatchObject({ code: 'P2P_METHOD_TOO_LATE' });
    await choose('IMPS', later.db);
    await choose('NEFT', later.db);
    await expect(choose('IMPS', later.db)).rejects.toMatchObject({ code: 'P2P_METHOD_LOCKED' });
    // The database itself refuses a window longer than its method's time.
    await expect(sql`update p2p_pay_window set due_at = due_at + interval '1 day', final_until = final_until + interval '1 day' where trade_id = ${t.tradeId}::uuid`.execute(w.app)).rejects.toThrow(/method/);
  });

  it('warns once when the time is up, gives the final period, and only then cancels — the trader’s USDT goes back', async () => {
    const t = await fundedBuy('700');
    expect((await runP2pDeadlines(w.app)).failures).toEqual([]);
    expect((await windowOf(t.tradeId)).warned_at).toBeNull();
    expect((await runP2pDeadlines((await at(16)).db)).failures).toEqual([]);
    expect((await windowOf(t.tradeId)).warned_at).not.toBeNull();
    await runP2pDeadlines((await at(17)).db);
    const told = await eventsOf(t.tradeId, ['p2p.pay_final_call', 'trader.p2p_pay_final_call']);
    expect(told.map((e) => e.type).sort()).toEqual(['p2p.pay_final_call', 'trader.p2p_pay_final_call']);
    // Both sides are told in their own words: the buyer to file now or not pay, the seller that its USDT comes back.
    const client = clientNotificationHandler(w.app);
    for (const e of told) await client.run(e);
    expect((await clientInbox(w.app, w.clientId, { limit: 200 })).find((n) => n.kind === 'P2P_PAY_FINAL' && n.subjectRef === t.tradeRef)).toMatchObject({ title: 'Your time to pay is up' });
    const deal = (await p2pDeal((await at(17)).db, null, { tradeId: t.tradeId, viewer: 'CLIENT' }))!;
    expect(deal.payWindow!.final).toBe(true);
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('AWAITING_FIRST_LEG');
    // The final period counts from the warning: at 20 minutes it still runs; after it the deal is cancelled.
    await runP2pDeadlines((await at(20)).db);
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('AWAITING_FIRST_LEG');
    expect((await runP2pDeadlines((await at(22)).db)).failures).toEqual([]);
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('CANCELLED');
  });

  it('never cancels once the buyer said it paid — in the final period too — and hands a late receipt to INRP2P by rail', async () => {
    const t = await fundedBuy('700');
    await runP2pDeadlines((await at(16)).db);
    const claim = await runAs((await at(18)).db, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: t.tradeRef, rail: 'NEFT' as const, utr: `HDFCN${Date.now().toString().slice(-11)}`, fromBankAccountId: w.bankAccountId });
    await runP2pDeadlines((await at(60)).db);
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('FIRST_LEG_DETECTED');
    await expect(runAs(w.app, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef: t.tradeRef, method: 'IMPS' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // NEFT is given longer to land: three hours by default, not thirty minutes.
    const overdue = () => w.app.selectFrom('exception_case').select('status').where('type', '=', 'P2P_RECEIPT_OVERDUE').where('trade_id', '=', t.tradeId).execute();
    await runP2pDeadlines((await at(120)).db);
    expect(await overdue()).toEqual([]);
    expect((await p2pDeal((await at(120)).db, null, { tradeId: t.tradeId, viewer: 'TRADER' }))!).toMatchObject({ step: 'CONFIRM', receiptLate: false });
    expect((await runP2pDeadlines((await at(240)).db)).failures).toEqual([]);
    expect(await overdue()).toEqual([{ status: 'OPEN' }]);
    expect((await p2pDeal((await at(240)).db, null, { tradeId: t.tradeId, viewer: 'CLIENT' }))!).toMatchObject({ step: 'CONFIRM', receiptLate: true, dueBy: null });
    const told = await w.app.selectFrom('outbox_event').select('type').where('aggregate_id', '=', t.tradeId).where('type', 'in', ['p2p.receipt_late', 'trader.p2p_receipt_late']).execute();
    expect(told).toHaveLength(2);
    // Days later still nothing is undone for time: the payee answers, or INRP2P decides.
    await runP2pDeadlines((await at(5 * 24 * 60)).db);
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('FIRST_LEG_DETECTED');
    expect(await w.app.selectFrom('settlement_leg').select('status').where('ref', '=', claim.legRef).executeTakeFirstOrThrow()).toEqual({ status: 'PROCESSING' });
  });

  it('decides a race between the deadline and “I’ve paid” one way only', async () => {
    for (let i = 0; i < 3; i += 1) {
      const t = await fundedBuy('700');
      await runP2pDeadlines((await at(16)).db);
      const [job, buyer] = await Promise.all([at(30), at(30)]);
      const [deadline, claim] = await Promise.allSettled([
        runP2pDeadlines(job.db),
        runAs(buyer.db, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: t.tradeRef, rail: 'UPI' as const, utr: utr(), fromBankAccountId: w.bankAccountId, payeeNameConfirmed: true }),
      ]);
      expect(deadline.status).toBe('fulfilled');
      const state = (await stateOf(t.tradeId)).lifecycle_state;
      const legs = await w.app.selectFrom('settlement_leg').select('status').where('trade_id', '=', t.tradeId).where('asset', '=', 'INR').execute();
      if (claim.status === 'fulfilled') {
        expect(state).toBe('FIRST_LEG_DETECTED');
        expect(legs).toEqual([{ status: 'PROCESSING' }]);
      } else {
        expect(claim.reason).toMatchObject({ code: 'INVALID_TRANSITION' });
        expect(state).toBe('CANCELLED');
        expect(legs).toEqual([]);
      }
    }
  });

  it('works the same when the trader is the one paying: its window, its rail, its final period', async () => {
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '1000', clientRate: '103.500000', plannedClientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    const tradeRef = await refOf(trade.tradeId);
    await expect(runAs(w.app, chooseClientPayMethod(w.acceptor.actor), w.acceptor.ref, 'escrow_payment.choose_method', { tradeRef, method: 'NEFT' })).rejects.toMatchObject({ code: 'NOT_THE_PAYER' });
    const deal = (await p2pDeal(w.app, w.deps.protector, { tradeId: trade.tradeId, viewer: 'TRADER' }))!;
    expect(deal.payWindow).toMatchObject({ method: 'IMPS' });
    expect(deal.payTo!.upiLink).toBeNull();
    await runAs(w.app, chooseOrderPayMethod(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.choose_method', { ref: trade.orderRef, method: 'NEFT' });
    // IMPS's thirty minutes are over, NEFT's sixty are not: nothing happens yet.
    await runP2pDeadlines((await at(45)).db);
    expect((await windowOf(trade.tradeId)).warned_at).toBeNull();
    await runAs((await at(50)).db, submitOrderPayment(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'NEFT' as const, utr: `ICICN${Date.now().toString().slice(-11)}` });
    await runP2pDeadlines((await at(90)).db);
    expect(await w.app.selectFrom('p2p_unwind').select('trade_id').where('trade_id', '=', trade.tradeId).execute()).toEqual([]);
    expect((await p2pDeal((await at(90)).db, null, { tradeId: trade.tradeId, viewer: 'CLIENT' }))!).toMatchObject({ step: 'CONFIRM', turn: 'SELLER' });
  });

  it('takes its times from the programme — a running deal keeps the ones it opened with — and refuses impossible ones', async () => {
    const running = await fundedBuy('700');
    await runP2pDeadlines(w.app);
    const configure = async (p2pTiming: unknown) => {
      const p = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
      return runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: p.version, p2pTiming: p2pTiming as typeof DEFAULT_P2P_TIMING, reason: 'deal times' });
    };
    await expect(configure({ ...DEFAULT_P2P_TIMING, pay: { ...DEFAULT_P2P_TIMING.pay, UPI: 1 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(configure({ ...DEFAULT_P2P_TIMING, receipt: { UPI: 30 } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await configure({ ...DEFAULT_P2P_TIMING, pay: { ...DEFAULT_P2P_TIMING.pay, UPI: 20 } });
    const fresh = await fundedBuy('700');
    await runP2pDeadlines(w.app);
    const minutesOf = async (tradeId: string) => {
      const r = await w.app.selectFrom('p2p_pay_window').select(['opened_at', 'due_at']).where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
      return (r.due_at.getTime() - r.opened_at.getTime()) / 60_000;
    };
    expect(await minutesOf(fresh.tradeId)).toBe(20);
    expect(await minutesOf(running.tradeId)).toBe(15);
    await configure(DEFAULT_P2P_TIMING);
    // The database holds the same ranges.
    await expect(sql`update trader_program set p2p_timing = '{"pay": {}}'::jsonb where id = 1`.execute(w.app)).rejects.toThrow();
  });
});

describe('a chat after its deal', () => {
  it('stays readable, and closes for writing a week after the deal closed', async () => {
    const t = await fundedBuy('700');
    await clientPost(t.tradeRef, { body: 'before' });
    expect((await runP2pDeadlines((await at(16)).db)).failures).toEqual([]);
    expect((await runP2pDeadlines((await at(22)).db)).failures).toEqual([]);
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('CANCELLED');
    // Still open the day after — a payment caught in the cancellation is talked through here.
    await runAs((await at(24 * 60)).db, postClientDealMessage(w.acceptor.actor), w.acceptor.ref, 'deal_chat.post', { tradeRef: t.tradeRef, body: 'I had paid' });
    const late = await at(9 * 24 * 60);
    await expect(runAs(late.db, postClientDealMessage(w.acceptor.actor), w.acceptor.ref, 'deal_chat.post', { tradeRef: t.tradeRef, body: 'hello?' })).rejects.toMatchObject({ code: 'CHAT_CLOSED' });
    expect((await dealChatView(late.db, { tradeId: t.tradeId, viewer: 'CLIENT' }))).toMatchObject({ canPost: false, messages: [{ body: 'before' }, { body: 'I had paid' }] });
    // A command with no file but a file reference is refused, whoever sends it.
    await expect(executeCommand(w.app, postClientDealMessage(w.acceptor.actor), { name: 'deal_chat.post', actor: w.acceptor.ref, payload: { tradeRef: t.tradeRef, file: attachmentRef(file(PNG())) }, idempotencyKey: randomUUID(), financial: false }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
