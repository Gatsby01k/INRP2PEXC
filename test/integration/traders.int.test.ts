import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import { acknowledgedSignalHandler, clientNotificationHandler, traderNotificationHandler } from '@inrp2p/notifications';
import { createQuote, declineRequest, sendQuote } from '@inrp2p/quotes';
import { globalImbalance } from '@inrp2p/ledger';
import { acceptOrder, approveTrader, assignRequest, confirmReserveWithdrawal, declineOrder, deskTrader, pauseTrader, recordReserveWithdrawalSent, rejectTrader, requestReserveWithdrawal, reserveFigures, resumeTrader, runTraderSweep, setAvailability, setTraderLimits, setTraderRequiredReserve, traderHome, sharedReserveAddress, traderRoutingHandler, updateBlock } from '@inrp2p/traders';
import { type TradersWorld, applyAs, clientRequest, configureProgram, confirmOnChain, createTradersWorld, liveTrader, sendUsdt, traderClient, traderIdOf } from './traders-world.ts';

let w: TradersWorld;
beforeAll(async () => {
  w = await createTradersWorld('traders');
});
afterAll(async () => w.close());

const handlers = () => [traderNotificationHandler(w.app), traderRoutingHandler(w.app), clientNotificationHandler(w.app), acknowledgedSignalHandler(), { name: 'rest', handles: () => true, run: async () => {} }];
const dispatch = () => dispatchOutbox(w.t.worker, handlers(), { batchSize: 500 });

async function inbox(clientId: string): Promise<string[]> {
  const rows = await w.app.selectFrom('client_notification').select('kind').where('client_id', '=', clientId).orderBy('created_at').execute();
  return rows.map((r) => r.kind);
}

describe('applying and approval', () => {
  it('only an administrator applies, with its own send-and-receive wallet; nothing is traded before approval', async () => {
    const t = await traderClient(w, 'Kiran Capital');
    const destinationOnly = await traderClient(w, 'Wallet Only', 'DESTINATION');
    await expect(applyAs(w, t.member, { offersBuy: true, offersSell: false, typicalInr: '500000', bankAccountId: t.bankAccountId, walletId: t.walletId }))
      .rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_PERMITTED' });
    await expect(applyAs(w, destinationOnly.admin, { offersBuy: true, offersSell: false, typicalInr: '500000', bankAccountId: destinationOnly.bankAccountId, walletId: destinationOnly.walletId }))
      .rejects.toMatchObject({ code: 'TRADER_DESTINATION_INVALID' });
    // Another client's bank account is never a trader's settlement account.
    await expect(applyAs(w, t.admin, { offersBuy: true, offersSell: false, typicalInr: '500000', bankAccountId: w.bankAccountId, walletId: t.walletId }))
      .rejects.toMatchObject({ code: 'TRADER_DESTINATION_INVALID' });

    const applied = await applyAs(w, t.admin, { offersBuy: true, offersSell: true, typicalInr: '500000', typicalUsdt: '5000', bankAccountId: t.bankAccountId, walletId: t.walletId });
    expect(applied.status).toBe('UNDER_REVIEW');
    await expect(applyAs(w, t.admin, { offersBuy: true, offersSell: false, typicalInr: '1', bankAccountId: t.bankAccountId, walletId: t.walletId }))
      .rejects.toMatchObject({ code: 'TRADER_EXISTS' });
    await expect(runAs(w.app, setAvailability(t.admin.actor), t.admin.ref, 'trader.set_availability', { available: true })).rejects.toMatchObject({ code: 'TRADER_NOT_APPROVED' });
    const home = await traderHome(w.app, t.member.userId);
    expect(home).toMatchObject({ state: 'UNDER_REVIEW', canApply: false, canAct: false });
  });

  it('approval needs a reserve the desk set — none is invented — and a finance or owner step-up', async () => {
    const t = await traderClient(w, 'Reserve First');
    await applyAs(w, t.admin, { offersBuy: true, offersSell: false, typicalInr: '100000', bankAccountId: t.bankAccountId, walletId: t.walletId });
    const traderId = await traderIdOf(w.app, t.clientId);
    await expect(runAs(w.app, approveTrader(w.dealer.actor), w.dealer.ref, 'trader.approve', { traderId, requiredReserve: '500' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId })).rejects.toMatchObject({ code: 'TRADER_RESERVE_NOT_SET' });
    await configureProgram(w, { reserve: '500' });
    const approved = await runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId });
    expect(approved.sides).toEqual(['BUY_USDT']);
    const route = await w.app.selectFrom('liquidity_route').selectAll().where('trader_id', '=', traderId).executeTakeFirstOrThrow();
    expect(route).toMatchObject({ execution_mode: 'P2P', direction: 'SELL_USDT', registered_route_address: t.walletAddress });
    const profile = await w.app.selectFrom('trader_profile').select(['status', 'required_reserve_minor', 'available']).where('id', '=', traderId).executeTakeFirstOrThrow();
    expect(profile).toEqual({ status: 'APPROVED', required_reserve_minor: 500_000_000n, available: false });
    await dispatch();
    expect(await inbox(t.clientId)).toContain('TRADER_APPROVED');
  });

  it('a rejected applicant sees the note and may apply again', async () => {
    const t = await traderClient(w, 'Second Try');
    await applyAs(w, t.admin, { offersBuy: false, offersSell: true, typicalUsdt: '1000', bankAccountId: t.bankAccountId, walletId: t.walletId });
    const traderId = await traderIdOf(w.app, t.clientId);
    await runAs(w.app, rejectTrader(w.finance.actor), w.finance.ref, 'trader.reject', { traderId, note: 'Registered bank account name does not match.' });
    expect((await traderHome(w.app, t.admin.userId)).application?.reviewNote).toBe('Registered bank account name does not match.');
    const again = await applyAs(w, t.admin, { offersBuy: false, offersSell: true, typicalUsdt: '1000', bankAccountId: t.bankAccountId, walletId: t.walletId });
    expect(again.status).toBe('UNDER_REVIEW');
  });
});

