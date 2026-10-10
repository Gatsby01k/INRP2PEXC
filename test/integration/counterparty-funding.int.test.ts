import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import {
  confirmPayout, confirmRefundLeg, confirmRouteSettlement, createPayoutLeg, createRefundLeg, recordLegEvidence, recordRouteSettlement, refundAndCancel,
  sendPayoutLeg,
} from '@inrp2p/settlement';
import { orderDeliveryAddress, reconcileOrderNow, reserveFigures, runTraderSweep, sharedReserveAddress, submitOrderPayment } from '@inrp2p/traders';
import { balanceOf, clientDepositAddressOf, newUtr, observe, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import {
  type TradersWorld, type TraderSetup, clientRequest, configureProgram, confirmOnChain, createTradersWorld, liveTrader, sendUsdt, traderClient, tradeThroughTrader, utr,
} from './traders-world.ts';

/**
 * Counterparty-funded execution (DECISIONS.md D-16), proved end to end with the real commands at zero platform
 * USDT and INR: every client payout is the trader's money, every payment to the trader is the client's, nothing of
 * the exchange's own treasury is reserved or moved, other trades' money and Security Reserves never stand in, and a
 * trader that does not deliver leaves the client's funds protected rather than advanced against.
 */
let w: TradersWorld;
let inrTrader: TraderSetup;
let usdtTrader: TraderSetup;
let inrTraderId: string;
let usdtTraderId: string;

beforeAll(async () => {
  w = await createTradersWorld('counterparty_funding');
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true });
  inrTrader = await traderClient(w, 'INR Provider');
  usdtTrader = await traderClient(w, 'USDT Provider');
  inrTraderId = (await liveTrader(w, inrTrader, { buy: { capacity: '5000000', rate: '104.70', min: '1000', max: '2000000' } })).traderId;
  usdtTraderId = (await liveTrader(w, usdtTrader, { sell: { capacity: '50000', rate: '105.20', min: '10', max: '20000' } })).traderId;
});
afterAll(async () => w.close());

const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const inr = (d: string) => Money.parse(d, 'INR').minor;
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow()).lifecycle_state;
const hotEntries = async () => (await sql<{ n: string }>`
  select count(*)::text as n from ledger_entry e join ledger_account a on a.id = e.account_id
  where a.code = ${`ASSET:TREASURY_USDT:${w.treasuryWalletId}`}`.execute(w.app)).rows[0]!.n;

const createPayout = (tradeId: string, amount: string, from: { inrAccountId?: string; treasuryWalletId?: string; sourceDepositAddressId?: string }) =>
  runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, ...from });

async function payInr(tradeId: string, amount: string, inrAccountId: string) {
  const leg = await createPayout(tradeId, amount, { inrAccountId });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr('PO') });
  return confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

async function payUsdtFrom(tradeId: string, amount: string, depositAddressId: string, address: string) {
  const leg = await createPayout(tradeId, amount, { sourceDepositAddressId: depositAddressId });
  await observe(w, address); // the worker's custody_observe, or the desk's refresh (B2)
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
  const sent = w.chain.add({ from: address, to: client.address, amountMinor: usdt(amount) });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: sent.txHash, logIndex: sent.logIndex });
  return confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

/** The trader's INR for a Buy USDT order: its own payment reference, confirmed by FINANCE against the bank. */
async function traderPaysInr(orderRef: string, amount?: string) {
  const claim = await runAs(w.app, submitOrderPayment(inrTrader.admin.actor, w.traderDeps), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: orderRef, rail: 'IMPS' as const, utr: utr(), ...(amount ? { amount } : {}) });
  const rs = await w.app.selectFrom('route_settlement').select('id').where('ref', '=', claim.settlementRef).executeTakeFirstOrThrow();
  await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: rs.id });
}

async function sendToTraderUsdt(routeObligationId: string, amount: string, deposit: { id: string; address: string }) {
  const sent = w.chain.add({ from: deposit.address, to: inrTrader.walletAddress, amountMinor: usdt(amount) });
  const rs = await runAs(w.app, recordRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.record', {
    routeObligationId, flow: 'TO_ROUTE' as const, amount, txHash: sent.txHash, logIndex: sent.logIndex, sourceDepositAddressId: deposit.id,
  });
  await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: rs.routeSettlementId });
}

