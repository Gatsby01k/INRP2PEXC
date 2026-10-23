import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, Rate } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import { budgetFigures } from '@inrp2p/network';
import { acceptQuote, claimDeskDealLink, clientDeskState, clientDesks, clientLinkState, createDeskDealLink, createRequest, decideFeePolicy, deskClients, deskDealLinkView, deskDealLinks, hideDeskPage, proposeFeePolicy, quoteDeskDealInTx, renameDesk, requestDeskQuote, resumeDesk, revokeDeskDealLink, setDeskClient, showDeskPage, suspendDesk, withdrawFeePolicy } from '@inrp2p/quotes';
import { dispatchOutbox } from '@inrp2p/outbox';
import { acknowledgedSignalHandler, clientNotificationHandler, orderAlertText, orderFacts, queueTelegram, sendTelegramDeliveries, telegramOrderHandler } from '@inrp2p/notifications';
import { exchangeView } from '../../packages/portal/src/index.ts';
import { acceptTeamInvite, addBankAccount, addWallet, archiveBankAccount, completeTelegramLink, createClient, inviteTeamMember, linkClientUser, removeTeamMember, startTelegramLink, stopTelegramChat, telegramLinkOf } from '@inrp2p/clients';
import { FakeTelegram } from '@inrp2p/adapters/testing';
import { createTestClientLogin } from '@inrp2p/identity/testing';
import { encodeTronAddress } from '@inrp2p/kernel';
import { randomBytes } from 'node:crypto';
import { claimIncomingFiat, confirmClientReceipt } from '@inrp2p/settlement';
import { attachDeskClientInTx, configureTraderProgram, currentDeskPrices, currentFeePolicy, deskOfTrader } from '@inrp2p/trader-core';
import { assertDeskSafe, feePolicyView, liveDeskHandles, openDisputes, opsDesk, opsDesks, ordersDueSoon, assignRequest, confirmOrderPaymentReceived, deskDeal, deskDeals, deskPage, deskToday, deskWorkspace, openDesk, orderDeliveryAddress, previewDeskDeal, setDeskPrices, setDeskStatus, submitOrderPayment, updateDesk } from '@inrp2p/traders';
import { CLIENT_SENDER, balanceOf, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { type TraderSetup, confirmOnChain, sendUsdt, traderClient, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsSettle, railsTrader } from './rails-world.ts';

/**
 * Desks (ADR 0020): a trader's own exchange. Its client deals with it at its own price; it fills the deal with its own
 * liquidity through the P2P escrow; INRP2P takes its explicit fee — the policy's basis points of the client's USDT — out of
 * the escrow, and realizes it as REVENUE:PLATFORM_FEE. The desk's network deposit pays the deal's transfers.
 */
let w: RailsWorld;
let desk: Awaited<ReturnType<typeof railsTrader>>;
let other: Awaited<ReturnType<typeof railsTrader>>;
let deskId: string;

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const inr = (d: string) => Money.parse(d, 'INR').minor;
const system = <R>(name: string, fn: Parameters<typeof executeCommand<Record<string, unknown>, R>>[1]['handle']) =>
  executeCommand(w.app, { authorize: async () => {}, handle: fn }, { name, actor: SYSTEM, payload: {}, idempotencyKey: randomUUID(), financial: true }).then((o) => o.result);
const quoteDeal = (requestId: string, clientRate: string | null = null) =>
  system('desk_deal.quote', (ctx) => quoteDeskDealInTx(ctx, w.railsDeps, { requestId, clientRateMicro: clientRate ? Rate.parse(clientRate, 'CLIENT').micro : null, validitySeconds: 120, committedBy: desk.admin.userId }));
const deskRequest = (direction: 'SELL_USDT' | 'BUY_USDT', amount: string, onDesk = deskId) =>
  runAs(w.app, createRequest(w.acceptor.actor, {}), w.acceptor.ref, 'request.create', {
    clientId: w.clientId, direction, fixedSide: 'BASE' as const, amount, deskId: onDesk, ...(direction === 'SELL_USDT' ? { bankAccountId: w.bankAccountId } : { walletId: w.walletId }),
  });
const refOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('ref').where('id', '=', tradeId).executeTakeFirstOrThrow()).ref;
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow()).lifecycle_state;
const orderRefOf = async (orderId: string) => (await w.app.selectFrom('trader_order').select('ref').where('id', '=', orderId).executeTakeFirstOrThrow()).ref;
const dbCode = (p: Promise<unknown>) => p.then(() => null, (e) => pgErrorCode(e) ?? e);
const deskVersion = async () => (await deskOfTrader(w.app, desk.traderId))!.version;
const deskClientOf = (clientId: string) => w.app.selectFrom('desk_client').select(['source', 'status']).where('desk_id', '=', deskId).where('client_id', '=', clientId).executeTakeFirst();

beforeAll(async () => {
  w = await createRailsWorld('desks');
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, executionMode: 'P2P' as const, reason: 'desks deal P2P' });
  desk = await railsTrader(w, 'Rahul OTC', {
    buy: { capacity: '50000000', rate: '101.20', min: '100', max: '20000000' },
    sell: { capacity: '500000', rate: '101.80', min: '10', max: '200000' },
  }, '1000');
  other = await railsTrader(w, 'Other Desk', { sell: { capacity: '500000', rate: '101.70', min: '10', max: '200000' } }, '0');
});
afterAll(async () => w.close());

describe('a trader opens its desk', () => {
  it('as a draft, at an address of its own that no other desk and no page of the site has', async () => {
    const opened = await runAs(w.app, openDesk(desk.admin.actor), desk.admin.ref, 'desk.open', { handle: ' Rahul-OTC ', displayName: 'Rahul OTC', about: 'USDT ⇄ INR for Mumbai businesses' });
    expect(opened).toMatchObject({ handle: 'rahul-otc', status: 'DRAFT' });
    deskId = opened.deskId;
    await expect(runAs(w.app, openDesk(desk.admin.actor), desk.admin.ref, 'desk.open', { handle: 'rahul-two', displayName: 'Rahul again' })).rejects.toMatchObject({ code: 'DESK_EXISTS' });
    await expect(runAs(w.app, openDesk(other.admin.actor), other.admin.ref, 'desk.open', { handle: 'rahul-otc', displayName: 'Copycat' })).rejects.toMatchObject({ code: 'DESK_HANDLE_TAKEN' });
    await expect(runAs(w.app, openDesk(other.admin.actor), other.admin.ref, 'desk.open', { handle: 'usdt-to-inr', displayName: 'Shadow' })).rejects.toMatchObject({ code: 'DESK_HANDLE_INVALID' });
    // Only the administrator opens it: a member who cannot commit, or even one who can, is not the business.
    await expect(runAs(w.app, openDesk(other.member.actor), other.member.ref, 'desk.open', { handle: 'member-desk', displayName: 'Member' })).rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    // The database keeps the site's own paths off the list too, whoever writes.
    expect(await dbCode(w.app.insertInto('desk').values({ trader_id: other.traderId, handle: 'sign-in', display_name: 'Shadow', created_by: other.admin.userId }).execute())).toBe('23514');
  });

  it('can change its address until it goes live, and never after', async () => {
    const moved = await runAs(w.app, updateDesk(desk.admin.actor), desk.admin.ref, 'desk.update', { expectedVersion: await deskVersion(), handle: 'rahul' });
    expect(moved.handle).toBe('rahul');
    const live = await runAs(w.app, setDeskStatus(desk.admin.actor), desk.admin.ref, 'desk.set_status', { expectedVersion: await deskVersion(), status: 'LIVE' as const });
    expect(live.status).toBe('LIVE');
    await expect(runAs(w.app, updateDesk(desk.admin.actor), desk.admin.ref, 'desk.update', { expectedVersion: await deskVersion(), handle: 'rahul-otc' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await dbCode(w.app.updateTable('desk').set({ handle: 'rahul-x' }).where('id', '=', deskId).execute())).toBe('IX121');
    // Its name may still change.
    expect(await runAs(w.app, updateDesk(desk.admin.actor), desk.admin.ref, 'desk.update', { expectedVersion: await deskVersion(), displayName: 'Rahul OTC Desk' })).toMatchObject({ handle: 'rahul' });
  });

  it('goes live only while its trader is approved', async () => {
    const draft = await runAs(w.app, openDesk(other.admin.actor), other.admin.ref, 'desk.open', { handle: 'other-desk', displayName: 'Other Desk' });
    await w.t.owner.updateTable('trader_profile').set({ status: 'PAUSED', available: false }).where('id', '=', other.traderId).execute();
    await expect(runAs(w.app, setDeskStatus(other.admin.actor), other.admin.ref, 'desk.set_status', { expectedVersion: draft.version, status: 'LIVE' as const })).rejects.toMatchObject({ code: 'DESK_NOT_LIVE' });
    expect(await dbCode(w.app.updateTable('desk').set({ status: 'LIVE' }).where('id', '=', draft.deskId).execute())).toBe('IX121');
    await w.t.owner.updateTable('trader_profile').set({ status: 'APPROVED' }).where('id', '=', other.traderId).execute();
    await runAs(w.app, setDeskStatus(other.admin.actor), other.admin.ref, 'desk.set_status', { expectedVersion: draft.version, status: 'LIVE' as const });
  });
});

describe('a desk’s prices', () => {
  it('are set per direction, with limits and a time they stop', async () => {
    await expect(runAs(w.app, setDeskPrices(other.admin.actor), other.admin.ref, 'desk.set_prices', { prices: [{ direction: 'SELL_USDT' as const, rate: '100.80', min: '100', max: '1000', live: true }] }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('do not buy USDT') });
    await expect(runAs(w.app, setDeskPrices(desk.member.actor), desk.member.ref, 'desk.set_prices', { prices: [{ direction: 'SELL_USDT' as const, rate: '100.80', min: '100', max: '1000', live: true }] }))
      .rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    await runAs(w.app, setDeskPrices(desk.admin.actor), desk.admin.ref, 'desk.set_prices', {
      prices: [
        { direction: 'SELL_USDT' as const, rate: '100.900000', min: '100', max: '20000', live: true },
        { direction: 'BUY_USDT' as const, rate: '102.100000', min: '100', max: '20000', live: true },
      ],
      validForHours: 12,
    });
    const prices = await currentDeskPrices(w.app, deskId);
    expect(prices.SELL_USDT).toMatchObject({ rateMicro: Rate.parse('100.9', 'CLIENT').micro, minBaseMinor: usdt('100'), maxBaseMinor: usdt('20000'), offered: true });
    expect(prices.BUY_USDT!.offered).toBe(true);
    // Past its time a price is shown but not dealt on.
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 13 * 3600_000));
    expect((await currentDeskPrices(clock.db, deskId)).SELL_USDT!.offered).toBe(false);
    expect(await dbCode(w.t.owner.updateTable('desk_price').set({ live: false }).where('desk_id', '=', deskId).execute())).toBe('IX001');
  });
});