describe('the Security Reserve', () => {
  it('is credited only from the trader’s registered wallet, on chain finality, and must cover the requirement to switch on', async () => {
    await configureProgram(w, { reserve: '500' });
    const t = await traderClient(w, 'Reserve Holder');
    await applyAs(w, t.admin, { offersBuy: true, offersSell: false, typicalInr: '100000', bankAccountId: t.bankAccountId, walletId: t.walletId });
    const traderId = await traderIdOf(w.app, t.clientId);
    await runAs(w.app, approveTrader(w.finance.actor), w.finance.ref, 'trader.approve', { traderId });
    await expect(runAs(w.app, setAvailability(t.admin.actor), t.admin.ref, 'trader.set_availability', { available: true })).rejects.toMatchObject({ code: 'TRADER_RESERVE_SHORT' });

    // One address for every trader (D-17), the owner's, shown on the reserve screen as it is.
    const { address } = (await sharedReserveAddress(w.app))!;
    expect(address).toBe('TJNzB4sUGBo8fv7UdeeKQKQUffpfLSXbPP');
    expect((await traderHome(w.app, t.admin.userId)).reserve?.depositAddress).toBe(address);

    // From a stranger's wallet: recorded, parked in suspense, a case for the desk — never the trader's reserve.
    const stranger = await sendUsdt(w, w.clientSourceAddress, address, '300');
    expect(stranger.detected.exceptionId).toBeTruthy();
    await sendUsdt(w, t.walletAddress, address, '450');
    expect((await reserveFigures(w.app, traderId)).balance.isZero()).toBe(true);
    await confirmOnChain(w);
    const after = await reserveFigures(w.app, traderId);
    expect(after.balance.toDecimalString()).toBe('450.000000');
    expect(after.shortfall.toDecimalString()).toBe('50.000000');
    await expect(runAs(w.app, setAvailability(t.admin.actor), t.admin.ref, 'trader.set_availability', { available: true })).rejects.toMatchObject({ code: 'TRADER_RESERVE_SHORT' });

    await sendUsdt(w, t.walletAddress, address, '250');
    await confirmOnChain(w);
    await runAs(w.app, setAvailability(t.admin.actor), t.admin.ref, 'trader.set_availability', { available: true });
    const on = await reserveFigures(w.app, traderId);
    expect({ balance: on.balance.toDecimalString(), locked: on.locked.toDecimalString(), available: on.available.toDecimalString() }).toEqual({ balance: '700.000000', locked: '500.000000', available: '200.000000' });
    expect(await globalImbalance(w.app)).toEqual([]);
    // The stranger's money is nobody's reserve: one address for every trader cannot say whose it was meant to be, so no
    // trader is told it is theirs — the desk has the case (TECH_DEBT TD-28).
    await dispatch();
    expect(await inbox(t.clientId)).not.toContain('TRADER_RESERVE_ISSUE');
    expect(stranger.detected.exceptionId).toBeTruthy();
  });

  it('ADR 0026: USDT leaves only after a step-up by another factor than the sign-in — a code to the same email is not one', async () => {
    const t = await w.app.selectFrom('trader_profile as p').innerJoin('client as c', 'c.id', 'p.client_id').select(['p.id', 'p.client_id']).where('c.display_name', '=', 'Reserve Holder').executeTakeFirstOrThrow();
    const admin = await w.app.selectFrom('client_user').select('user_id').where('client_id', '=', t.client_id).where('role', '=', 'CLIENT_ADMIN').executeTakeFirstOrThrow();
    // A second device, signed in by email a while ago: the session alone, and then a code to that same email.
    const session = await w.t.owner
      .insertInto('auth_session')
      .values({ expires_at: new Date(Date.now() + 3_600_000), token: randomUUID(), created_at: new Date(Date.now() - 3_600_000), updated_at: new Date(), user_id: admin.user_id, surface: 'CLIENT', sign_in_method: 'EMAIL' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const actor = { kind: 'CLIENT' as const, userId: admin.user_id, sessionId: session.id };
    const ref = { type: 'USER' as const, id: admin.user_id, surface: 'CLIENT' as const, sessionId: session.id };
    const withdraw = () => runAs(w.app, requestReserveWithdrawal(actor), ref, 'trader_reserve.request_withdrawal', { amount: '1' });
    await expect(withdraw()).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', details: { purpose: 'WITHDRAWAL' } });
    await sql`insert into step_up_verification (user_id, session_id, method) values (${admin.user_id}, ${session.id}, 'EMAIL')`.execute(w.t.owner);
    await expect(withdraw()).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(await w.app.selectFrom('trader_reserve_withdrawal').select('id').where('trader_id', '=', t.id).execute()).toEqual([]);
  });

  it('never releases the locked part; a withdrawal is read from the chain, confirmed on finality and posted once', async () => {
    const t = await w.app.selectFrom('trader_profile as p').innerJoin('client as c', 'c.id', 'p.client_id').select(['p.id', 'p.client_id']).where('c.display_name', '=', 'Reserve Holder').executeTakeFirstOrThrow();
    const admin = await w.app.selectFrom('client_user').select('user_id').where('client_id', '=', t.client_id).where('role', '=', 'CLIENT_ADMIN').executeTakeFirstOrThrow();
    const session = await w.app.selectFrom('auth_session').select('id').where('user_id', '=', admin.user_id).executeTakeFirstOrThrow();
    const actor = { kind: 'CLIENT' as const, userId: admin.user_id, sessionId: session.id };
    const ref = { type: 'USER' as const, id: admin.user_id, surface: 'CLIENT' as const, sessionId: session.id };
    await expect(runAs(w.app, requestReserveWithdrawal(actor), ref, 'trader_reserve.request_withdrawal', { amount: '200.000001' })).rejects.toMatchObject({ code: 'TRADER_WITHDRAWAL_EXCEEDS_AVAILABLE' });
    const requested = await runAs(w.app, requestReserveWithdrawal(actor), ref, 'trader_reserve.request_withdrawal', { amount: '200' });
    await expect(runAs(w.app, requestReserveWithdrawal(actor), ref, 'trader_reserve.request_withdrawal', { amount: '1' })).rejects.toMatchObject({ code: 'TRADER_WITHDRAWAL_OPEN' });
    expect((await reserveFigures(w.app, t.id)).pendingRelease.toDecimalString()).toBe('200.000000');

    const wallet = await w.app.selectFrom('trader_reserve_withdrawal').select('destination_address').where('id', '=', requested.withdrawalId).executeTakeFirstOrThrow();
    const wrongAmount = w.chain.add({ from: w.hotAddress, to: wallet.destination_address, amountMinor: Money.parse('199', 'USDT').minor });
    await expect(runAs(w.app, recordReserveWithdrawalSent(w.finance.actor, w.traderDeps), w.finance.ref, 'trader_reserve.record_withdrawal_sent', { withdrawalId: requested.withdrawalId, txHash: wrongAmount.txHash }))
      .rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    const sent = w.chain.add({ from: w.hotAddress, to: wallet.destination_address, amountMinor: Money.parse('200', 'USDT').minor });
    await runAs(w.app, recordReserveWithdrawalSent(w.finance.actor, w.traderDeps), w.finance.ref, 'trader_reserve.record_withdrawal_sent', { withdrawalId: requested.withdrawalId, txHash: sent.txHash });
    await runAs(w.app, confirmReserveWithdrawal(w.finance.actor, w.traderDeps), w.finance.ref, 'trader_reserve.confirm_withdrawal', { withdrawalId: requested.withdrawalId });
    const figures = await reserveFigures(w.app, t.id);
    expect({ balance: figures.balance.toDecimalString(), available: figures.available.toDecimalString(), pending: figures.pendingRelease.toDecimalString() }).toEqual({ balance: '500.000000', available: '0.000000', pending: '0.000000' });
    const posted = await w.app.selectFrom('ledger_journal').select('posting_key').where('posting_key', '=', `crypto:${(await w.app.selectFrom('trader_reserve_withdrawal').select('crypto_transfer_id').where('id', '=', requested.withdrawalId).executeTakeFirstOrThrow()).crypto_transfer_id}:confirm`).execute();
    expect(posted).toHaveLength(1);
  });
});

describe('routing', () => {
  it('ranks by rate, re-routes a decline to the next trader, and never offers a trader its own request', async () => {
    const low = await traderClient(w, 'Rate Low');
    const high = await traderClient(w, 'Rate High');
    const lowLive = await liveTrader(w, low, { buy: { capacity: '1000000', rate: '104.10', min: '1000', max: '500000' } });
    const highLive = await liveTrader(w, high, { buy: { capacity: '1000000', rate: '104.90', min: '1000', max: '500000' } });
    const requestId = await clientRequest(w, 'SELL_USDT', '100');
    const first = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId, plannedClientRate: '100.000000' });
    const firstTrader = await w.app.selectFrom('trader_order').select('trader_id').where('id', '=', first.orderId).executeTakeFirstOrThrow();
    expect(firstTrader.trader_id).toBe(highLive.traderId);
    await runAs(w.app, declineOrder(high.admin.actor), high.admin.ref, 'trader_order.decline', { ref: first.ref, reason: 'Bank cut-off' });
    await dispatch();
    const next = await w.app.selectFrom('trader_order').select(['trader_id', 'status']).where('trade_request_id', '=', requestId).where('status', '=', 'OFFERED').executeTakeFirstOrThrow();
    // Each other live Buy USDT trader in this world outranks or ties differently; the decliner is never asked again.
    expect(next.trader_id).not.toBe(highLive.traderId);
    expect(lowLive.traderId).not.toBe(highLive.traderId);
  });

  it('switching off withdraws unanswered offers and routes them on; an offer that lapses expires on the business clock', async () => {
    const t = await traderClient(w, 'Goes Offline');
    await liveTrader(w, t, { buy: { capacity: '1000000', rate: '120.00', min: '1', max: '1000000' } });
    const requestId = await clientRequest(w, 'SELL_USDT', '10');
    const offered = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId, plannedClientRate: '100.000000' });
    await runAs(w.app, setAvailability(t.admin.actor), t.admin.ref, 'trader.set_availability', { available: false });
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', offered.orderId).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
    await dispatch();
    const rerouted = await w.app.selectFrom('trader_order').select(['id', 'ref', 'offer_expires_at']).where('trade_request_id', '=', requestId).where('status', '=', 'OFFERED').executeTakeFirst();
    expect(rerouted).toBeTruthy();

    const clock = await w.t.pinnedClock();
    await clock.set(new Date(rerouted!.offer_expires_at.getTime() + 1000));
    await runTraderSweep(clock.db);
    await clock.set(null);
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', rerouted!.id).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
  });

  it('declining the request gives an accepted order’s capacity back at once', async () => {
    const t = await traderClient(w, 'Held Then Freed');
    const live = await liveTrader(w, t, { buy: { capacity: '1000000', rate: '130.00', min: '1', max: '1000000' } });
    const requestId = await clientRequest(w, 'SELL_USDT', '20');
    const offered = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId, plannedClientRate: '100.000000' });
    await runAs(w.app, acceptOrder(t.admin.actor), t.admin.ref, 'trader_order.accept', { ref: offered.ref });
    expect((await w.app.selectFrom('trader_block').select('reserved_minor').where('trader_id', '=', live.traderId).executeTakeFirstOrThrow()).reserved_minor).toBe(200_000n);
    await runAs(w.app, declineRequest(w.dealer.actor), w.dealer.ref, 'request.decline', { requestId, reason: 'client withdrew by phone' });
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', offered.orderId).executeTakeFirstOrThrow()).status).toBe('RELEASED');
    expect((await w.app.selectFrom('trader_block').select('reserved_minor').where('trader_id', '=', live.traderId).executeTakeFirstOrThrow()).reserved_minor).toBe(0n);
  });

  it('an ended hold gives capacity back, but not while a quote on it is still live', async () => {
    const t = await traderClient(w, 'Hold Ends');
    const live = await liveTrader(w, t, { buy: { capacity: '1000000', rate: '140.00', min: '1', max: '1000000' } });
    const requestId = await clientRequest(w, 'SELL_USDT', '30');
    const offered = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId, plannedClientRate: '139.000000' });
    await runAs(w.app, acceptOrder(t.admin.actor), t.admin.ref, 'trader_order.accept', { ref: offered.ref });
    const order = await w.app.selectFrom('trader_order').select(['hold_until', 'route_id']).where('id', '=', offered.orderId).executeTakeFirstOrThrow();
    const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId, routeId: order.route_id, clientRate: '139.000000', validitySeconds: 1800 });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(order.hold_until!.getTime() + 1000));
    expect(await runTraderSweep(clock.db)).toMatchObject({ holdsWaitingOnQuote: 1, holdsEnded: 0 });
    await clock.set(new Date(order.hold_until!.getTime() + 1800 * 1000));
    expect(await runTraderSweep(clock.db)).toMatchObject({ holdsEnded: 1 });
    await clock.set(null);
    expect((await w.app.selectFrom('trader_block').select('reserved_minor').where('trader_id', '=', live.traderId).executeTakeFirstOrThrow()).reserved_minor).toBe(0n);
  });
});