describe('the platform holds no working capital', () => {
  it('starts with nothing of its own: no treasury balance, no reservation, nothing in the HOT wallet', async () => {
    expect(await w.app.selectFrom('treasury_wallet').select('id').where('observed_balance_minor', '>', 0n).execute()).toEqual([]);
    expect(await w.app.selectFrom('treasury_reservation').select('id').execute()).toEqual([]);
    expect(await hotEntries()).toBe('0');
  });
});

describe('a client sells USDT; an INR trader buys it (trader Buy USDT side)', () => {
  it('pays the client only with the trader’s INR, and the trader only with the client’s USDT, after it delivered', async () => {
    const trade = await tradeThroughTrader(w, inrTrader, { requestId: await clientRequest(w, 'SELL_USDT', '1000'), clientRate: '104.200000' });
    expect(await w.app.selectFrom('treasury_reservation').select('id').where('trade_id', '=', trade.tradeId).execute()).toEqual([]);
    // The trader's capacity is held for the order — a commitment, not money: nothing can be paid on it.
    const block = await w.app.selectFrom('trader_block').select('reserved_minor').where('trader_id', '=', inrTraderId).where('side', '=', 'BUY_USDT').executeTakeFirstOrThrow();
    expect(block.reserved_minor).toBe(inr('104700.00'));

    await settleFirstLeg(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('FIRST_LEG_CONFIRMED');
    // The client's leg is confirmed and the payout account holds other money — still no payout before the trader pays.
    await expect(createPayout(trade.tradeId, '104200.00', { inrAccountId: w.collectionAccountId })).rejects.toMatchObject({ code: 'FUNDING_NOT_CONFIRMED' });
    await expect(createPayout(trade.tradeId, '104200.00', { inrAccountId: w.inrAccountId })).rejects.toMatchObject({ code: 'FUNDING_NOT_CONFIRMED' });
    // Nor can the payment to the trader leave first.
    const deposit = await clientDepositAddressOf(w, trade.tradeId);
    await expect(sendToTraderUsdt(trade.routeObligationId, '1000', deposit)).rejects.toMatchObject({ code: 'COUNTERPARTY_NOT_DELIVERED' });
    // Whatever code wrote it, a payment to the counterparty before it delivered does not even insert (IX087).
    const route = await w.app.selectFrom('route_obligation').select('route_id').where('id', '=', trade.routeObligationId).executeTakeFirstOrThrow();
    await expect(sql`insert into route_settlement (route_id, route_obligation_id, obligation_side, flow, asset, amount_minor, transfer_kind, crypto_transfer_id, created_by)
                     values (${route.route_id}, ${trade.routeObligationId}, 'EXCHANGE_DELIVERS', 'TO_ROUTE', 'USDT', ${usdt('1000')}, 'CRYPTO', ${randomUUID()}, 'old-app')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX087');
    // Whatever code wrote it, an exchange-paid payout with no earmark does not commit (IX086).
    const bank = await w.app.selectFrom('trade_economics').select('bank_account_id').where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    await expect(sql`insert into settlement_leg (trade_id, seq, ref, side, asset, amount_minor, payer, inr_account_id, destination_bank_account_id, created_by)
                     values (${trade.tradeId}, 90, 'x', 'EXCHANGE_TO_CLIENT', 'INR', ${inr('104200.00')}, 'EXCHANGE_ACCOUNT', ${w.collectionAccountId}, ${bank.bank_account_id}, 'old-app')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX086');

    await traderPaysInr(trade.orderRef);
    expect(await reconcileOrderNow(w.app, trade.orderId)).toBe('DELIVERED');
    // The trader's INR is in the collection account: the client is paid from there, and from nowhere else.
    await expect(createPayout(trade.tradeId, '104200.00', { inrAccountId: w.inrAccountId })).rejects.toMatchObject({ code: 'FUNDING_LOCATION_MISMATCH' });
    const paid = await payInr(trade.tradeId, '104200.00', w.collectionAccountId);
    expect(paid.completed).toBe(true);

    // The client's USDT goes on to the trader from the deposit address it arrived at.
    await sendToTraderUsdt(trade.routeObligationId, '1000', deposit);
    expect((await runTraderSweep(w.app)).completed).toBeGreaterThanOrEqual(1);
    const order = await w.app.selectFrom('trader_order').select('status').where('id', '=', trade.orderId).executeTakeFirstOrThrow();
    expect(order.status).toBe('COMPLETED');

    // Every outgoing movement was earmarked against the right party's money of this trade, and is consumed.
    const earmarks = await w.app.selectFrom('funding_allocation').select(['use_kind', 'source_kind', 'status', 'amount_minor', 'location']).where('trade_id', '=', trade.tradeId).orderBy('created_at').execute();
    expect(earmarks).toEqual([
      { use_kind: 'CLIENT_PAYOUT', source_kind: 'COUNTERPARTY_FUNDS', status: 'CONSUMED', amount_minor: inr('104200.00'), location: `INR:${w.collectionAccountId}` },
      { use_kind: 'ROUTE_PAYMENT', source_kind: 'CLIENT_FUNDS', status: 'CONSUMED', amount_minor: usdt('1000'), location: `TRON:${deposit.address}` },
    ]);
    // The platform's own treasury never moved; the collection account keeps exactly the margin.
    expect(await hotEntries()).toBe('0');
    expect(await balanceOf(w.app, `ASSET:INR_SETTLEMENT:${w.collectionAccountId}`, 'INR', { tradeId: trade.tradeId })).toBe(inr('500.00'));
    expect(await balanceOf(w.app, 'REVENUE:GROSS_MARGIN', 'INR', { tradeId: trade.tradeId })).toBe(-inr('500.00'));
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('a client buys USDT; a USDT trader sells it (trader Sell USDT side)', () => {
  it('accepts at zero treasury, pays the client only the trader’s USDT, and the trader only the client’s INR', async () => {
    const trade = await tradeThroughTrader(w, usdtTrader, { requestId: await clientRequest(w, 'BUY_USDT', '500'), clientRate: '106.000000' });
    expect(await w.app.selectFrom('treasury_reservation').select('id').where('trade_id', '=', trade.tradeId).execute()).toEqual([]);
    await settleFirstLeg(w, trade.tradeId); // ₹53,000 into the payout account

    // No USDT can go to the client before the trader's USDT is final — not from the treasury, not from anywhere.
    await expect(createPayout(trade.tradeId, '500', { treasuryWalletId: w.treasuryWalletId })).rejects.toMatchObject({ code: 'FUNDING_NOT_CONFIRMED' });

    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    await sendUsdt(w, usdtTrader.walletAddress, address, '500');
    expect((await confirmOnChain(w)).routeSettled).toBe(1);
    const delivery = await w.app.selectFrom('deposit_address').select(['id', 'address']).where('address', '=', address).executeTakeFirstOrThrow();

    // The trader's USDT is at the order's delivery address: paid on from there, never from the HOT wallet.
    await expect(createPayout(trade.tradeId, '500', { treasuryWalletId: w.treasuryWalletId })).rejects.toMatchObject({ code: 'FUNDING_LOCATION_MISMATCH' });
    const paid = await payUsdtFrom(trade.tradeId, '500', delivery.id, delivery.address);
    expect(paid.completed).toBe(true);

    // The trader is paid its INR from the client's INR, where it arrived.
    const toTrader = await runAs(w.app, recordRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'TO_ROUTE' as const, amount: '52600.00', rail: 'IMPS' as const, utr: utr('OUT'), inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: toTrader.routeSettlementId });
    expect(await reconcileOrderNow(w.app, trade.orderId)).toBe('COMPLETED');

    expect(await hotEntries()).toBe('0');
    expect(await balanceOf(w.app, `ASSET:INR_SETTLEMENT:${w.inrAccountId}`, 'INR', { tradeId: trade.tradeId })).toBe(inr('400.00'));
    const delivered = await w.app.selectFrom('funding_allocation').select(['use_kind', 'source_kind', 'status']).where('trade_id', '=', trade.tradeId).orderBy('created_at').execute();
    expect(delivered).toEqual([
      { use_kind: 'CLIENT_PAYOUT', source_kind: 'COUNTERPARTY_FUNDS', status: 'CONSUMED' },
      { use_kind: 'ROUTE_PAYMENT', source_kind: 'CLIENT_FUNDS', status: 'CONSUMED' },
    ]);
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('nothing stands in for the trade’s own counterparty', () => {
  it('another trade’s money at the same account, and a Security Reserve, never fund this trade', async () => {
    const funded = await tradeThroughTrader(w, inrTrader, { requestId: await clientRequest(w, 'SELL_USDT', '2000'), clientRate: '104.200000' });
    await settleFirstLeg(w, funded.tradeId);
    await traderPaysInr(funded.orderRef); // ₹209,400 of the other trade now sits in the collection account

    const unfunded = await tradeThroughTrader(w, inrTrader, { requestId: await clientRequest(w, 'SELL_USDT', '1000'), clientRate: '104.200000' });
    await settleFirstLeg(w, unfunded.tradeId);
    await expect(createPayout(unfunded.tradeId, '104200.00', { inrAccountId: w.collectionAccountId })).rejects.toMatchObject({ code: 'FUNDING_NOT_CONFIRMED' });

    // Borrowing the other trade's source by hand is refused by the database (IX084).
    const source = await w.app.selectFrom('funding_source').select('source_id').where('trade_id', '=', funded.tradeId).where('kind', '=', 'COUNTERPARTY_FUNDS').executeTakeFirstOrThrow();
    const leg = await w.t.owner.transaction().execute(async (tx) => {
      await sql`set local session_replication_role = replica`.execute(tx);
      return (await sql<{ id: string }>`insert into settlement_leg (trade_id, seq, ref, side, asset, amount_minor, payer, inr_account_id, created_by)
        values (${unfunded.tradeId}, 91, 'stub', 'EXCHANGE_TO_CLIENT', 'INR', ${inr('104200.00')}, 'EXCHANGE_ACCOUNT', ${w.collectionAccountId}, 'test') returning id`.execute(tx)).rows[0]!.id;
    });
    await expect(sql`insert into funding_allocation (trade_id, source_kind, source_route_settlement_id, use_kind, use_leg_id, asset, amount_minor, location, created_by)
                     values (${unfunded.tradeId}, 'COUNTERPARTY_FUNDS', ${source.source_id}, 'CLIENT_PAYOUT', ${leg}, 'INR', ${inr('104200.00')}, ${`INR:${w.collectionAccountId}`}, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX084');

    // The USDT trader's Security Reserve sits at the shared reserve address (D-17); it pays nothing out.
    const reserveWallet = (await sharedReserveAddress(w.app))!;
    expect((await reserveFigures(w.app, usdtTraderId)).balance.isPositive()).toBe(true);
    const buy = await tradeThroughTrader(w, usdtTrader, { requestId: await clientRequest(w, 'BUY_USDT', '100'), clientRate: '106.000000' });
    await settleFirstLeg(w, buy.tradeId);
    await expect(createPayout(buy.tradeId, '100', { treasuryWalletId: reserveWallet.walletId })).rejects.toMatchObject({ code: 'FUNDING_NOT_CONFIRMED' });
  });
});

describe('a trader that does not deliver', () => {
  it('a partial delivery funds a partial payout only, and the client’s USDT stays put until the rest arrives', async () => {
    const trade = await tradeThroughTrader(w, inrTrader, { requestId: await clientRequest(w, 'SELL_USDT', '1000'), clientRate: '104.200000' });
    await settleFirstLeg(w, trade.tradeId);
    await traderPaysInr(trade.orderRef, '50000.00');
    await expect(createPayout(trade.tradeId, '104200.00', { inrAccountId: w.collectionAccountId })).rejects.toMatchObject({ code: 'FUNDING_INSUFFICIENT' });
    await payInr(trade.tradeId, '50000.00', w.collectionAccountId);
    expect(await stateOf(trade.tradeId)).toBe('PARTIALLY_SETTLED');
    const deposit = await clientDepositAddressOf(w, trade.tradeId);
    await expect(sendToTraderUsdt(trade.routeObligationId, '1000', deposit)).rejects.toMatchObject({ code: 'COUNTERPARTY_NOT_DELIVERED' });
    // The rest of the client's payout waits for the rest of the trader's money; no timeout reassigns a started order.
    const order = await w.app.selectFrom('trader_order').select('status').where('id', '=', trade.orderId).executeTakeFirstOrThrow();
    expect(order.status).toBe('IN_PROGRESS');
  });

  it('with nothing delivered, the client’s own funds go back to it and the trade unwinds — nothing advanced', async () => {
    const trade = await tradeThroughTrader(w, usdtTrader, { requestId: await clientRequest(w, 'BUY_USDT', '200'), clientRate: '106.000000' });
    await settleFirstLeg(w, trade.tradeId); // ₹21,200 of the client's INR
    await expect(createPayout(trade.tradeId, '200', { treasuryWalletId: w.treasuryWalletId })).rejects.toMatchObject({ code: 'FUNDING_NOT_CONFIRMED' });
    const refund = await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, inrAccountId: w.inrAccountId });
    expect(refund.amount).toBe('21200.00');
    await runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId: refund.legId, rail: 'IMPS' as const, utr: newUtr('RF') });
    await runAs(w.app, refundAndCancel(w.dealer.actor), w.dealer.ref, 'trade.refund_and_cancel', { tradeId: trade.tradeId, reason: 'the trader did not deliver; the client is refunded' });
    expect(await stateOf(trade.tradeId)).toBe('CANCELLED');
    expect(await reconcileOrderNow(w.app, trade.orderId)).toBe('CANCELLED');
    const earmarks = await w.app.selectFrom('funding_allocation').select(['use_kind', 'source_kind', 'status']).where('trade_id', '=', trade.tradeId).execute();
    expect(earmarks).toEqual([{ use_kind: 'REFUND', source_kind: 'CLIENT_FUNDS', status: 'CONSUMED' }]);
    expect(await hotEntries()).toBe('0');
  });
});

describe('one source, many hands', () => {
  it('two payouts racing for the same trader money: exactly one is earmarked', async () => {
    const trade = await tradeThroughTrader(w, inrTrader, { requestId: await clientRequest(w, 'SELL_USDT', '1000'), clientRate: '104.200000' });
    await settleFirstLeg(w, trade.tradeId);
    await traderPaysInr(trade.orderRef);
    const results = await Promise.allSettled([
      createPayout(trade.tradeId, '104200.00', { inrAccountId: w.collectionAccountId }),
      runAs(w.app, createPayoutLeg(w.settlementOp2.actor, {}), w.settlementOp2.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '104200.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.collectionAccountId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const taken = await sql<{ total: string }>`select coalesce(sum(amount_minor), 0)::text as total from funding_allocation where trade_id = ${trade.tradeId} and status in ('ACTIVE', 'CONSUMED')`.execute(w.app);
    expect(BigInt(taken.rows[0]!.total)).toBe(inr('104200.00'));
  });

  it('a refund and a payment to the trader racing for the client’s money: never both', async () => {
    const trade = await tradeThroughTrader(w, usdtTrader, { requestId: await clientRequest(w, 'BUY_USDT', '300'), clientRate: '106.000000' });
    await settleFirstLeg(w, trade.tradeId);
    const { address } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
    await sendUsdt(w, usdtTrader.walletAddress, address, '300');
    await confirmOnChain(w);
    const results = await Promise.allSettled([
      runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: trade.tradeId, inrAccountId: w.inrAccountId }),
      runAs(w.app, recordRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.record', {
        routeObligationId: trade.routeObligationId, flow: 'TO_ROUTE' as const, amount: '31560.00', rail: 'IMPS' as const, utr: utr('OUT'), inrAccountId: w.inrAccountId,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const client = await w.app.selectFrom('funding_source').select('amount_minor').where('trade_id', '=', trade.tradeId).where('kind', '=', 'CLIENT_FUNDS').executeTakeFirstOrThrow();
    const taken = await sql<{ total: string }>`select coalesce(sum(amount_minor), 0)::text as total from funding_allocation where trade_id = ${trade.tradeId} and source_kind = 'CLIENT_FUNDS' and status in ('ACTIVE', 'CONSUMED')`.execute(w.app);
    expect(BigInt(taken.rows[0]!.total) <= client.amount_minor).toBe(true);
  });
});

describe('no direct trader → client path (B4)', () => {
  it('a trader’s route always delivers to the exchange: it cannot be switched to pay a client directly', async () => {
    const { configureRoute } = await import('@inrp2p/routes');
    const route = await w.app.selectFrom('liquidity_route').select(['id', 'version', 'execution_mode']).where('trader_id', '=', inrTraderId).executeTakeFirstOrThrow();
    expect(route.execution_mode).toBe('TO_EXCHANGE');
    // The command path refuses it — the database holds the shape whatever code tries (liquidity_route_trader_shape).
    await expect(runAs(w.app, configureRoute(w.owner.actor), w.owner.ref, 'routes.configure', {
      routeId: route.id, expectedVersion: route.version, executionMode: 'DIRECT_TO_CLIENT' as const, reason: 'let the trader pay the client',
    })).rejects.toMatchObject({ code: 'TRADER_ROUTE_MANAGED' });
    await expect(sql`update liquidity_route set execution_mode = 'DIRECT_TO_CLIENT' where id = ${route.id}`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    expect((await w.app.selectFrom('liquidity_route').select('execution_mode').where('id', '=', route.id).executeTakeFirstOrThrow()).execution_mode).toBe('TO_EXCHANGE');
  });
});

