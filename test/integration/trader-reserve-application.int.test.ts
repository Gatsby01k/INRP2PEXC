import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import { traderNotificationHandler } from '@inrp2p/notifications';
import { globalImbalance, routeObligationBalances } from '@inrp2p/ledger';
import {
  confirmPayout, confirmRefundLeg, confirmRouteSettlement, createPayoutLeg, createRefundLeg, openException, recordLegEvidence, recordRouteSettlement, refundAndCancel,
  sendPayoutLeg, submitTxForVerification,
} from '@inrp2p/settlement';
import {
  approveReserveApplication, cancelReserveApplication, deskTrader, endReserveApplication, reconcileOrderNow, recordReserveApplicationSent, rejectReserveApplication,
  requestReserveApplication, requestReserveWithdrawal, reserveFigures, sharedReserveAddress, traderHome,
} from '@inrp2p/traders';
import type { TestOperator } from '@inrp2p/identity/testing';
import { balanceOf, clientDepositAddressOf, journalsFor, observe, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import {
  type TraderSetup, type TradersWorld, clientRequest, configureProgram, confirmOnChain, createTradersWorld, liveTrader, traderClient, tradeThroughTrader, utr,
} from './traders-world.ts';

/**
 * D3 (TD-21): a trader's Security Reserve applied to the USDT one of its own orders did not deliver — two people,
 * moved by custody between exchange addresses, one movement and one journal — after which the client is paid from it
 * like from any delivery. Nothing is converted and nothing beyond the order's own USDT is taken.
 */
let w: TradersWorld;
let seller: TraderSetup;
let sellerId: string;
let reserveAddress: string;
beforeAll(async () => {
  w = await createTradersWorld('reserve_application');
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true });
  seller = await traderClient(w, 'Reserve Seller');
  sellerId = (await liveTrader(w, seller, { sell: { capacity: '5000', rate: '105.20', min: '100', max: '2500' }, reserve: '800' })).traderId;
  // The one reserve address every trader funds (D-17): an exchange wallet, which is where custody moves it from.
  reserveAddress = (await sharedReserveAddress(w.app))!.address;
});
afterAll(async () => w.close());

const usdt = (v: string) => Money.parse(v, 'USDT').minor;
const request = (who: TestOperator, orderId: string, extra: Record<string, unknown> = {}) =>
  runAs(w.app, requestReserveApplication(who.actor), who.ref, 'trader_reserve.request_application', { orderId, reason: 'the trader stopped answering and its USDT did not arrive', ...extra });
const approve = (who: TestOperator, applicationId: string) =>
  runAs(w.app, approveReserveApplication(who.actor, w.traderDeps), who.ref, 'trader_reserve.approve_application', { applicationId });
const statusOf = async (applicationId: string) => (await w.app.selectFrom('trader_reserve_application').select('status').where('id', '=', applicationId).executeTakeFirstOrThrow()).status;

/** A client's Buy USDT trade on the seller's route, funded by the client; the trader's USDT never comes. */
async function undeliveredOrder(amount = '500') {
  const trade = await tradeThroughTrader(w, seller, { requestId: await clientRequest(w, 'BUY_USDT', amount), clientRate: '106.000000' });
  await settleFirstLeg(w, trade.tradeId);
  return trade;
}

