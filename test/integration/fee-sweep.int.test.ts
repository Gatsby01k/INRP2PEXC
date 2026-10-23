import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, encodeTronAddress, parseTrx } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import { networkAvailable, setNetworkFeePolicy } from '@inrp2p/network';
import { fundBudget } from '@inrp2p/network/testing';
import { configureTraderProgram } from '@inrp2p/trader-core';
import { confirmClientReceipt, sweepAddressNow, sweepableTradesAt } from '@inrp2p/settlement';
import { submitOrderPayment } from '@inrp2p/traders';
import { registerTreasuryWallet } from '@inrp2p/treasury';
import { revenueReport } from '@inrp2p/desk';
import { balanceOf, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { confirmOnChain, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsSettle, railsTrade, railsTrader, railsTurn } from './rails-world.ts';

/**
 * INRP2P's earnings off the deal addresses (block 10, TD-31, TD-36; ADR 0020 §2.16): a completed P2P deal leaves its USDT
 * margin at its deal address; once no trade uses the address and it holds enough to be worth a transfer, the signer
 * sweeps it to the revenue wallet with the platform's own TRX, and sends the TRX its transfers did not burn back to the
 * budget wallet, credited to whoever paid for it.
 */
let w: RailsWorld;
let trader: Awaited<ReturnType<typeof railsTrader>>;
let revenueAddress: string;

const sends = (purpose: string) => w.app.selectFrom('chain_send').selectAll().where('purpose', '=', purpose as never).orderBy('created_at').execute();
const policy = (input: Record<string, unknown>) =>
  runAs(w.app, setNetworkFeePolicy(w.owner.actor), w.owner.ref, 'settings.network_fees', { ...input, reason: 'block 10 test: sweep thresholds' });

/** A client's SELL on the rails, end to end: its USDT in, the trader's rupees out, the client's confirmation, the payout. */
async function completedSell(amount: string) {
  const trade = await railsTrade(w, trader, { direction: 'SELL_USDT', amount, clientRate: '103.500000', plannedClientRate: '103.500000' });
  await settleFirstLeg(w, trade.tradeId);
  const paid = await runAs(w.app, submitOrderPayment(trader.admin.actor, w.traderDeps), trader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() });
  const profile = await w.app.selectFrom('trader_profile as t').innerJoin('bank_account as b', 'b.id', 't.bank_account_id').select('b.holder_name').where('t.id', '=', trader.traderId).executeTakeFirstOrThrow();
  const tradeRef = (await w.app.selectFrom('trade').select('ref').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).ref;
  await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef, legRef: paid.settlementRef, senderName: profile.holder_name });
  await railsSettle(w, trade.tradeId);
  const econ = await w.app.selectFrom('trade_economics').selectAll().where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
  const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select(['d.address', 'd.status']).where('a.trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
  return { ...trade, econ, address: deposit.address };
}

beforeAll(async () => {
  // Reclaims wait for an idle address in production; here, the moment it is free.
  w = await createRailsWorld('fee-sweep', { policy: { reclaimIdleMinutes: 0 } });
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, executionMode: 'P2P' as const, reason: 'no INR account: P2P escrow' });
  trader = await railsTrader(w, 'INR Provider', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '1000');
  revenueAddress = encodeTronAddress(randomBytes(20));
});
afterAll(async () => w.close());

