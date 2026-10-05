import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import { traderNotificationHandler } from '@inrp2p/notifications';
import { Accounts, accountBalance, globalImbalance, routeObligationBalances } from '@inrp2p/ledger';
import { systemHealth } from '@inrp2p/desk';
import {
  confirmPayout, confirmRouteSettlement, createPayoutLeg, recordLegEvidence, recordRouteSettlement, sendPayoutLeg,
} from '@inrp2p/settlement';
import {
  assignRequest, confirmReserveWithdrawal, confirmRewardPayout, deskTrader, freeMarginAt, orderDeliveryAddress, recordReserveWithdrawalSent, recordRewardPayout,
  requestReserveWithdrawal, reserveFigures, runTraderSweep, setAvailability, submitOrderPayment, traderHome,
} from '@inrp2p/traders';
import { clientDepositAddressOf, observe, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import {
  type TradersWorld, clientRequest, configureProgram, confirmOnChain, createTradersWorld, liveTrader, sendUsdt, traderClient, tradeThroughTrader, utr,
} from './traders-world.ts';

/**
 * D4: one trader's whole life against the real database — applied, approved, reserve funded, both sides traded with
 * the counterparty's money only (D-16), rewards paid out of the margin those trades realized and never out of
 * anyone's principal, switched off, reserve withdrawn — and every account it touched back at zero. Then the sweep
 * that moves orders on its own, keeping going when one order fails.
 */
let w: TradersWorld;
beforeAll(async () => {
  w = await createTradersWorld('trader_lifecycle');
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true });
});
afterAll(async () => w.close());

const usdt = (v: string) => Money.parse(v, 'USDT').minor;
/** The worker's outbox dispatch, run where the worker would have run it: right after the event. */
const dispatch = () => dispatchOutbox(w.t.worker, [traderNotificationHandler(w.app), { name: 'rest', handles: () => true, run: async () => {} }], { batchSize: 500 });

async function payClientInr(tradeId: string, amount: string, inrAccountId: string) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId });
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: utr('PO') });
  return confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

async function payClientUsdt(tradeId: string, amount: string, from: { id: string; address: string }) {
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, sourceDepositAddressId: from.id });
  await observe(w, from.address);
  await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
  const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
  const sent = w.chain.add({ from: from.address, to: client.address, amountMinor: usdt(amount) });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: sent.txHash, logIndex: sent.logIndex });
  return confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
}