describe('a desk’s clients and their requests', () => {
  it('a client becomes the desk’s client once, and the desk’s own trader never does', async () => {
    const first = await system('desk_client.attach', (ctx) => attachDeskClientInTx(ctx, { deskId, clientId: w.clientId, source: 'PAGE' }));
    const again = await system('desk_client.attach', (ctx) => attachDeskClientInTx(ctx, { deskId, clientId: w.clientId, source: 'LINK' }));
    expect(first).toMatchObject({ created: true, status: 'ACTIVE', source: 'PAGE' });
    expect(again).toMatchObject({ created: false, id: first.id, source: 'PAGE' });
    expect(await dbCode(w.app.insertInto('desk_client').values({ desk_id: deskId, client_id: desk.clientId, source: 'PAGE' }).execute())).toBe('IX122');
  });

  it('a request goes to a live desk from its active client only, and the INRP2P desk never routes it', async () => {
    const otherDesk = (await deskOfTrader(w.app, other.traderId))!;
    await expect(deskRequest('SELL_USDT', '1000', otherDesk.id)).rejects.toMatchObject({ code: 'DESK_CLIENT_BLOCKED' });
    // Whoever writes the row, the database asks the same (IX123).
    const raw = { client_id: w.clientId, direction: 'SELL_USDT' as const, fixed_side: 'BASE' as const, requested_base_minor: usdt('1000'), bank_account_id: w.bankAccountId, channel: 'CLIENT_APP' as const, created_by: 'test' };
    expect(await dbCode(w.app.insertInto('trade_request').values({ ...raw, desk_id: otherDesk.id }).execute())).toBe('IX123');

    const request = await deskRequest('SELL_USDT', '1000');
    await expect(runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '100.9' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('placed with a desk') });
    // Not even a raw order of another trader (IX124).
    const block = await w.app.selectFrom('trader_block').select(['id', 'route_id']).where('trader_id', '=', other.traderId).where('side', '=', 'SELL_USDT').executeTakeFirstOrThrow();
    const buyRequest = await deskRequest('BUY_USDT', '500');
    expect(await dbCode(w.app.insertInto('trader_order').values({
      trader_id: other.traderId, block_id: block.id, route_id: block.route_id, trade_request_id: buyRequest.requestId, side: 'SELL_USDT',
      base_minor: usdt('500'), inr_minor: inr('51000'), rate_micro: Rate.parse('102', 'ROUTE').micro, capacity_minor: usdt('500'), offered_by: 'test',
      offer_expires_at: new Date(Date.now() + 60_000),
    }).execute())).toBe('IX124');
    const { withdrawRequest } = await import('@inrp2p/quotes');
    for (const r of [request, buyRequest]) await runAs(w.app, withdrawRequest(w.acceptor.actor), w.acceptor.ref, 'request.withdraw', { requestId: r.requestId, reason: 'test' });
  });

  it('a blocked client cannot place one', async () => {
    await w.app.updateTable('desk_client').set({ status: 'BLOCKED' }).where('desk_id', '=', deskId).where('client_id', '=', w.clientId).execute();
    await expect(deskRequest('SELL_USDT', '1000')).rejects.toMatchObject({ code: 'DESK_CLIENT_BLOCKED' });
    await w.app.updateTable('desk_client').set({ status: 'ACTIVE' }).where('desk_id', '=', deskId).where('client_id', '=', w.clientId).execute();
  });
});