describe('INRP2P’s earnings, swept off the deal addresses', () => {
  it('waits for a revenue wallet, for enough earnings and for the platform’s TRX — then sweeps them in one transfer', async () => {
    const deal = await completedSell('1000');
    const margin = deal.econ.gross_margin_base_minor!;
    expect(margin).toBeGreaterThan(Money.parse('10', 'USDT').minor);
    expect(w.chain.balanceOf(deal.address)).toBe(margin);
    expect(await sweepableTradesAt(w.app, deal.address)).toEqual([expect.objectContaining({ tradeId: deal.tradeId, sweepableMinor: margin })]);

    // No revenue wallet yet: nothing is planned, and earnings stay where they are.
    expect((await railsTurn(w)).autopay.sweepsPlanned).toBe(0);
    await runAs(w.app, registerTreasuryWallet(w.owner.actor), w.owner.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: revenueAddress, label: 'INRP2P revenue', role: 'REVENUE' as const });
    await expect(runAs(w.app, registerTreasuryWallet(w.owner.actor), w.owner.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: 'Second revenue', role: 'REVENUE' as const }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // Below the minimum (20 USDT by default): not worth a transfer yet.
    expect((await railsTurn(w)).autopay.sweepsPlanned).toBe(0);
    await policy({ feeSweepMin: '5' });
    // Worth it now, but the platform has no TRX to spare: it waits, with no case for anyone.
    const spare = await networkAvailable(w.app, null);
    await w.app.insertInto('network_budget_entry').values({
      trader_id: null, kind: 'ADJUSTMENT', amount_sun: -spare, posting_key: 'test_drain:platform', note: 'test: the platform has no TRX to spare', created_by: 'test',
    }).execute();
    const waiting = await railsTurn(w);
    expect(waiting.autopay).toMatchObject({ sweepsPlanned: 0, sweepsWaiting: 1 });
    await expect(runAs(w.app, sweepAddressNow(w.owner.actor, w.settlementDeps), w.owner.ref, 'fee_sweep.plan', { address: deal.address })).rejects.toMatchObject({ code: 'NETWORK_BUDGET_INSUFFICIENT' });

    // The platform's TRX arrives at the budget wallet.
    const platformFrom = encodeTronAddress(randomBytes(20));
    w.net.externalTrxTransfer({ from: platformFrom, to: w.budgetAddress, amountSun: parseTrx('200') });
    await fundBudget(w.app, { traderId: null, amountSun: parseTrx('200'), from: platformFrom });
    expect((await railsTurn(w)).autopay.sweepsPlanned).toBe(1);
    await railsSettle(w, deal.tradeId);

    const [sweep] = await sends('FEE_SWEEP');
    expect(sweep).toMatchObject({ from_address: deal.address, to_address: revenueAddress, amount_minor: margin, status: 'CONFIRMED', bearer: 'PLATFORM', funder_trader_id: null, trade_id: deal.tradeId });
    expect(w.chain.balanceOf(revenueAddress)).toBe(margin);
    expect(w.chain.balanceOf(deal.address)).toBe(0n);
    const wallet = await w.app.selectFrom('treasury_wallet').select('id').where('role', '=', 'REVENUE').executeTakeFirstOrThrow();
    expect(await balanceOf(w.app, `ASSET:TREASURY_USDT:${wallet.id}`, 'USDT')).toBe(margin);
    const earmarks = await w.app.selectFrom('funding_allocation').select(['use_kind', 'status', 'amount_minor', 'trade_id']).where('use_chain_send_id', '=', sweep!.id).execute();
    expect(earmarks).toEqual([{ use_kind: 'FEE_SWEEP', status: 'CONSUMED', amount_minor: margin, trade_id: deal.tradeId }]);
    expect(await sweepableTradesAt(w.app, deal.address)).toEqual([]);
    // Its top-up is the platform's spend, not the trader's.
    const spent = await w.app.selectFrom('network_budget_entry as b').innerJoin('chain_send_attempt as a', 'a.id', 'b.chain_send_attempt_id').innerJoin('chain_send as t', 't.id', 'a.send_id')
      .select(['b.trader_id', 'b.amount_sun']).where('t.parent_send_id', '=', sweep!.id).where('b.kind', '=', 'SPENT').execute();
    expect(spent.length).toBeGreaterThan(0);
    expect(spent.every((s) => s.trader_id === null)).toBe(true);

    // The scanner sees the transfer reach the revenue wallet and knows it for the signer's own.
    await confirmOnChain(w);
    expect(await w.app.selectFrom('exception_case').select('type').where('type', '=', 'UNALLOCATED_DEPOSIT').execute()).toEqual([]);
    expect((await railsTurn(w)).autopay.sweepsPlanned).toBe(0);
    expect(await globalImbalance(w.app)).toEqual([]);

    const today = (await w.app.selectFrom('trade').select('completed_at').where('id', '=', deal.tradeId).executeTakeFirstOrThrow()).completed_at!.toISOString().slice(0, 10);
    const report = await revenueReport(w.app, { from: '2000-01-01', to: today > '2100-01-01' ? today : '2100-01-01' });
    expect(report.where).toMatchObject({ sweptAllTime: Money.ofMinor(margin, 'USDT').toDecimalString(), inRevenueWallet: Money.ofMinor(margin, 'USDT').toDecimalString(), atAddresses: '0.000000' });
    expect(report.earned.margins).toBe(Money.ofMinor(margin, 'USDT').toDecimalString());
    expect(report.sweeps[0]).toMatchObject({ ref: sweep!.ref, status: 'CONFIRMED' });
  });

  it('sends the TRX the transfers did not burn back to the budget wallet, each funder credited its own', async () => {
    const [sweep] = await sends('FEE_SWEEP');
    const address = sweep!.from_address;
    // Once the deal was done the address was free: what the payment to the trader did not burn went back at once; what
    // the sweep did not burn followed it.
    const reclaims = (await sends('TRX_RECLAIM')).filter((r) => r.from_address === address);
    expect(reclaims.map((r) => [r.status, r.to_address, r.bearer, r.funder_trader_id, r.trade_id])).toEqual([
      ['CONFIRMED', w.budgetAddress, 'PLATFORM', null, null],
      ['CONFIRMED', w.budgetAddress, 'PLATFORM', null, null],
    ]);
    const creditsOf = async (sendId: string) =>
      w.app.selectFrom('network_budget_entry as b').innerJoin('chain_send_attempt as a', 'a.id', 'b.chain_send_attempt_id')
        .select(['b.trader_id', 'b.amount_sun']).where('a.send_id', '=', sendId).where('b.kind', '=', 'RECLAIM').execute();
    const left = async (parentId: string) => {
      const topped = (await w.app.selectFrom('chain_send').select('amount_minor').where('parent_send_id', '=', parentId).where('status', '=', 'CONFIRMED').execute()).reduce((t, x) => t + x.amount_minor, 0n);
      const burned = (await w.app.selectFrom('chain_send_attempt').select('fee_sun').where('send_id', '=', parentId).where('status', 'in', ['CONFIRMED', 'FAILED']).execute()).reduce((t, a) => t + (a.fee_sun ?? 0n), 0n);
      return topped - burned;
    };
    // The first: the trader's TRX, left over from its own payment — back into its deposit (a P2P trader bears its deals).
    const payment = (await sends('ROUTE_PAYMENT')).find((x) => x.from_address === address)!;
    const first = await creditsOf(reclaims[0]!.id);
    expect(first.reduce((t, c) => t + c.amount_sun, 0n)).toBe(reclaims[0]!.amount_minor);
    expect(first.find((c) => c.trader_id === trader.traderId)!.amount_sun).toBe(await left(payment.id) < reclaims[0]!.amount_minor ? await left(payment.id) : reclaims[0]!.amount_minor);
    // The second: the platform's, left over from the sweep.
    const second = await creditsOf(reclaims[1]!.id);
    expect(second).toEqual([{ trader_id: null, amount_sun: reclaims[1]!.amount_minor }]);
    // What is left is below what is worth a transfer.
    await policy({ trxReclaimMin: '0.1' });
    expect(w.net.accountState(address).balanceSun).toBeLessThan(parseTrx('0.1'));
    expect((await railsTurn(w)).autopay.reclaimsPlanned).toBe(0);
  });

  it('never sweeps a deal still settling, nor more than a deal earned', async () => {
    const trade = await railsTrade(w, trader, { direction: 'SELL_USDT', amount: '500', clientRate: '103.500000', plannedClientRate: '103.500000' });
    await settleFirstLeg(w, trade.tradeId);
    const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    // The client's USDT is in, the trade is open: none of it is anyone's earnings.
    expect(await sweepableTradesAt(w.app, deposit.address)).toEqual([]);
    await expect(runAs(w.app, sweepAddressNow(w.owner.actor, w.settlementDeps), w.owner.ref, 'fee_sweep.plan', { address: deposit.address })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});