describe('a trader’s whole life (D4)', () => {
  it('trades both sides with the counterparty’s money, is rewarded out of realized margin, switches off and leaves with its reserve', async () => {
    const t = await traderClient(w, 'Lifecycle Trader');
    const live = await liveTrader(w, t, {
      buy: { capacity: '500000', rate: '104.70', min: '50000', max: '300000' },
      sell: { capacity: '5000', rate: '105.20', min: '100', max: '2500' },
    });
    expect((await reserveFigures(w.app, live.traderId)).locked.toDecimalString()).toBe('500.000000');

    // The trader buys USDT: the client sells 1,000 USDT; the trader pays ₹104,700 into the collection account.
    const a = await tradeThroughTrader(w, t, { requestId: await clientRequest(w, 'SELL_USDT', '1000'), clientRate: '104.200000' });
    await settleFirstLeg(w, a.tradeId);
    await dispatch();
    const claim = await runAs(w.app, submitOrderPayment(t.admin.actor, w.traderDeps), t.admin.ref, 'trader_order.submit_payment', { ref: a.orderRef, rail: 'IMPS' as const, utr: utr() });
    const claimed = await w.app.selectFrom('route_settlement').select('id').where('ref', '=', claim.settlementRef).executeTakeFirstOrThrow();
    await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: claimed.id });
    // The client is paid with the trader's INR, from where it arrived; the trader with the client's USDT, from where it arrived.
    expect((await payClientInr(a.tradeId, '104200.00', w.collectionAccountId)).completed).toBe(true);
    const deposit = await clientDepositAddressOf(w, a.tradeId);
    const toTraderA = w.chain.add({ from: deposit.address, to: t.walletAddress, amountMinor: usdt('1000') });
    const sentA = await runAs(w.app, recordRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.record', {
      routeObligationId: a.routeObligationId, flow: 'TO_ROUTE' as const, amount: '1000', txHash: toTraderA.txHash, logIndex: toTraderA.logIndex, sourceDepositAddressId: deposit.id,
    });
    await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: sentA.routeSettlementId });

    // The trader sells USDT: the client buys 500 USDT for ₹53,000; the trader delivers to the order's own address.
    const b = await tradeThroughTrader(w, t, { requestId: await clientRequest(w, 'BUY_USDT', '500'), clientRate: '106.000000' });
    await settleFirstLeg(w, b.tradeId);
    await dispatch();
    const { address } = await runAs(w.app, orderDeliveryAddress(t.admin.actor, w.traderDeps), t.admin.ref, 'trader_order.delivery_address', { ref: b.orderRef });
    await sendUsdt(w, t.walletAddress, address, '500');
    expect((await confirmOnChain(w)).routeSettled).toBe(1);
    const delivery = await w.app.selectFrom('deposit_address').select(['id', 'address']).where('address', '=', address).executeTakeFirstOrThrow();
    expect((await payClientUsdt(b.tradeId, '500', delivery)).completed).toBe(true);
    const sentB = await runAs(w.app, recordRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.record', {
      routeObligationId: b.routeObligationId, flow: 'TO_ROUTE' as const, amount: '52600.00', rail: 'IMPS' as const, utr: utr('OUT'), inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, confirmRouteSettlement(w.finance.actor, w.settlementDeps), w.finance.ref, 'route_settlement.confirm', { routeSettlementId: sentB.routeSettlementId });

    // The sweep closes both orders and accrues their rewards (10 bps of ₹104,700 and of ₹52,600).
    const sweep = await runTraderSweep(w.app);
    expect(sweep).toMatchObject({ completed: 2, failures: [] });
    for (const obligation of [a.routeObligationId, b.routeObligationId]) expect(await routeObligationBalances(w.app, obligation)).toEqual([]);
    expect((await traderHome(w.app, t.admin.userId)).earnings).toMatchObject({ available: '157.30', completedOrders: 2 });

    // Rewards are paid out of the margin each account realized — ₹500 at the collection account, ₹400 at the payout
    // account — never out of what is still somebody else's.
    expect((await freeMarginAt(w.app, w.collectionAccountId)).toDecimalString()).toBe('500.00');
    expect((await freeMarginAt(w.app, w.inrAccountId)).toDecimalString()).toBe('400.00');
    const reward = (amount: string, inrAccountId: string) =>
      runAs(w.app, recordRewardPayout(w.finance.actor), w.finance.ref, 'trader_reward.record_payout', { traderId: live.traderId, amount, inrAccountId, rail: 'IMPS' as const, utr: utr('RWD') });
    const r1 = await reward('104.70', w.collectionAccountId);
    const r2 = await reward('52.60', w.inrAccountId);
    for (const p of [r1, r2]) await runAs(w.app, confirmRewardPayout(w.finance.actor), w.finance.ref, 'trader_reward.confirm_payout', { payoutId: p.payoutId });
    expect((await freeMarginAt(w.app, w.collectionAccountId)).toDecimalString()).toBe('395.30');
    expect(await accountBalance(w.app, Accounts.traderRewardPayable(live.traderId))).toBe(0n);
    // Whatever code writes the payout, the database holds the line at the free margin (IX096).
    const rawPayout = async (amount: string) => {
      const f = await sql<{ id: string }>`insert into fiat_transfer (rail, utr, amount_minor, payer_type, payer_id, payee_type, payee_id, destination_masked, recorded_by)
        values ('IMPS', ${utr('RAW')}, ${Money.parse(amount, 'INR').minor}, 'EXCHANGE_ACCOUNT', ${w.collectionAccountId}, 'TRADER', ${live.traderId}, 'Kotak ••••0000', 'old-app') returning id`.execute(w.t.owner);
      return sql`insert into trader_reward_payout (trader_id, amount_minor, inr_account_id, fiat_transfer_id, destination_bank_account_id, recorded_by)
        values (${live.traderId}, ${Money.parse(amount, 'INR').minor}, ${w.collectionAccountId}, ${f.rows[0]!.id}, ${t.bankAccountId}, 'old-app')`.execute(w.t.owner);
    };
    await expect(rawPayout('395.31')).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX096');
    // The desk sees the same figure where it chooses the paying account.
    expect((await deskTrader(w.app, live.traderId)).rewardMargins).toEqual(expect.arrayContaining([{ accountId: w.collectionAccountId, freeMargin: '395.30' }]));

    // Switched off with nothing open, the reserve unlocks; the trader takes all of it back.
    await runAs(w.app, setAvailability(t.admin.actor), t.admin.ref, 'trader.set_availability', { available: false });
    const free = await reserveFigures(w.app, live.traderId);
    expect({ locked: free.locked.toDecimalString(), available: free.available.toDecimalString() }).toEqual({ locked: '0.000000', available: '500.000000' });
    const asked = await runAs(w.app, requestReserveWithdrawal(t.admin.actor), t.admin.ref, 'trader_reserve.request_withdrawal', { amount: '500' });
    const back = w.chain.add({ from: w.hotAddress, to: t.walletAddress, amountMinor: usdt('500') });
    await runAs(w.app, recordReserveWithdrawalSent(w.finance.actor, w.traderDeps), w.finance.ref, 'trader_reserve.record_withdrawal_sent', { withdrawalId: asked.withdrawalId, txHash: back.txHash });
    await runAs(w.app, confirmReserveWithdrawal(w.finance.actor, w.traderDeps), w.finance.ref, 'trader_reserve.confirm_withdrawal', { withdrawalId: asked.withdrawalId });
    expect(await accountBalance(w.app, Accounts.traderReserve(live.traderId))).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);

    // The trader heard about every step that was its business.
    await dispatch();
    const kinds = (await w.app.selectFrom('client_notification').select('kind').where('client_id', '=', t.clientId).execute()).map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(['TRADER_APPROVED', 'TRADER_ORDER_NEW', 'TRADER_ORDER_ACCEPTED', 'TRADER_ACTION_REQUIRED', 'TRADER_PAYMENT_CONFIRMED', 'TRADER_ORDER_COMPLETED']));
  });
});