describe('a client sells USDT to the desk at its live price', () => {
  it('runs end to end: the desk receives the client’s USDT less the fee, and the fee is INRP2P’s revenue', async () => {
    const request = await deskRequest('SELL_USDT', '10000');
    const quote = await quoteDeal(request.requestId);
    expect(quote).toMatchObject({ clientRate: '100.900000', base: '10000.000000', clientInr: '1009000.00', deskBase: '9975.000000', platformFee: '25.000000' });
    const q = await w.app.selectFrom('quote').selectAll().where('id', '=', quote.quoteId).executeTakeFirstOrThrow();
    expect(q).toMatchObject({ status: 'SENT', route_rate_micro: q.client_rate_micro, route_base_minor: usdt('9975'), gross_margin_base_minor: usdt('25'), platform_fee_bps: 25, platform_fee_base_minor: usdt('25'), gross_margin_inr_minor: 0n });
    // The desk's network deposit pays for the deal's transfers; nothing comes out of the fee for it.
    const fee = await w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', quote.quoteId).executeTakeFirstOrThrow();
    expect(fee).toMatchObject({ funder_trader_id: desk.traderId, net_margin_usdt_minor: usdt('25') });
    // A quote of another fee on the same order is refused by the database (IX125).
    const { id: _id, ref: _ref, status: _s, sent_at: _sa, expires_at: _ea, sent_by: _sb, created_at: _ca, ...copy } = q;
    expect(await dbCode(w.app.insertInto('quote').values({ ...copy, status: 'DRAFT', platform_fee_bps: 30, platform_fee_base_minor: usdt('30'), gross_margin_base_minor: usdt('30'), route_base_minor: usdt('9970') }).execute())).toBe('IX125');

    const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
    const econ = await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
    expect(econ).toMatchObject({ route_execution_mode: 'P2P', route_base_minor: usdt('9975'), platform_fee_bps: 25, platform_fee_base_minor: usdt('25') });
    const hold = await w.app.selectFrom('network_budget_hold').select('trader_id').where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
    expect(hold.trader_id).toBe(desk.traderId);

    // (1) The client's USDT into the deal's address; (2) the desk pays the rupees; (3) the client confirms who sent them.
    await settleFirstLeg(w, accepted.tradeId);
    const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
    const orderRef = await orderRefOf(quote.orderId);
    const paid = await runAs(w.app, submitOrderPayment(desk.admin.actor, w.traderDeps), desk.admin.ref, 'trader_order.submit_payment', { ref: orderRef, rail: 'IMPS' as const, utr: utr() });
    const holder = (await w.app.selectFrom('bank_account').select('holder_name').where('id', '=', desk.bankAccountId).executeTakeFirstOrThrow()).holder_name;
    expect(await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: await refOf(accepted.tradeId), legRef: paid.settlementRef, senderName: holder }))
      .toMatchObject({ verdict: 'MATCH', confirmed: true });

    // (4) The signer pays the desk its USDT; the fee stays at the deal's address and is realized as the platform's.
    const before = w.chain.balanceOf(desk.walletAddress);
    await railsSettle(w, accepted.tradeId);
    expect(w.chain.balanceOf(desk.walletAddress) - before).toBe(usdt('9975'));
    expect(w.chain.balanceOf(deposit.address)).toBe(usdt('25'));
    expect(await stateOf(accepted.tradeId)).toBe('COMPLETED');
    expect(-(await balanceOf(w.app, 'REVENUE:PLATFORM_FEE', 'USDT', { tradeId: accepted.tradeId }))).toBe(usdt('25'));
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'USDT', { tradeId: accepted.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'LIAB:DEFERRED_MARGIN', 'USDT', { tradeId: accepted.tradeId })).toBe(0n);
    expect(await balanceOf(w.app, 'ASSET:INR_SETTLEMENT:', 'INR', { tradeId: accepted.tradeId })).toBe(0n);
    // The desk's TRX paid the transfer, and none of it is paid back.
    const closed = await w.app.selectFrom('network_budget_hold').select(['status', 'spent_sun', 'reimbursed_sun']).where('trade_id', '=', accepted.tradeId).executeTakeFirstOrThrow();
    expect(closed).toMatchObject({ status: 'CLOSED', reimbursed_sun: 0n });
    expect(closed.spent_sun!).toBeGreaterThan(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('a client buys USDT on a deal link’s rate', () => {
  it('runs end to end: the desk delivers the client’s USDT plus the fee, and the fee stays as INRP2P’s', async () => {
    const request = await deskRequest('BUY_USDT', '1000');
    const quote = await quoteDeal(request.requestId, '102.500000');
    expect(quote).toMatchObject({ clientInr: '102500.00', deskBase: '1002.500000', platformFee: '2.500000' });
    const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
    const orderRef = await orderRefOf(quote.orderId);

    // (1) The desk funds the escrow with the client's USDT and the fee.
    const { address } = await runAs(w.app, orderDeliveryAddress(desk.admin.actor, w.traderDeps), desk.admin.ref, 'trader_order.delivery_address', { ref: orderRef });
    await sendUsdt(w, desk.walletAddress, address, '1002.5');
    await confirmOnChain(w);
    // (2) The client pays the desk directly; (3) the desk confirms who sent it.
    await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: await refOf(accepted.tradeId), rail: 'IMPS' as const, utr: utr(), fromBankAccountId: w.bankAccountId });
    expect(await runAs(w.app, confirmOrderPaymentReceived(desk.admin.actor, w.traderDeps), desk.admin.ref, 'trader_order.confirm_received', { ref: orderRef, senderName: CLIENT_SENDER }))
      .toMatchObject({ verdict: 'MATCH', confirmed: true });
    // (4) The client gets exactly its USDT; the fee stays.
    const wallet = (await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow()).address;
    const before = w.chain.balanceOf(wallet);
    await railsSettle(w, accepted.tradeId);
    expect(w.chain.balanceOf(wallet) - before).toBe(usdt('1000'));
    expect(w.chain.balanceOf(address)).toBe(usdt('2.5'));
    expect(await stateOf(accepted.tradeId)).toBe('COMPLETED');
    expect(-(await balanceOf(w.app, 'REVENUE:PLATFORM_FEE', 'USDT', { tradeId: accepted.tradeId }))).toBe(usdt('2.5'));
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('what a desk deal will not do', () => {
  it('goes past the desk’s live limits, a price that is off, or a desk that cannot fund the network', async () => {
    const big = await deskRequest('SELL_USDT', '25000');
    await expect(quoteDeal(big.requestId)).rejects.toMatchObject({ code: 'INVALID_AMOUNT', message: expect.stringContaining('100.000000 to 20000.000000') });
    await runAs(w.app, setDeskPrices(desk.admin.actor), desk.admin.ref, 'desk.set_prices', { prices: [{ direction: 'SELL_USDT' as const, rate: '100.900000', min: '100', max: '20000', live: false }] });
    const off = await deskRequest('SELL_USDT', '1000');
    await expect(quoteDeal(off.requestId)).rejects.toMatchObject({ code: 'DESK_NOT_LIVE' });
    // A deal link carries its own rate: it is priced even while the live price is off.
    expect(await quoteDeal(off.requestId, '100.700000')).toMatchObject({ clientInr: '100700.00', deskBase: '997.500000' });

    // A desk without TRX of its own gets no deal: the platform pays nobody's network.
    const otherDeskId = (await deskOfTrader(w.app, other.traderId))!.id;
    await system('desk_client.attach', (ctx) => attachDeskClientInTx(ctx, { deskId: otherDeskId, clientId: w.clientId, source: 'LINK' }));
    expect((await budgetFigures(w.app, other.traderId)).availableSun).toBe(0n);
    const broke = await deskRequest('BUY_USDT', '1000', otherDeskId);
    await expect(quoteDeal(broke.requestId, '102.500000')).rejects.toMatchObject({ code: 'NETWORK_BUDGET_INSUFFICIENT' });
  });

  it('charges a fee other than the policy’s: a new policy needs a second person, and applies to new quotes only', async () => {
    const before = await currentFeePolicy(w.app);
    expect(before).toMatchObject({ ownDealBps: 25, networkDealBps: 60 });
    expect(await dbCode(w.t.owner.updateTable('fee_policy').set({ own_deal_bps: 1 }).execute())).toBe('IX001');
    expect(await dbCode(w.app.insertInto('fee_policy').values({ own_deal_bps: 30, network_deal_bps: 60, reason: 'one person', set_by: 'operator-a' }).execute())).toBe('23514');
    expect(await dbCode(w.app.insertInto('fee_policy').values({ own_deal_bps: 30, network_deal_bps: 60, reason: 'same person', set_by: 'operator-a', approved_by: 'operator-a' }).execute())).toBe('23514');
    await w.app.insertInto('fee_policy').values({ own_deal_bps: 30, network_deal_bps: 60, reason: 'test: two people', set_by: 'operator-a', approved_by: 'operator-b' }).execute();
    expect((await sql<{ bps: number }>`select inrp2p_platform_fee_bps() as bps`.execute(w.app)).rows[0]!.bps).toBe(30);
    const request = await deskRequest('BUY_USDT', '1000');
    expect(await quoteDeal(request.requestId, '102.500000')).toMatchObject({ platformFee: '3.000000', deskBase: '1003.000000' });
    await w.app.insertInto('fee_policy').values({ own_deal_bps: 25, network_deal_bps: 60, reason: 'test: back', set_by: 'operator-a', approved_by: 'operator-b' }).execute();
  });
});

// ---- block 2: the desk's page, its instant price, deal links, and the trader's full standing ------------------------

const livePrices = () => runAs(w.app, setDeskPrices(desk.admin.actor), desk.admin.ref, 'desk.set_prices', {
  prices: [
    { direction: 'SELL_USDT' as const, rate: '100.900000', min: '100', max: '20000', live: true },
    { direction: 'BUY_USDT' as const, rate: '102.100000', min: '100', max: '20000', live: true },
  ],
});
let bharat: TraderSetup;
let heldBefore = 0n;
const bharatQuote = (direction: 'SELL_USDT' | 'BUY_USDT', amount: string, handle = 'rahul') =>
  runAs(w.app, requestDeskQuote(bharat.admin.actor, w.railsDeps), bharat.admin.ref, 'desk_deal.request_quote', {
    handle, direction, fixedSide: 'BASE' as const, amount, ...(direction === 'SELL_USDT' ? { bankAccountId: bharat.bankAccountId } : { walletId: bharat.walletId }),
  });
const reservedOf = async (side: 'BUY_USDT' | 'SELL_USDT') => (await w.app.selectFrom('trader_block').select('reserved_minor').where('trader_id', '=', desk.traderId).where('side', '=', side).executeTakeFirstOrThrow()).reserved_minor;

describe('a desk’s instant price on its page', () => {
  beforeAll(async () => {
    await livePrices();
    bharat = await traderClient(w, 'Bharat Exports');
  });

  it('is firm at once, on the live price, for a minute — and makes the client the desk’s client', async () => {
    expect(await deskClientOf(bharat.clientId)).toBeUndefined();
    heldBefore = await reservedOf('SELL_USDT');
    const quote = await bharatQuote('BUY_USDT', '2000');
    expect(quote).toMatchObject({ direction: 'BUY_USDT', clientRate: '102.100000', base: '2000.000000', clientInr: '204200.00', deskBase: '2005.000000', platformFee: '5.000000' });
    const q = await w.app.selectFrom('quote').select(['status', 'valid_for_seconds', 'expires_at', 'created_by']).where('id', '=', quote.quoteId).executeTakeFirstOrThrow();
    expect(q).toMatchObject({ status: 'SENT', valid_for_seconds: 60, created_by: desk.admin.userId });
    expect(await deskClientOf(bharat.clientId)).toMatchObject({ source: 'PAGE', status: 'ACTIVE' });
    // The desk's capacity is held while the price can be taken, and a minute more — not for the programme's hold.
    const order = await w.app.selectFrom('trader_order').select(['hold_until', 'capacity_minor']).where('id', '=', quote.orderId).executeTakeFirstOrThrow();
    expect(order.hold_until!.getTime() - q.expires_at!.getTime()).toBe(60_000);
    expect(await reservedOf('SELL_USDT')).toBe(heldBefore + order.capacity_minor);
  });

  it('replaces the client’s earlier price at the desk, capacity and all, so nobody can hold the desk by asking', async () => {
    const first = (await w.app.selectFrom('trade_request').select('id').where('client_id', '=', bharat.clientId).where('status', '=', 'QUOTED').executeTakeFirstOrThrow()).id;
    const again = await bharatQuote('BUY_USDT', '3000');
    const old = await w.app.selectFrom('trade_request').select('status').where('id', '=', first).executeTakeFirstOrThrow();
    expect(old.status).toBe('WITHDRAWN');
    const oldQuote = await w.app.selectFrom('quote').select(['status', 'cancel_reason']).where('trade_request_id', '=', first).executeTakeFirstOrThrow();
    expect(oldQuote).toMatchObject({ status: 'CANCELLED', cancel_reason: 'SUPERSEDED' });
    expect(await reservedOf('SELL_USDT')).toBe(heldBefore + usdt('3007.5'));
    const live = await w.app.selectFrom('trade_request').select('id').where('client_id', '=', bharat.clientId).where('status', 'in', ['OPEN', 'QUOTED']).execute();
    expect(live.map((r) => r.id)).toEqual([again.requestId]);
    // The client takes it like any quote.
    const accepted = await runAs(w.app, acceptQuote(bharat.admin.actor, w.railsDeps), bharat.admin.ref, 'quote.accept', { quoteId: again.quoteId });
    expect(await stateOf(accepted.tradeId)).toBe('AWAITING_FIRST_LEG');
  });

  it('is refused outside the desk’s limits, while it is paused or its price is off, and to a client it blocked', async () => {
    await expect(bharatQuote('BUY_USDT', '50')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(bharatQuote('BUY_USDT', '100', 'nobody-here')).rejects.toMatchObject({ code: 'DESK_NOT_LIVE' });
    await w.app.updateTable('desk_client').set({ status: 'BLOCKED' }).where('client_id', '=', bharat.clientId).execute();
    await expect(bharatQuote('SELL_USDT', '1000')).rejects.toMatchObject({ code: 'DESK_CLIENT_BLOCKED' });
    await w.app.updateTable('desk_client').set({ status: 'ACTIVE' }).where('client_id', '=', bharat.clientId).execute();
    await runAs(w.app, setDeskStatus(desk.admin.actor), desk.admin.ref, 'desk.set_status', { expectedVersion: await deskVersion(), status: 'PAUSED' as const });
    await expect(bharatQuote('SELL_USDT', '1000')).rejects.toMatchObject({ code: 'DESK_NOT_LIVE' });
    await runAs(w.app, setDeskStatus(desk.admin.actor), desk.admin.ref, 'desk.set_status', { expectedVersion: await deskVersion(), status: 'LIVE' as const });
  });
});

describe('a desk deals only in a trader’s full standing (TD-38)', () => {
  it('not with its Security Reserve short, nor with its registered account inactive, nor past INRP2P’s ceiling on it', async () => {
    await w.t.owner.updateTable('trader_profile').set({ required_reserve_minor: usdt('5000') }).where('id', '=', desk.traderId).execute();
    await expect(bharatQuote('SELL_USDT', '1000')).rejects.toMatchObject({ code: 'DESK_NOT_LIVE' });
    await w.t.owner.updateTable('trader_profile').set({ required_reserve_minor: usdt('500') }).where('id', '=', desk.traderId).execute();

    // Standing comes before anything else: the other desk, short of TRX, is refused for its standing once its account goes.
    const otherDesk = (await deskOfTrader(w.app, other.traderId))!;
    const pending = await w.app.selectFrom('trade_request').select('id').where('desk_id', '=', otherDesk.id).where('status', '=', 'OPEN').executeTakeFirstOrThrow();
    await expect(quoteDeal(pending.id, '102.500000')).rejects.toMatchObject({ code: 'NETWORK_BUDGET_INSUFFICIENT' });
    await w.t.owner.updateTable('bank_account').set({ status: 'ARCHIVED', archived_by: 'test', archived_at: new Date() }).where('id', '=', other.bankAccountId).execute();
    await expect(quoteDeal(pending.id, '102.500000')).rejects.toMatchObject({ code: 'DESK_NOT_LIVE' });

    await w.t.owner.updateTable('trader_profile').set({ max_order_inr_minor: inr('50000') }).where('id', '=', desk.traderId).execute();
    await expect(bharatQuote('SELL_USDT', '1000')).rejects.toMatchObject({ code: 'INVALID_AMOUNT', message: expect.stringContaining('in one deal') });
    await w.t.owner.updateTable('trader_profile').set({ max_order_inr_minor: null }).where('id', '=', desk.traderId).execute();
    // Offline is the INRP2P desk's routing switch, not the desk's own: a desk off its programme switch still deals.
    await w.t.owner.updateTable('trader_profile').set({ available: false }).where('id', '=', desk.traderId).execute();
    expect(await bharatQuote('SELL_USDT', '1000')).toMatchObject({ deskBase: '997.500000' });
    await w.t.owner.updateTable('trader_profile').set({ available: true }).where('id', '=', desk.traderId).execute();
  });
});

describe('a deal link', () => {
  let token = '';
  let linkId = '';
  const make = (p: Partial<Parameters<ReturnType<typeof createDeskDealLink>['handle']>[1]> = {}, who = desk.admin) => {
    let t = '';
    return runAs(w.app, createDeskDealLink(who.actor, (x) => { t = x; }), who.ref, 'desk_deal_link.create', {
      direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '1500', rate: '101.950000', note: 'for Bharat, Monday', validMinutes: 120, ...p,
    }).then((r) => ({ ...r, token: t }));
  };
  const claim = (tok: string, who: TraderSetup | 'acme' = bharat, db = w.app) =>
    who === 'acme'
      ? runAs(db, claimDeskDealLink(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'desk_deal_link.claim', { token: tok, walletId: w.walletId })
      : runAs(db, claimDeskDealLink(who.admin.actor, w.railsDeps), who.admin.ref, 'desk_deal_link.claim', { token: tok, walletId: who.walletId });

  it('is made by whoever can commit for the desk, at its own rate; anyone with it sees the deal, never the fee', async () => {
    await expect(make({}, desk.member)).rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    await expect(make({ direction: 'SELL_USDT', amount: '0.000001' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(make({ validMinutes: 2 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const made = await make();
    expect(made.ref).toMatch(/^DL-\d{4,}$/);
    expect(made.token).toMatch(/^[0-9A-Za-z]{22}$/);
    token = made.token;
    linkId = made.linkId;
    // Only the hash is kept.
    expect(await w.app.selectFrom('desk_deal_link').select('id').where('token_hash', '=', made.token).executeTakeFirst()).toBeUndefined();
    const view = await deskDealLinkView(w.app, token);
    expect(view).toMatchObject({ ref: made.ref, desk: { handle: 'rahul', live: true }, direction: 'BUY_USDT', rate: '101.950000', base: '1500.000000', inr: '152925.00', state: 'OPEN' });
    expect(JSON.stringify(view)).not.toMatch(/fee|1503\.75|note|Monday/);
    expect(await deskDealLinkView(w.app, 'not-a-real-token-at-all')).toBeNull();
  });

  it('is the first taker’s: it gets a firm quote at the link’s rate, and nobody else can take it', async () => {
    const first = await claim(token);
    expect(first).toMatchObject({ clientRate: '101.950000', base: '1500.000000', clientInr: '152925.00', deskBase: '1503.750000' });
    const req = await w.app.selectFrom('trade_request').select(['channel', 'desk_deal_link_id', 'desk_id']).where('id', '=', first.requestId).executeTakeFirstOrThrow();
    expect(req).toMatchObject({ channel: 'LINK', desk_deal_link_id: linkId, desk_id: deskId });
    expect((await w.app.selectFrom('quote').select('valid_for_seconds').where('id', '=', first.quoteId).executeTakeFirstOrThrow()).valid_for_seconds).toBe(180);
    expect((await deskDealLinkView(w.app, token))!.state).toBe('TAKEN');
    await expect(claim(token, 'acme')).rejects.toMatchObject({ code: 'DESK_LINK_UNAVAILABLE' });
    expect(await dbCode(w.app.updateTable('desk_deal_link').set({ claimed_client_id: w.clientId }).where('id', '=', linkId).execute())).toBe('IX126');
    // Taken again while its quote is live: the same quote.
    expect((await claim(token)).quoteId).toBe(first.quoteId);
    // A quote of its request at another rate is refused by the database.
    const q = await w.app.selectFrom('quote').selectAll().where('id', '=', first.quoteId).executeTakeFirstOrThrow();
    const { id: _id, ref: _ref, status: _s, sent_at: _sa, expires_at: _ea, sent_by: _sb, created_at: _ca, ...copy } = q;
    expect(await dbCode(w.app.insertInto('quote').values({ ...copy, status: 'DRAFT', client_rate_micro: q.client_rate_micro + 1n, route_rate_micro: q.route_rate_micro + 1n }).execute())).toBe('IX126');
  });

  it('gives a fresh quote once the old one lapsed, and becomes one trade at most', async () => {
    const before = (await w.app.selectFrom('quote as q').innerJoin('trade_request as r', 'r.id', 'q.trade_request_id').select('q.id').where('r.desk_deal_link_id', '=', linkId).where('q.status', '=', 'SENT').executeTakeFirstOrThrow()).id;
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 200_000));
    const fresh = await claim(token, bharat, clock.db);
    expect(fresh.quoteId).not.toBe(before);
    expect((await w.app.selectFrom('quote').select('status').where('id', '=', before).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    const accepted = await runAs(clock.db, acceptQuote(bharat.admin.actor, w.railsDeps), bharat.admin.ref, 'quote.accept', { quoteId: fresh.quoteId });
    expect(await stateOf(accepted.tradeId)).toBe('AWAITING_FIRST_LEG');
    expect((await deskDealLinkView(w.app, token))!.state).toBe('DONE');
    await expect(claim(token, bharat, clock.db)).rejects.toMatchObject({ code: 'DESK_LINK_UNAVAILABLE' });
    await clock.set(null);
    const listed = (await deskDealLinks(w.app, deskId)).find((l) => l.linkId === linkId)!;
    expect(listed).toMatchObject({ state: 'DONE', clientName: 'Bharat Exports', note: 'for Bharat, Monday', tradeRef: await refOf(accepted.tradeId) });
  });

  it('is taken back by the desk, its live price cancelled and its capacity given back; and lapses at its time', async () => {
    const reservedBefore = await reservedOf('SELL_USDT');
    const made = await make({ amount: '700' });
    const quote = await claim(made.token);
    expect(await reservedOf('SELL_USDT')).toBe(reservedBefore + usdt('701.75'));
    await expect(runAs(w.app, revokeDeskDealLink(desk.member.actor), desk.member.ref, 'desk_deal_link.revoke', { linkId: made.linkId, reason: 'test' })).rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    await runAs(w.app, revokeDeskDealLink(desk.admin.actor), desk.admin.ref, 'desk_deal_link.revoke', { linkId: made.linkId, reason: 'client changed its mind' });
    expect((await w.app.selectFrom('quote').select('status').where('id', '=', quote.quoteId).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
    expect((await w.app.selectFrom('trade_request').select('status').where('id', '=', quote.requestId).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
    expect(await reservedOf('SELL_USDT')).toBe(reservedBefore);
    expect((await deskDealLinkView(w.app, made.token))!.state).toBe('REVOKED');
    await expect(claim(made.token)).rejects.toMatchObject({ code: 'DESK_LINK_UNAVAILABLE' });

    const short = await make({ amount: '300', validMinutes: 5 });
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 6 * 60_000));
    await expect(claim(short.token, bharat, clock.db)).rejects.toMatchObject({ code: 'DESK_LINK_UNAVAILABLE', message: expect.stringContaining('expired') });
    expect((await deskDealLinkView(clock.db, short.token))!.state).toBe('EXPIRED');
    await clock.set(null);
  });
});

describe('a desk’s public page', () => {
  it('shows its live prices and its record from the books, never a draft', async () => {
    const page = await deskPage(w.app, 'RAHUL');
    expect(page).toMatchObject({ handle: 'rahul', displayName: 'Rahul OTC Desk', status: 'LIVE', prices: { SELL_USDT: { rate: '100.900000', min: '100.000000', max: '20000.000000' }, BUY_USDT: { rate: '102.100000' } } });
    expect(page!.record.completedDeals).toBeGreaterThanOrEqual(2);
    expect(page!.record.medianMinutes).not.toBeNull();
    // A live desk is in the public site's sitemap; a draft one is not.
    expect(await liveDeskHandles(w.app)).toContain(page!.handle);
    expect(JSON.stringify(page)).not.toMatch(/fee|bps|client/i);
    expect(await deskPage(w.app, 'nobody-here')).toBeNull();
    expect(await previewDeskDeal(w.app, { handle: 'rahul', direction: 'SELL_USDT', fixedSide: 'QUOTE', amount: '100900.00' })).toEqual({ rate: '100.900000', base: '1000.000000', inr: '100900.00', withinLimits: true });
    const draft = await railsTrader(w, 'Draft Desk', { sell: { capacity: '1000', rate: '101.00', min: '10', max: '1000' } }, '0');
    await runAs(w.app, openDesk(draft.admin.actor), draft.admin.ref, 'desk.open', { handle: 'draft-desk', displayName: 'Draft Desk' });
    expect(await deskPage(w.app, 'draft-desk')).toBeNull();
    expect(await liveDeskHandles(w.app)).not.toContain('draft-desk');
  });
});

// ---- block 3: a desk's clients, and a new client's first destinations ---------------------------------------------

describe('a desk’s clients', () => {
  const clientRow = async (clientId: string) => (await deskClients(w.app, deskId)).find((c) => c.clientId === clientId)!;
  const update = (p: Omit<Parameters<ReturnType<typeof setDeskClient>['handle']>[1], 'expectedVersion'> & { expectedVersion?: number }, who = desk.admin) =>
    clientRow(p.clientId).then((row) => runAs(w.app, setDeskClient(who.actor), who.ref, 'desk_client.update', { expectedVersion: row.version, ...p }));

  it('are listed with what each did with the desk, from the books', async () => {
    const list = await deskClients(w.app, deskId);
    const acme = list.find((c) => c.clientId === w.clientId)!;
    expect(acme).toMatchObject({ status: 'ACTIVE', source: 'PAGE', completedDeals: 2, completedUsdt: '11000.000000' });
    const b = list.find((c) => c.clientId === bharat.clientId)!;
    expect(b).toMatchObject({ name: 'Bharat Exports', source: 'PAGE', completedDeals: 0 });
    expect(b.openDeals).toBeGreaterThanOrEqual(2);
    // Another desk's client is not on this list, and this desk cannot touch it.
    expect(list.find((c) => c.clientId === desk.clientId)).toBeUndefined();
    await expect(runAs(w.app, setDeskClient(other.admin.actor), other.admin.ref, 'desk_client.update', { clientId: bharat.clientId, expectedVersion: b.version, note: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(update({ clientId: bharat.clientId, note: 'x' }, desk.member)).rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    await expect(runAs(w.app, setDeskClient(desk.admin.actor), desk.admin.ref, 'desk_client.update', { clientId: bharat.clientId, expectedVersion: b.version + 5, note: 'x' })).rejects.toMatchObject({ code: 'STALE_VERSION' });
  });

  it('get the desk’s own limit on one deal, and a note only the desk sees', async () => {
    await update({ clientId: bharat.clientId, maxDeal: '500', note: 'exporter, pays from HDFC' });
    expect(await clientRow(bharat.clientId)).toMatchObject({ maxDeal: '500.000000', note: 'exporter, pays from HDFC' });
    await expect(bharatQuote('BUY_USDT', '1000')).rejects.toMatchObject({ code: 'INVALID_AMOUNT', message: expect.stringContaining('up to 500.000000 USDT with you') });
    expect(await bharatQuote('BUY_USDT', '400')).toMatchObject({ base: '400.000000' });
    await update({ clientId: bharat.clientId, maxDeal: null });
    expect((await clientRow(bharat.clientId)).maxDeal).toBeNull();
  });

  it('when blocked, lose what they are asking at once — prices, links and the capacity they hold — but not their open deals', async () => {
    const baseline = await reservedOf('SELL_USDT');
    const deskBuy = await reservedOf('BUY_USDT');
    const live = await bharatQuote('SELL_USDT', '1000');
    let tok = '';
    await runAs(w.app, createDeskDealLink(desk.admin.actor, (x) => { tok = x; }), desk.admin.ref, 'desk_deal_link.create', { direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '800', rate: '101.900000' });
    const linked = await runAs(w.app, claimDeskDealLink(bharat.admin.actor, w.railsDeps), bharat.admin.ref, 'desk_deal_link.claim', { token: tok, walletId: bharat.walletId });
    expect(await reservedOf('SELL_USDT')).toBeGreaterThan(baseline);
    const openDealsBefore = (await clientRow(bharat.clientId)).openDeals;

    const out = await update({ clientId: bharat.clientId, status: 'BLOCKED' as const });
    expect(out).toMatchObject({ status: 'BLOCKED' });
    // Two open requests — the price on the page and the link — closed in one step, in the global lock order.
    expect(out.withdrawnRequests).toBeGreaterThanOrEqual(2);
    for (const q of [live, linked]) {
      expect((await w.app.selectFrom('quote').select('status').where('id', '=', q.quoteId).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
      expect((await w.app.selectFrom('trade_request').select('status').where('id', '=', q.requestId).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
    }
    expect(await reservedOf('BUY_USDT')).toBe(deskBuy);
    expect(await reservedOf('SELL_USDT')).toBe(baseline - usdt('401')); // the 400 USDT price of the last test went too
    expect((await clientRow(bharat.clientId)).openDeals).toBe(openDealsBefore);
    await expect(bharatQuote('SELL_USDT', '1000')).rejects.toMatchObject({ code: 'DESK_CLIENT_BLOCKED' });
    await update({ clientId: bharat.clientId, status: 'ACTIVE' as const });
    expect(await bharatQuote('SELL_USDT', '1000')).toMatchObject({ deskBase: '997.500000' });
  });
});

describe('a new client sets up where it is paid', () => {
  /** A client that came through a desk: signed in by an email code just now, no authenticator. */
  async function freshClient(name: string) {
    const created = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: `${name} Private Limited`, displayName: name, type: 'COMPANY' as const });
    const login = await createTestClientLogin(w.t.owner, { emailVerified: true });
    await runAs(w.app, linkClientUser(w.owner.actor), w.owner.ref, 'client_user.link', { clientId: created.clientId, userId: login.userId, role: 'CLIENT_ADMIN' as const });
    return { clientId: created.clientId, sessionId: login.sessionId, actor: { kind: 'CLIENT' as const, userId: login.userId, sessionId: login.sessionId }, ref: login.ref };
  }
  const bank = (c: Awaited<ReturnType<typeof freshClient>>, accountNumber = String(500000000000 + randomBytes(4).readUInt32BE(0))) =>
    runAs(w.app, addBankAccount(c.actor, w.deps.protector), c.ref as never, 'client_bank.add', { clientId: c.clientId, holderName: 'Meera Textiles Private Limited', bankName: 'HDFC Bank', ifsc: 'HDFC0000123', accountNumber });
  const wallet = (c: Awaited<ReturnType<typeof freshClient>>) =>
    runAs(w.app, addWallet(c.actor), c.ref as never, 'client_wallet.add', { clientId: c.clientId, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), purpose: 'BOTH' as const, label: 'Main' });

  it('adds its first bank account and first wallet with the email code it just signed in with — nothing more', async () => {
    const meera = await freshClient('Meera Textiles');
    const added = await bank(meera);
    const audit = await w.app.selectFrom('audit_event').select('after').where('entity_id', '=', added.bankAccountId).where('action', '=', 'client_bank.added').executeTakeFirstOrThrow();
    expect(audit.after).toMatchObject({ added_via: 'CLIENT', confirmed_by: 'EMAIL_SIGN_IN', status: 'ACTIVE' });
    expect(await wallet(meera)).toHaveProperty('walletId');
    // A second one — or taking one away — is never confirmed by email alone: the authenticator is asked for.
    await expect(bank(meera)).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
    await expect(wallet(meera)).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
    await expect(runAs(w.app, archiveBankAccount(meera.actor), meera.ref as never, 'client_bank.archive', { bankAccountId: added.bankAccountId, reason: 'test' })).rejects.toMatchObject({ code: 'MFA_ENROLLMENT_REQUIRED' });
  });

  it('asks for a fresh email code when the sign-in is older than ten minutes', async () => {
    const late = await freshClient('Late Traders');
    await sql`update auth_session set created_at = statement_timestamp() - interval '11 minutes' where id = ${late.sessionId}`.execute(w.t.owner);
    await expect(bank(late)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', details: { via: 'EMAIL' } });
  });
});

// ---- block 4: the desk's team ------------------------------------------------------------------------------------------

describe('a desk’s team', () => {
  it('an operator invited by email sets prices and makes links, but not the desk’s page; removed, they can do neither', async () => {
    const login = await createTestClientLogin(w.t.owner, { emailVerified: true });
    const email = (await w.app.selectFrom('auth_user').select('email').where('id', '=', login.userId).executeTakeFirstOrThrow()).email;
    const operator = { actor: { kind: 'CLIENT' as const, userId: login.userId, sessionId: login.sessionId }, ref: login.ref as never };
    const sent = await runAs(w.app, inviteTeamMember(desk.admin.actor), desk.admin.ref, 'client_invite.create', { email, role: 'OPERATOR' as const });
    await runAs(w.app, acceptTeamInvite(operator.actor), operator.ref, 'client_invite.accept', { inviteId: sent.inviteId });

    const prices = { prices: [{ direction: 'SELL_USDT' as const, rate: '100.950000', min: '100', max: '20000', live: true }] };
    await runAs(w.app, setDeskPrices(operator.actor), operator.ref, 'desk.set_prices', prices);
    expect((await currentDeskPrices(w.app, deskId)).SELL_USDT).toMatchObject({ setBy: login.userId });
    await expect(runAs(w.app, setDeskStatus(operator.actor), operator.ref, 'desk.set_status', { expectedVersion: await deskVersion(), status: 'PAUSED' as const })).rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    await expect(runAs(w.app, inviteTeamMember(operator.actor), operator.ref, 'client_invite.create', { email: 'x@desk.test', role: 'OPERATOR' as const })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const member = await w.app.selectFrom('client_user').select('id').where('user_id', '=', login.userId).executeTakeFirstOrThrow();
    await runAs(w.app, removeTeamMember(desk.admin.actor), desk.admin.ref, 'client_user.remove', { clientUserId: member.id });
    await expect(runAs(w.app, setDeskPrices(operator.actor), operator.ref, 'desk.set_prices', prices)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await livePrices();
  });
});

// ---- block 5: the desk's workspace ----------------------------------------------------------------------------------

describe('the desk’s workspace', () => {
  it('shows the desk whether it can deal, its deals in its own words with whose move it is, and its turnover from the books', async () => {
    await livePrices();
    const ws = await deskWorkspace(w.app, desk.admin.userId);
    expect(ws).toMatchObject({ state: 'OPEN', canAdmin: true, canCommit: true, desk: { id: deskId, status: 'LIVE' } });
    expect((await deskWorkspace(w.app, desk.member.userId))).toMatchObject({ state: 'OPEN', canAdmin: false, canCommit: false });

    const before = await deskToday(w.app, desk.admin.userId);
    expect(before.readiness).toEqual({ approved: true, reserve: true, destinations: true, liquidity: true, network: true, prices: true, live: true });
    expect(before.prices.SELL_USDT).toMatchObject({ rate: '100.900000', offered: true });
    expect(before.feeBps).toBe(25);
    // The two deals run end to end above are in the thirty days, with INRP2P's fee on each.
    expect(before.periods.month.deals).toBeGreaterThanOrEqual(2);
    expect(Money.parse(before.periods.month.fees, 'USDT').minor).toBeGreaterThanOrEqual(usdt('27.5'));

    // A client asks: the desk sees it holding its price, with the client's name and the fee.
    const clientName = (await w.app.selectFrom('client').select('display_name').where('id', '=', w.clientId).executeTakeFirstOrThrow()).display_name;
    const request = await deskRequest('SELL_USDT', '1000');
    const quote = await quoteDeal(request.requestId);
    const ref = await orderRefOf(quote.orderId);
    const asking = (await deskDeals(w.app, desk.admin.userId, 'open')).deals.find((d) => d.ref === ref);
    expect(asking).toMatchObject({ state: 'ASKING', clientName, direction: 'SELL_USDT', via: 'PAGE', usdt: '1000.000000', inr: '100900.00', deskUsdt: '997.500000', fee: '2.500000', yourMove: false });
    expect(asking!.dueBy).not.toBeNull();

    // It accepts and its USDT arrives in escrow: the desk owes the rupees — its move, until the step's time runs out.
    const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
    await settleFirstLeg(w, accepted.tradeId);
    const today = await deskToday(w.app, desk.admin.userId);
    expect(today.yourMove.find((d) => d.ref === ref)).toMatchObject({ state: 'IN_PROGRESS', step: 'PAY', stage: 'YOUR_TURN', yourMove: true, tradeRef: await refOf(accepted.tradeId) });
    expect(await deskDeal(w.app, desk.admin.userId, ref)).toMatchObject({ ref, clientName, yourMove: true });

    // Completed deals are listed with what the desk received and the fee; another desk's deal is not found.
    const done = (await deskDeals(w.app, desk.admin.userId, 'done')).deals;
    expect(done.length).toBeGreaterThanOrEqual(2);
    expect(done.every((d) => d.state === 'COMPLETED' || d.state === 'CANCELLED')).toBe(true);
    await expect(deskDeal(w.app, other.admin.userId, ref)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // What the desk is never shown: INRP2P's side of a deal.
    expect(() => assertDeskSafe({ deals: [{ grossMarginBase: '1' }] })).toThrow(/leaks key/);
    expect(() => assertDeskSafe(today)).not.toThrow();
  });

  it('is a trader’s: someone who is not one is sent to become one; a trader without a desk can open one', async () => {
    const plain = await createTestClientLogin(w.t.owner, { emailVerified: true });
    const c = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: 'Plain Private Limited', displayName: 'Plain', type: 'COMPANY' as const });
    await runAs(w.app, linkClientUser(w.owner.actor), w.owner.ref, 'client_user.link', { clientId: c.clientId, userId: plain.userId, role: 'CLIENT_ADMIN' as const });
    expect(await deskWorkspace(w.app, plain.userId)).toMatchObject({ state: 'NOT_TRADER', desk: null });
    const third = await railsTrader(w, 'Third Desk', { sell: { capacity: '1000', rate: '101.70', min: '10', max: '1000' } }, '0');
    expect(await deskWorkspace(w.app, third.admin.userId)).toMatchObject({ state: 'NO_DESK', traderStatus: 'APPROVED', canAdmin: true });
    await expect(deskToday(w.app, third.admin.userId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---- block 7: the client's side ---------------------------------------------------------------------------------------

describe('a client dealing with desks', () => {
  it('sees the price it holds at a desk, its deals there and its list of desks — never on the INRP2P Exchange, never as inbox noise', async () => {
    await livePrices();
    const asked = await runAs(w.app, requestDeskQuote(bharat.admin.actor, w.railsDeps), bharat.admin.ref, 'desk_deal.request_quote', {
      handle: 'rahul', direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1200', bankAccountId: bharat.bankAccountId,
    });
    const state = await clientDeskState(w.app, bharat.clientId, deskId);
    expect(state.relation).toMatchObject({ status: 'ACTIVE' });
    expect(state.liveQuote).toMatchObject({ direction: 'SELL_USDT', base: { amount: '1200.000000' }, inr: { amount: '121080.00' }, clientRate: '100.900000', status: 'SENT' });
    expect(JSON.stringify(state)).not.toMatch(/deskBase|platformFee|fee_|bps/);

    // The Exchange is the INRP2P desk's conversation: the desk's request is not shown there.
    expect((await exchangeView(w.app, bharat.clientId)).request).toBeNull();
    // Nor is "your quote is ready" told for a price the client is looking at.
    const before = await w.app.selectFrom('client_notification').select('id').where('client_id', '=', bharat.clientId).execute();
    await dispatchOutbox(w.t.worker, [clientNotificationHandler(w.app), acknowledgedSignalHandler(), { name: 'rest', handles: () => true, run: async () => {} }]);
    const after = await w.app.selectFrom('client_notification').select('kind').where('client_id', '=', bharat.clientId).execute();
    expect(after.filter((n) => n.kind === 'QUOTE_SENT')).toHaveLength(0);
    expect(after.length).toBeGreaterThanOrEqual(before.length);

    const mine = await clientDesks(w.app, bharat.clientId);
    expect(mine.find((d) => d.handle === 'rahul')).toMatchObject({ displayName: 'Rahul OTC Desk', deskStatus: 'LIVE', relation: 'ACTIVE', prices: { SELL_USDT: '100.900000', BUY_USDT: '102.100000' } });
    expect(asked.quoteId).toBeTruthy();
  });

  it('takes a link: before, the deal; after, its own price; once accepted, its trade', async () => {
    let token = '';
    await runAs(w.app, createDeskDealLink(desk.admin.actor, (t) => { token = t; }), desk.admin.ref, 'desk_deal_link.create', {
      direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '900', rate: '100.800000', validMinutes: 60,
    });
    const fresh = await clientLinkState(w.app, bharat.clientId, token);
    expect(fresh).toMatchObject({ mine: false, liveQuote: null, tradeRef: null, link: { state: 'OPEN', base: '900.000000', inr: '90720.00' } });
    const quote = await runAs(w.app, claimDeskDealLink(bharat.admin.actor, w.railsDeps), bharat.admin.ref, 'desk_deal_link.claim', { token, bankAccountId: bharat.bankAccountId });
    const taken = await clientLinkState(w.app, bharat.clientId, token);
    expect(taken).toMatchObject({ mine: true, link: { state: 'TAKEN' }, liveQuote: { clientRate: '100.800000', base: { amount: '900.000000' } } });
    // Someone else sees it taken, and not theirs.
    expect(await clientLinkState(w.app, w.clientId, token)).toMatchObject({ mine: false, liveQuote: null, link: { state: 'TAKEN' } });
    const accepted = await runAs(w.app, acceptQuote(bharat.admin.actor, w.railsDeps), bharat.admin.ref, 'quote.accept', { quoteId: quote.quoteId });
    expect(await clientLinkState(w.app, bharat.clientId, token)).toMatchObject({ mine: true, tradeRef: accepted.tradeRef, link: { state: 'DONE' } });
    expect((await clientDeskState(w.app, bharat.clientId, deskId)).deals.map((d) => d.tradeRef)).toContain(accepted.tradeRef);
    expect(await clientLinkState(w.app, bharat.clientId, 'not-a-token')).toBeNull();
  });
});

// ---- block 8: Telegram ------------------------------------------------------------------------------------------------

describe('a desk’s alerts in Telegram', () => {
  const SYSTEM_REF = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
  const bot = new FakeTelegram();
  const startCode = async () => {
    let code = '';
    await runAs(w.app, startTelegramLink(desk.admin.actor, (c) => { code = c; }), desk.admin.ref, 'telegram_link.start', {});
    return code;
  };
  const complete = (code: string, chatId: string) =>
    executeCommand(w.app, completeTelegramLink(), { name: 'telegram_link.complete', actor: SYSTEM_REF, payload: { code, chatId, username: 'rahul_otc' }, idempotencyKey: randomUUID(), financial: false }).then((o) => o.result);
  const deliver = () => dispatchOutbox(w.t.worker, [telegramOrderHandler(w.app, bot, { linkBase: 'https://app.inrp2p.test' }), { name: 'rest', handles: () => true, run: async () => {} }], { batchSize: 1000 });

  it('links a chat by a one-time code the person sends the bot; the code works once and only in time; /stop ends it', async () => {
    const code = await startCode();
    expect(await telegramLinkOf(w.app, desk.admin.userId)).toMatchObject({ status: 'PENDING' });
    expect(await complete(code, '777001')).toEqual({ linked: true, clientName: expect.any(String) });
    expect(await telegramLinkOf(w.app, desk.admin.userId)).toMatchObject({ status: 'ACTIVE', username: 'rahul_otc' });
    expect(await complete(code, '777002')).toEqual({ linked: false });
    // Only the system — the webhook — completes a link.
    await expect(runAs(w.app, completeTelegramLink(), desk.admin.ref, 'telegram_link.complete', { code, chatId: '1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // An expired code links nothing.
    const late = await startCode();
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + 16 * 60_000));
    expect(await executeCommand(clock.db, completeTelegramLink(), { name: 'telegram_link.complete', actor: SYSTEM_REF, payload: { code: late, chatId: '777003' }, idempotencyKey: randomUUID(), financial: false }).then((o) => o.result)).toEqual({ linked: false });
    await clock.set(null);
    const stopped = await executeCommand(w.app, stopTelegramChat(), { name: 'telegram_link.stop', actor: SYSTEM_REF, payload: { chatId: '777001' }, idempotencyKey: randomUUID(), financial: false });
    expect(stopped.result).toEqual({ stopped: 1 });
    expect((await telegramLinkOf(w.app, desk.admin.userId)).status).not.toBe('ACTIVE');
  });

  it('tells the desk of a new deal and its move, once each, naming its client; a chat that blocked the bot is let go', async () => {
    await livePrices();
    expect(await complete(await startCode(), '888001')).toMatchObject({ linked: true });
    const clientName = (await w.app.selectFrom('client').select('display_name').where('id', '=', w.clientId).executeTakeFirstOrThrow()).display_name;
    const request = await deskRequest('SELL_USDT', '1000');
    const quote = await quoteDeal(request.requestId);
    const ref = await orderRefOf(quote.orderId);
    const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId: quote.quoteId });
    await deliver();
    const failedEvents = await w.app.selectFrom('outbox_event').select(['type', 'last_error']).where('type', 'in', ['trader.order_started']).where('last_error', 'is not', null).execute();
    expect(failedEvents).toEqual([]);
    const started = bot.to('888001').filter((m) => m.text.includes(ref));
    expect(started).toHaveLength(1);
    expect(started[0]!.text).toContain(`New deal ${ref}`);
    expect(started[0]!.text).toContain(`${clientName} sells you 1,000 USDT at ₹100.90 (₹100,900)`);
    expect(started[0]!.button).toEqual({ text: 'Open in INRP2P', url: `https://app.inrp2p.test/desk/deals/${ref}` });

    // The client's USDT confirmed in escrow: the desk's move is to pay.
    await settleFirstLeg(w, accepted.tradeId);
    await deliver();
    await deliver();
    const move = bot.to('888001').filter((m) => m.text.startsWith(`Your move · ${ref}`));
    expect(move).toHaveLength(1);
    expect(move[0]!.text).toContain(`Pay ₹100,900 to ${clientName}`);
    const rows = await w.app.selectFrom('telegram_delivery').select(['status', 'provider_message_id']).where('dedupe_key', 'like', `%:${quote.orderId}`).execute();
    expect(rows.every((r) => r.status === 'SENT' && r.provider_message_id !== null)).toBe(true);

    // Ten minutes before the payment step runs out, a reminder; a chat that blocked the bot is revoked.
    const due = await ordersDueSoon(w.app, { withinMinutes: 10, now: new Date(Date.now() + 25 * 60_000) });
    expect(due.find((d) => d.orderId === quote.orderId)).toMatchObject({ step: 'PAY' });
    const facts = (await orderFacts(w.app, quote.orderId))!;
    expect(orderAlertText(facts, 'DEADLINE', 5)).toBe(`5 minutes left · ${ref}\nPay ₹100,900 to ${clientName}.`);
    bot.failNext = 'BLOCKED';
    const ids = await queueTelegram(w.app, { clientId: facts.traderClientId, dedupeKey: `deadline:${quote.orderId}:PAY`, body: orderAlertText(facts, 'DEADLINE', 5)!, buttonUrl: null });
    expect(await sendTelegramDeliveries(w.app, bot, ids)).toEqual({ sent: 0, failed: 1 });
    expect((await telegramLinkOf(w.app, desk.admin.userId)).status).toBeNull();
    expect(await ordersDueSoon(w.app, { withinMinutes: 10, now: new Date(Date.now() + 25 * 60_000) })).toEqual([]);
  });
});

describe('INRP2P’s desk over the desks (block 11)', () => {
  const moderate = <P, R>(def: (a: typeof w.owner.actor) => Parameters<typeof runAs<P, R>>[1], name: string, payload: P, who = w.owner) => runAs(w.app, def(who.actor), who.ref, name, payload);
  const current = () => deskOfTrader(w.app, desk.traderId).then((d) => d!);
  const told = async (action: string) =>
    (await w.app.selectFrom('outbox_event').select('payload').where('type', '=', 'trader.desk_moderated').where('aggregate_id', '=', deskId).execute()).some((e) => (e.payload as { action?: string }).action === action);

  it('takes a page down with the reason its desk reads, and puts it back once INRP2P has looked again', async () => {
    const d = await current();
    if (d.status !== 'LIVE') await runAs(w.app, setDeskStatus(desk.admin.actor), desk.admin.ref, 'desk.set_status', { expectedVersion: d.version, status: 'LIVE' as const });
    const handle = (await current()).handle;
    expect(await deskPage(w.app, handle)).not.toBeNull();
    // Only a role that moderates, and only with a reason worth reading.
    await expect(moderate(hideDeskPage, 'desk.hide_page', { deskId, reason: 'bad name' }, w.settlementOp)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(moderate(hideDeskPage, 'desk.hide_page', { deskId, reason: 'no' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await moderate(hideDeskPage, 'desk.hide_page', { deskId, reason: 'The name suggests a bank; choose one that does not' });
    expect(await deskPage(w.app, handle)).toBeNull();
    expect(await liveDeskHandles(w.app)).not.toContain(handle);
    expect(await told('PAGE_HIDDEN')).toBe(true);
    const ws = await deskWorkspace(w.app, desk.admin.userId);
    expect(ws.desk).toMatchObject({ pageHiddenReason: 'The name suggests a bank; choose one that does not', status: 'LIVE' });
    // The desk changes its name: INRP2P sees there is something to look at again.
    expect((await opsDesk(w.app, deskId))!.editedSinceHidden).toBe(false);
    await runAs(w.app, updateDesk(desk.admin.actor), desk.admin.ref, 'desk.update', { expectedVersion: (await current()).version, displayName: 'Rahul Exchange' });
    expect((await opsDesk(w.app, deskId))!).toMatchObject({ pageHidden: true, editedSinceHidden: true, name: 'Rahul Exchange' });
    await moderate(showDeskPage, 'desk.show_page', { deskId, note: 'Thanks — the new name is fine' });
    expect(await deskPage(w.app, handle)).toMatchObject({ displayName: 'Rahul Exchange', status: 'LIVE' });
    expect(await told('PAGE_SHOWN')).toBe(true);
  });

  it('suspends a desk: what its clients ask now is withdrawn and nothing new is priced, until INRP2P lifts it', async () => {
    const asking = await deskRequest('SELL_USDT', '150');
    await moderate(suspendDesk, 'desk.suspend', { deskId, reason: 'Three complaints of late payments this week' });
    expect((await w.app.selectFrom('trade_request').select('status').where('id', '=', asking.requestId).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
    await expect(deskRequest('SELL_USDT', '150')).rejects.toMatchObject({ code: 'DESK_NOT_LIVE' });
    const d = await current();
    expect(d).toMatchObject({ status: 'SUSPENDED', suspensionReason: 'Three complaints of late payments this week' });
    // The world sees a paused desk; the desk cannot take itself live again.
    expect(await deskPage(w.app, d.handle)).toMatchObject({ status: 'PAUSED' });
    await expect(runAs(w.app, setDeskStatus(desk.admin.actor), desk.admin.ref, 'desk.set_status', { expectedVersion: d.version, status: 'LIVE' as const }))
      .rejects.toMatchObject({ code: 'DESK_NOT_LIVE', message: expect.stringContaining('suspended') });
    expect((await opsDesks(w.app))[0]).toMatchObject({ deskId, status: 'SUSPENDED' });
    await moderate(resumeDesk, 'desk.resume', { deskId });
    expect(await current()).toMatchObject({ status: 'PAUSED', suspensionReason: null });
    await runAs(w.app, setDeskStatus(desk.admin.actor), desk.admin.ref, 'desk.set_status', { expectedVersion: (await current()).version, status: 'LIVE' as const });
    expect((await current()).status).toBe('LIVE');
    expect(await told('SUSPENDED')).toBe(true);
    expect(await told('RESUMED')).toBe(true);
  });

  it('renames a live desk — the only way its address ever changes', async () => {
    const before = (await current()).handle;
    await expect(runAs(w.app, updateDesk(desk.admin.actor), desk.admin.ref, 'desk.update', { expectedVersion: (await current()).version, handle: 'rahul-new' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(moderate(renameDesk, 'desk.rename', { deskId, handle: 'other-desk-x', reason: 'Too close to a bank' }, w.dealer)).resolves.toMatchObject({ handle: 'other-desk-x' });
    expect(await deskPage(w.app, before)).toBeNull();
    expect(await deskPage(w.app, 'other-desk-x')).toMatchObject({ displayName: 'Rahul Exchange' });
    // The database refuses a live desk's new address unless INRP2P records it as its own decision.
    expect(await dbCode(w.app.updateTable('desk').set({ handle: 'sneaky-change' }).where('id', '=', deskId).execute())).toBe('IX121');
    expect(await told('RENAMED')).toBe(true);
    const history = (await opsDesk(w.app, deskId))!.history.map((h) => h.action);
    expect(history).toEqual(expect.arrayContaining(['desk.page_hidden', 'desk.page_shown', 'desk.suspended', 'desk.resumed', 'desk.renamed']));
  });

  it('changes the platform’s fee only when one person proposes it and another approves it', async () => {
    const before = await currentFeePolicy(w.app);
    const proposed = await moderate(proposeFeePolicy, 'fee_policy.propose', { ownDealBps: 30, networkDealBps: 60, reason: 'Test: a fee of 0.3% on a desk’s own deal' }, w.finance);
    await expect(moderate(proposeFeePolicy, 'fee_policy.propose', { ownDealBps: 35, networkDealBps: 60, reason: 'A second proposal at the same time' }, w.owner)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await feePolicyView(w.app)).proposal).toMatchObject({ ownDealBps: 30, networkDealBps: 60 });
    // Never the proposer; never a role without the right.
    await expect(moderate(decideFeePolicy, 'fee_policy.decide', { proposalId: proposed.proposalId, decision: 'APPROVE' as const }, w.finance)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(moderate(decideFeePolicy, 'fee_policy.decide', { proposalId: proposed.proposalId, decision: 'APPROVE' as const }, w.dealer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await currentFeePolicy(w.app)).ownDealBps).toBe(before.ownDealBps);
    await moderate(decideFeePolicy, 'fee_policy.decide', { proposalId: proposed.proposalId, decision: 'APPROVE' as const, note: 'agreed with the owner' });
    expect((await currentFeePolicy(w.app)).ownDealBps).toBe(30);
    const latest = await w.app.selectFrom('fee_policy').select(['set_by', 'approved_by']).orderBy('set_at', 'desc').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(latest).toEqual({ set_by: w.finance.actor.userId, approved_by: w.owner.actor.userId });
    // A new price carries it.
    const req = await deskRequest('SELL_USDT', '200');
    const q = await quoteDeal(req.requestId);
    expect((await w.app.selectFrom('quote').select('platform_fee_bps').where('id', '=', q.quoteId).executeTakeFirstOrThrow()).platform_fee_bps).toBe(30);
    // Withdrawn by its proposer, nothing changes.
    const back = await moderate(proposeFeePolicy, 'fee_policy.propose', { ownDealBps: before.ownDealBps, networkDealBps: 60, reason: 'Back to the owner’s fee after the test' }, w.finance);
    await expect(moderate(withdrawFeePolicy, 'fee_policy.withdraw', { proposalId: back.proposalId }, w.owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await moderate(withdrawFeePolicy, 'fee_policy.withdraw', { proposalId: back.proposalId }, w.finance);
    expect((await feePolicyView(w.app)).proposal).toBeNull();
    expect((await currentFeePolicy(w.app)).ownDealBps).toBe(30);
    expect(await openDisputes(w.app)).toEqual([]);
  });
});