describe('applying a trader’s Security Reserve to USDT it did not deliver (D3)', () => {
  it('two people, custody moves it, the chain confirms it, one journal — and the client is paid from it', async () => {
    const early = await tradeThroughTrader(w, seller, { requestId: await clientRequest(w, 'BUY_USDT', '100'), clientRate: '106.000000' });
    // Not before the trader's turn: until the client's INR is confirmed nothing of the trader's is due.
    await expect(request(w.financeOp, early.orderId)).rejects.toMatchObject({ code: 'TRADER_ACTION_NOT_DUE' });

    const trade = await undeliveredOrder('500');
    // The desk sees where the reserve may be applied: the started order whose USDT is due.
    expect((await deskTrader(w.app, sellerId)).applicableOrders).toEqual(expect.arrayContaining([{ orderId: trade.orderId, ref: trade.orderRef, kind: 'APPLY', owed: '500.000000', owedAsset: 'USDT' }]));
    await expect(request(w.dealer, trade.orderId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(request(w.financeOp, trade.orderId, { amount: '500.000001' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(request(w.financeOp, trade.orderId, { reason: 'late' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const asked = await request(w.financeOp, trade.orderId);
    expect(asked).toMatchObject({ ref: expect.stringMatching(/^RA-\d{6,}$/), amount: '500.000000' });
    await expect(request(w.financeOp2, trade.orderId)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // Asked is not approved: nothing is held yet.
    expect((await reserveFigures(w.app, sellerId)).applying.isZero()).toBe(true);

    await expect(approve(w.financeOp, asked.applicationId)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(approve(w.settlementOp, asked.applicationId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const approved = await approve(w.financeOp2, asked.applicationId);
    // The trader never asked for its delivery address, so approval issued it.
    const delivery = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
      .select(['d.id', 'd.address']).where('a.route_obligation_id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    expect(approved).toMatchObject({ status: 'APPROVED', deliveryAddress: delivery.address });
    const onDesk = (await deskTrader(w.app, sellerId)).applications.find((a) => a.applicationId === asked.applicationId);
    expect(onDesk).toMatchObject({ status: 'APPROVED', orderRef: trade.orderRef, amount: '500.000000', deliveryAddress: delivery.address, requestedBy: w.financeOp.ref.id });
    const held = await reserveFigures(w.app, sellerId);
    expect({ applying: held.applying.toDecimalString(), balance: held.balance.toDecimalString() }).toEqual({ applying: '500.000000', balance: '800.000000' });
    // What is being applied is no longer the trader's to withdraw.
    await expect(runAs(w.app, requestReserveWithdrawal(seller.admin.actor), seller.admin.ref, 'trader_reserve.request_withdrawal', { amount: '300.000001' }))
      .rejects.toMatchObject({ code: 'TRADER_WITHDRAWAL_EXCEEDS_AVAILABLE' });

    // Custody moves it from the reserve address; the desk hands over the hash and the chain is read back.
    const wrong = w.chain.add({ from: reserveAddress, to: delivery.address, amountMinor: usdt('499') });
    const record = (txHash: string) => runAs(w.app, recordReserveApplicationSent(w.financeOp.actor, w.traderDeps), w.financeOp.ref, 'trader_reserve.record_application_sent', { applicationId: asked.applicationId, txHash });
    await expect(record(wrong.txHash)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    const stranger = w.chain.add({ from: encodeTronAddress(randomBytes(20)), to: delivery.address, amountMinor: usdt('500') });
    await expect(record(stranger.txHash)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const moved = w.chain.add({ from: reserveAddress, to: delivery.address, amountMinor: usdt('500') });
    const sent = await record(moved.txHash);
    expect(sent.status).toBe('SENT');
    await expect(record(moved.txHash)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    const confirmed = await confirmOnChain(w);
    expect(confirmed.routeSettled).toBeGreaterThanOrEqual(1);
    expect(await statusOf(asked.applicationId)).toBe('COMPLETED');
    const transfer = await w.app.selectFrom('route_settlement as s').innerJoin('crypto_transfer as c', 'c.id', 's.crypto_transfer_id')
      .select(['s.status', 's.reserve_application_id', 'c.id as transfer_id', 'c.payer_type']).where('s.route_obligation_id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    expect(transfer).toMatchObject({ status: 'CONFIRMED', reserve_application_id: asked.applicationId, payer_type: 'EXCHANGE_TREASURY' });
    // One movement, one journal: the debt to the trader and the route's debt shrink together; the treasury does not grow.
    expect(await journalsFor(w.app, transfer.transfer_id)).toEqual([`crypto:${transfer.transfer_id}:confirm`]);
    const lines = await sql<{ code: string; direction: string; amount_minor: string }>`
      select a.code, e.direction, e.amount_minor::text from ledger_entry e join ledger_account a on a.id = e.account_id
      join ledger_journal j on j.id = e.journal_id where j.posting_key = ${`crypto:${transfer.transfer_id}:confirm`} order by e.direction desc, a.code`.execute(w.app);
    expect(lines.rows.map((r) => [r.code.split(':').slice(0, 2).join(':'), r.direction, r.amount_minor])).toEqual([
      ['LIAB:TRADER_RESERVE', 'DR', '500000000'],
      ['ASSET:ROUTE_RECEIVABLE', 'CR', '500000000'],
    ]);
    const after = await reserveFigures(w.app, sellerId);
    expect({ balance: after.balance.toDecimalString(), applying: after.applying.toDecimalString() }).toEqual({ balance: '300.000000', applying: '0.000000' });
    expect(after.shortfall.toDecimalString()).toBe('200.000000');
    expect(await reconcileOrderNow(w.app, trade.orderId)).toBe('DELIVERED');

    // The client is paid from it like from any delivery (D-16): from the order's address, physically there (B2).
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '500', payer: 'EXCHANGE_ACCOUNT' as const, sourceDepositAddressId: delivery.id });
    await observe(w, delivery.address);
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
    const paid = w.chain.add({ from: delivery.address, to: client.address, amountMinor: usdt('500') });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: paid.txHash, logIndex: paid.logIndex });
    expect((await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() })).completed).toBe(true);

    // The trader is paid its INR from the client's, as agreed — delivery came first (DVP).
    const toTrader = await runAs(w.app, recordRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'TO_ROUTE' as const, amount: '52600.00', rail: 'IMPS' as const, utr: utr('OUT'), inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: toTrader.routeSettlementId });
    expect(await reconcileOrderNow(w.app, trade.orderId)).toBe('COMPLETED');
    expect(await routeObligationBalances(w.app, trade.routeObligationId)).toEqual([]);
    expect(await globalImbalance(w.app)).toEqual([]);

    // The trader sees it in its reserve's history — its own order and the amount, nothing about the client.
    const home = await traderHome(w.app, seller.admin.userId);
    expect(home.reserve?.history).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'APPLIED', orderRef: trade.orderRef, amount: '500.000000', status: 'APPLIED' })]));
    expect(JSON.stringify(home.reserve)).not.toMatch(/Acme|IX-|106\.0/);

    // The trader is told, in its own terms.
    await dispatchOutbox(w.t.worker, [traderNotificationHandler(w.app), { name: 'rest', handles: () => true, run: async () => {} }], { batchSize: 500 });
    const told = await w.app.selectFrom('client_notification').select(['kind', 'body']).where('client_id', '=', seller.clientId).where('kind', '=', 'TRADER_RESERVE_ISSUE').execute();
    expect(told.some((n) => n.body.includes(trade.orderRef) && n.body.includes('500.000000'))).toBe(true);
  });

  it('the scanner recognises the applied reserve from a treasury wallet; an unexpected amount is a case, not a delivery', async () => {
    // Top the reserve back up so there is something to apply.
    const top = w.chain.add({ from: seller.walletAddress, to: reserveAddress, amountMinor: usdt('700') });
    await runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: top.txHash, logIndex: top.logIndex });
    await confirmOnChain(w);
    expect((await reserveFigures(w.app, sellerId)).balance.toDecimalString()).toBe('1000.000000');

    const trade = await undeliveredOrder('400');
    const asked = await request(w.financeOp2, trade.orderId);
    const approved = await approve(w.finance, asked.applicationId);

    // Custody sends the wrong amount first: recorded and held for the desk, never counted as the delivery.
    const short = w.chain.add({ from: w.hotAddress, to: approved.deliveryAddress!, amountMinor: usdt('399') });
    const seen = await runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: short.txHash, logIndex: short.logIndex });
    expect(seen.exceptionId).toBeTruthy();
    const kase = await w.app.selectFrom('exception_case').select(['type', 'details']).where('id', '=', seen.exceptionId!).executeTakeFirstOrThrow();
    expect(kase.type).toBe('USDT_UNEXPECTED_SENDER');
    expect(JSON.stringify(kase.details)).toContain(`RESERVE_APPLICATION_AMOUNT:${asked.ref}`);
    expect(await statusOf(asked.applicationId)).toBe('APPROVED');

    // The right amount from the hot wallet: the scanner records it as the application's delivery by itself.
    const right = w.chain.add({ from: w.hotAddress, to: approved.deliveryAddress!, amountMinor: usdt('400') });
    const detected = await runAs(w.app, submitTxForVerification(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'crypto.submit_tx_for_verification', { txHash: right.txHash, logIndex: right.logIndex });
    expect(detected.exceptionId).toBeUndefined();
    expect(await statusOf(asked.applicationId)).toBe('SENT');
    await confirmOnChain(w);
    expect(await statusOf(asked.applicationId)).toBe('COMPLETED');
    // Between two treasury wallets the custody lines are in the same journal: still one journal for one movement.
    const transferId = (await w.app.selectFrom('crypto_transfer').select('id').where('tx_hash', '=', right.txHash).executeTakeFirstOrThrow()).id;
    expect(await journalsFor(w.app, transferId)).toHaveLength(1);
    const lines = await sql<{ code: string; direction: string }>`
      select a.code, e.direction from ledger_entry e join ledger_account a on a.id = e.account_id
      join ledger_journal j on j.id = e.journal_id where j.posting_key = ${`crypto:${transferId}:confirm`}`.execute(w.app);
    expect(lines.rows.map((r) => `${r.direction} ${r.code.split(':').slice(0, 2).join(':')}`).sort()).toEqual([
      'CR ASSET:ROUTE_RECEIVABLE', 'CR ASSET:TREASURY_USDT', 'DR ASSET:TREASURY_USDT', 'DR LIAB:TRADER_RESERVE',
    ]);
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'USDT', { routeObligationId: trade.routeObligationId })).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('only holds the reserve against INR, keeping the debt open; beyond the free reserve it is refused; it is withdrawn, declined or ended on the record', async () => {
    // An INR order: the reserve is USDT and no conversion terms exist, so it can only be held — never converted, never
    // posted — and the INR debt stays open.
    const inrTrader = await traderClient(w, 'Rupee Buyer');
    const inrLive = await liveTrader(w, inrTrader, { buy: { capacity: '500000', rate: '104.70', min: '1000', max: '250000' } });
    const inrTrade = await tradeThroughTrader(w, inrTrader, { requestId: await clientRequest(w, 'SELL_USDT', '100'), clientRate: '104.200000' });
    await settleFirstLeg(w, inrTrade.tradeId);
    await expect(request(w.financeOp, inrTrade.orderId)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(request(w.financeOp, inrTrade.orderId, { amount: '500.000001' })).rejects.toMatchObject({ code: 'TRADER_RESERVE_SHORT' });
    const hold = await request(w.financeOp, inrTrade.orderId, { amount: '200' });
    expect(hold.kind).toBe('HOLD');
    await expect(approve(w.financeOp, hold.applicationId)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    expect(await approve(w.financeOp2, hold.applicationId)).toMatchObject({ kind: 'HOLD', status: 'APPROVED', deliveryAddress: null });
    const owedBefore = await w.app.selectFrom('route_settlement_allocation').select(sql<string>`coalesce(sum(amount_minor), 0)::text`.as('n')).where('route_obligation_id', '=', inrTrade.routeObligationId).executeTakeFirstOrThrow();
    // Held: not withdrawable, nothing moved, nothing posted, the INR debt as it was.
    const heldFigures = await reserveFigures(w.app, inrLive.traderId);
    expect({ applying: heldFigures.applying.toDecimalString(), balance: heldFigures.balance.toDecimalString() }).toEqual({ applying: '200.000000', balance: '500.000000' });
    await expect(runAs(w.app, recordReserveApplicationSent(w.financeOp.actor, w.traderDeps), w.financeOp.ref, 'trader_reserve.record_application_sent', { applicationId: hold.applicationId, txHash: 'ab'.repeat(32) }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await balanceOf(w.app, 'LIAB:TRADER_RESERVE', 'USDT', { tradeId: inrTrade.tradeId })).toBe(0n);
    expect(owedBefore.n).toBe('0');
    // A hold is never a delivery, whatever code writes one.
    const inrRoute = await w.app.selectFrom('route_obligation').select('route_id').where('id', '=', inrTrade.routeObligationId).executeTakeFirstOrThrow();
    const stub = (await sql<{ id: string }>`
      insert into crypto_transfer (network, tx_hash, log_index, token_contract, from_address, to_address, amount_minor, payer_type, payee_type, source, created_by)
      values ('TRON', ${randomBytes(32).toString('hex')}, 0, ${w.chain.tokenContract}, ${w.hotAddress}, ${w.hotAddress}, ${usdt('200')}, 'EXCHANGE_TREASURY', 'EXCHANGE_TREASURY', 'OPERATOR_SUBMITTED', 'old-app')
      returning id`.execute(w.t.owner)).rows[0]!.id;
    await expect(sql`insert into route_settlement (route_id, route_obligation_id, obligation_side, flow, asset, amount_minor, transfer_kind, crypto_transfer_id, reserve_application_id, created_by)
                     values (${inrRoute.route_id}, ${inrTrade.routeObligationId}, 'ROUTE_DELIVERS', 'FROM_ROUTE_TO_EXCHANGE', 'USDT', ${usdt('200')}, 'CRYPTO', ${stub}, ${hold.applicationId}, 'old-app')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX095');
    // Released when the reason for it goes (here: the trader is paying after all), and the reserve is free again.
    await runAs(w.app, endReserveApplication(w.finance.actor), w.finance.ref, 'trader_reserve.end_application', { applicationId: hold.applicationId, reason: 'the trader paid the INR after all' });
    expect((await reserveFigures(w.app, inrLive.traderId)).applying.isZero()).toBe(true);
    // A hold never outlives its order: unwinding the client trade cancels the order, and what was held with it.
    const again = await request(w.financeOp, inrTrade.orderId, { amount: '100' });
    await approve(w.financeOp2, again.applicationId);
    const deposit = await clientDepositAddressOf(w, inrTrade.tradeId);
    const opened = await runAs(w.app, openException(w.dealer.actor), w.dealer.ref, 'exception.open', {
      type: 'TRADE_CANCELLATION' as const, subjectType: 'TRADE' as const, subjectId: inrTrade.tradeId, tradeId: inrTrade.tradeId, notes: 'the trader cannot pay; the client takes its USDT back',
    });
    await observe(w, deposit.address);
    const refund = await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: inrTrade.tradeId, sourceDepositAddressId: deposit.id });
    const back = w.chain.add({ from: deposit.address, to: w.clientSourceAddress, amountMinor: usdt('100') });
    await runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId: refund.legId, txHash: back.txHash });
    await runAs(w.app, refundAndCancel(w.owner.actor), w.owner.ref, 'exception.refund_and_cancel', { tradeId: inrTrade.tradeId, exceptionId: opened.exceptionId, reason: 'unwound: the trader did not pay' });
    expect(await reconcileOrderNow(w.app, inrTrade.orderId)).toBe('CANCELLED');
    expect(await statusOf(again.applicationId)).toBe('CANCELLED');
    expect((await reserveFigures(w.app, inrLive.traderId)).applying.isZero()).toBe(true);

    // More than the reserve holds free.
    const free = await reserveFigures(w.app, sellerId);
    const big = await undeliveredOrder('2000');
    await expect(request(w.financeOp, big.orderId)).rejects.toMatchObject({ code: 'TRADER_RESERVE_SHORT', details: { free: free.balance.toDecimalString() } });

    // Withdrawn by its requester; declined by someone else; an approved one ended before anything moved.
    const first = await request(w.financeOp, big.orderId, { amount: '100' });
    await expect(runAs(w.app, cancelReserveApplication(w.financeOp2.actor), w.financeOp2.ref, 'trader_reserve.cancel_application', { applicationId: first.applicationId, reason: 'not mine' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, cancelReserveApplication(w.financeOp.actor), w.financeOp.ref, 'trader_reserve.cancel_application', { applicationId: first.applicationId, reason: 'asked too early' });
    const second = await request(w.financeOp, big.orderId, { amount: '100' });
    await expect(runAs(w.app, rejectReserveApplication(w.financeOp.actor), w.financeOp.ref, 'trader_reserve.reject_application', { applicationId: second.applicationId, note: 'mine' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await runAs(w.app, rejectReserveApplication(w.financeOp2.actor), w.financeOp2.ref, 'trader_reserve.reject_application', { applicationId: second.applicationId, note: 'the trader says it is sending now' });
    const third = await request(w.financeOp, big.orderId, { amount: '100' });
    await approve(w.financeOp2, third.applicationId);
    expect((await reserveFigures(w.app, sellerId)).applying.toDecimalString()).toBe('100.000000');
    await runAs(w.app, endReserveApplication(w.finance.actor), w.finance.ref, 'trader_reserve.end_application', { applicationId: third.applicationId, reason: 'the trader delivered after all' });
    expect((await reserveFigures(w.app, sellerId)).applying.isZero()).toBe(true);
    const statuses = await w.app.selectFrom('trader_reserve_application').select(['ref', 'status']).where('trader_order_id', '=', big.orderId).orderBy('requested_at').execute();
    expect(statuses.map((s) => s.status)).toEqual(['CANCELLED', 'REJECTED', 'CANCELLED']);
  });

  it('the database holds the rules whatever code writes them (IX094, IX095)', async () => {
    const trade = await undeliveredOrder('100');
    const order = await w.app.selectFrom('trader_order').select(['id', 'route_obligation_id']).where('id', '=', trade.orderId).executeTakeFirstOrThrow();
    const user = w.financeOp.ref.id!;
    const insert = (values: { traderId?: string; orderId?: string; obligationId?: string; amount: bigint; status?: string; decidedBy?: string | null }) => sql`
      insert into trader_reserve_application (trader_id, trader_order_id, route_obligation_id, amount_minor, reason, status, requested_by, decided_by, decided_at)
      values (${values.traderId ?? sellerId}, ${values.orderId ?? order.id}, ${values.obligationId ?? order.route_obligation_id}, ${values.amount}, 'raw insert by old code',
              ${values.status ?? 'REQUESTED'}, ${user}, ${values.decidedBy ?? null}, ${values.decidedBy ? sql`now()` : null})`.execute(w.t.owner);
    // Approved by its own requester.
    await expect(insert({ amount: usdt('10'), status: 'APPROVED', decidedBy: user })).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    // More than the order owes; more than the reserve holds free.
    await expect(insert({ amount: usdt('100.000001') })).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX094');
    // Another trader's order.
    const other = await w.app.selectFrom('trader_order').select(['id', 'route_obligation_id']).where('trader_id', '<>', sellerId).where('route_obligation_id', 'is not', null).executeTakeFirstOrThrow();
    await expect(insert({ orderId: other.id, obligationId: other.route_obligation_id!, amount: usdt('1') })).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX094');

    // A delivery naming an application that is not approved.
    const pending = await request(w.financeOp, trade.orderId, { amount: '50' });
    const delivery = await approveDeliveryAddress(trade.routeObligationId);
    const route = await w.app.selectFrom('route_obligation').select('route_id').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    const transfer = async (from: string, amount: string, payer: string) => (await sql<{ id: string }>`
      insert into crypto_transfer (network, tx_hash, log_index, token_contract, from_address, to_address, amount_minor, payer_type, payee_type, source, created_by)
      values ('TRON', ${randomBytes(32).toString('hex')}, 0, ${w.chain.tokenContract}, ${from}, ${delivery}, ${usdt(amount)}, ${payer}, 'EXCHANGE_TREASURY', 'OPERATOR_SUBMITTED', 'old-app')
      returning id`.execute(w.t.owner)).rows[0]!.id;
    const settle = (transferId: string, amount: string, applicationId: string | null) => sql`
      insert into route_settlement (route_id, route_obligation_id, obligation_side, flow, asset, amount_minor, transfer_kind, crypto_transfer_id, reserve_application_id, created_by)
      values (${route.route_id}, ${trade.routeObligationId}, 'ROUTE_DELIVERS', 'FROM_ROUTE_TO_EXCHANGE', 'USDT', ${usdt(amount)}, 'CRYPTO', ${transferId}, ${applicationId}, 'old-app')`.execute(w.t.owner);
    await expect(settle(await transfer(reserveAddress, '50', 'EXCHANGE_TREASURY'), '50', pending.applicationId)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX095');
    // The exchange's own USDT booked as the trader's delivery, with no application: refused (D-16).
    await expect(settle(await transfer(w.hotAddress, '50', 'ROUTE'), '50', null)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX095');
    await expect(settle(await transfer(w.hotAddress, '50', 'EXCHANGE_TREASURY'), '50', null)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX095');
  });
});

/** Issues (or reads) an obligation's delivery address the way approval does, for the raw-insert checks. */
async function approveDeliveryAddress(obligationId: string): Promise<string> {
  const { allocateObligationDeliveryAddress } = await import('@inrp2p/treasury');
  const { executeCommand } = await import('@inrp2p/commands');
  const out = await executeCommand(w.app, {
    authorize: async () => {},
    handle: (ctx) => allocateObligationDeliveryAddress(ctx, w.traderDeps.custody, { network: 'TRON', routeObligationId: obligationId, reference: 'TEST', expectedAmount: Money.parse('100', 'USDT') }),
  }, { name: 'test.delivery_address', actor: { type: 'SYSTEM', id: null, surface: 'SYSTEM' }, payload: { obligationId }, financial: false });
  return out.result.address;
}