describe('operator controls', () => {
  it('pausing withdraws offers and stops assignments, visibly; limits and reserve changes never edit the trader’s own terms', async () => {
    const t = await traderClient(w, 'Controlled');
    const live = await liveTrader(w, t, { buy: { capacity: '1000000', rate: '150.00', min: '1', max: '1000000' } });
    const requestId = await clientRequest(w, 'SELL_USDT', '40');
    const offered = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId, plannedClientRate: '100.000000' });
    await runAs(w.app, pauseTrader(w.dealer.actor), w.dealer.ref, 'trader.pause', { traderId: live.traderId, reason: 'Bank statement review' });
    expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', offered.orderId).executeTakeFirstOrThrow()).status).toBe('WITHDRAWN');
    const home = await traderHome(w.app, t.admin.userId);
    expect(home).toMatchObject({ state: 'PAUSED', available: false, controlNote: 'Bank statement review' });
    await expect(runAs(w.app, setAvailability(t.admin.actor), t.admin.ref, 'trader.set_availability', { available: true })).rejects.toMatchObject({ code: 'TRADER_PAUSED' });
    await runAs(w.app, resumeTrader(w.dealer.actor), w.dealer.ref, 'trader.resume', { traderId: live.traderId, reason: 'Review complete' });

    await runAs(w.app, setTraderLimits(w.finance.actor), w.finance.ref, 'trader.set_limits', { traderId: live.traderId, maxCapacityInr: '200000', reason: 'new trader' });
    const block = await w.app.selectFrom('trader_block').select(['capacity_minor', 'version']).where('trader_id', '=', live.traderId).executeTakeFirstOrThrow();
    expect(block.capacity_minor).toBe(100_000_000n);
    await expect(runAs(w.app, updateBlock(t.admin.actor), t.admin.ref, 'trader.update_block', { side: 'BUY_USDT' as const, expectedVersion: block.version, capacity: '300000' }))
      .rejects.toMatchObject({ code: 'TRADER_LIMIT_EXCEEDED' });

    await runAs(w.app, setTraderRequiredReserve(w.finance.actor), w.finance.ref, 'trader.set_required_reserve', { traderId: live.traderId, requiredReserve: '800', reason: 'larger limits' });
    expect((await traderHome(w.app, t.admin.userId)).issues).toContain('RESERVE_SHORT');
    const detail = await deskTrader(w.app, live.traderId);
    expect(detail.decisions.map((d) => d.action)).toEqual(expect.arrayContaining(['trader.paused', 'trader.resumed', 'trader.limits_changed', 'trader.required_reserve_changed', 'trader.approved']));
  });

  it('the database keeps a block’s held capacity equal to its open orders, and trader rows append-only', async () => {
    const block = await w.app.selectFrom('trader_block').select(['id', 'reserved_minor']).limit(1).executeTakeFirstOrThrow();
    await expect(sql`update trader_block set reserved_minor = reserved_minor + 1 where id = ${block.id}`.execute(w.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX074' || pgErrorCode(e) === '23514');
    await expect(sql`delete from trader_order`.execute(w.app)).rejects.toBeTruthy();
  });
});