describe('the trader sweep (D4)', () => {
  it('keeps going when one order fails, reports it, retries it next run, and the health check shows it meanwhile', async () => {
    const t = await traderClient(w, 'Sweep Subject');
    await liveTrader(w, t, { buy: { capacity: '1000000', rate: '140.00', min: '1', max: '1000000' } });
    const first = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: await clientRequest(w, 'SELL_USDT', '10') });
    const second = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: await clientRequest(w, 'SELL_USDT', '11') });
    const expiry = await w.app.selectFrom('trader_order').select(sql<Date>`max(offer_expires_at)`.as('at')).where('id', 'in', [first.orderId, second.orderId]).executeTakeFirstOrThrow();

    // Something in one order's step fails — here a fault planted in the database for that one row.
    await sql.raw(`
      create function test_fail_one_order() returns trigger language plpgsql as $$
      begin
        if new.id = '${first.orderId}' and new.status = 'EXPIRED' then raise exception 'planted fault' using errcode = 'P0001'; end if;
        return new;
      end $$;
      create trigger test_fail_one_order before update on trader_order for each row execute function test_fail_one_order();`).execute(w.t.owner);
    const clock = await w.t.pinnedClock();
    try {
      await clock.set(new Date(expiry.at.getTime() + 11 * 60_000));
      const report = await runTraderSweep(clock.db);
      expect(report.offersExpired).toBeGreaterThanOrEqual(1);
      expect(report.failures).toEqual([expect.objectContaining({ step: 'trader_order.expire_offer', orderId: first.orderId, code: 'P0001' })]);
      const statuses = await w.app.selectFrom('trader_order').select(['id', 'status']).where('id', 'in', [first.orderId, second.orderId]).execute();
      expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({ [first.orderId]: 'OFFERED', [second.orderId]: 'EXPIRED' });
      const health = await systemHealth(clock.db);
      expect(health.checks.find((c) => c.id === 'trader_orders_overdue')).toMatchObject({ value: 1, state: 'warn', runbook: 'trader-sweep-behind' });

      await sql.raw('drop trigger test_fail_one_order on trader_order; drop function test_fail_one_order();').execute(w.t.owner);
      const retried = await runTraderSweep(clock.db);
      expect(retried.failures).toEqual([]);
      expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', first.orderId).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
      expect((await systemHealth(clock.db)).checks.find((c) => c.id === 'trader_orders_overdue')?.value).toBe(0);
    } finally {
      await clock.set(null);
      await sql.raw('drop trigger if exists test_fail_one_order on trader_order; drop function if exists test_fail_one_order();').execute(w.t.owner);
    }
  });
});
