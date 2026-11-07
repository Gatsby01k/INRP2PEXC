import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, formatTrx, parseTrx } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { globalImbalance } from '@inrp2p/ledger';
import { currentNetworkCosts, latestTrxRate, networkAvailable, reservePerSendSun } from '@inrp2p/network';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { acceptOrder, assignRequest } from '@inrp2p/traders';
import { approveRefundSend, claimIncomingFiat, confirmClientReceipt, createRefundLeg, decideRestoreFenceLift, raiseChainSendCap, raiseRestoreFence, refundAndCancel, requestRestoreFenceLift, setNewBusiness } from '@inrp2p/settlement';
import { confirmOrderPaymentReceived, orderDeliveryAddress, submitOrderPayment } from '@inrp2p/traders';
import { runFeeRefresh, runSender, runTrxRateRefresh } from '@inrp2p/onchain';
import { decideNetworkWithdrawal, requestNetworkWithdrawal } from '@inrp2p/network';
import { payoutsHeld } from '@inrp2p/trades';
import { CLIENT_SENDER, observe, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { confirmOnChain, sendUsdt, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, depositTrx, railsSettle, railsTrade, railsTrader, railsTurn } from './rails-world.ts';

/**
 * USDT TRC20 on the exchange's own rails (ADR 0017), with real signing: a deal address per trade derived from the HD
 * account, the TRX budget the trader prefunded, a top-up of the deal address, one signed USDT transfer straight to whoever
 * is paid, and the chain's answer settling it. Deals end to end are in the P2P suite; this one is about what can go wrong.
 */
let w: RailsWorld;
let inrTrader: Awaited<ReturnType<typeof railsTrader>>;
let usdtTrader: Awaited<ReturnType<typeof railsTrader>>;

const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const sends = (tradeId: string) => w.app.selectFrom('chain_send').selectAll().where('trade_id', '=', tradeId).orderBy('created_at').execute();
const attemptsOf = (sendId: string) => w.app.selectFrom('chain_send_attempt').selectAll().where('send_id', '=', sendId).orderBy('seq').execute();
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow()).lifecycle_state;
const depositOf = (tradeId: string) => w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
  .select(['d.id', 'd.address', 'd.custody_reference', 'd.source']).where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow();

/** A client buying USDT from the USDT trader: the trader's USDT in the escrow, the client's rupees seen by the trader. */
async function fundedBuy(amount = '1000', clientRate = '106.500000') {
  const trade = await railsTrade(w, usdtTrader, { direction: 'BUY_USDT', amount, clientRate, plannedClientRate: clientRate });
  const { address, amount: owed } = await runAs(w.app, orderDeliveryAddress(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.delivery_address', { ref: trade.orderRef });
  await sendUsdt(w, usdtTrader.walletAddress, address, owed);
  await confirmOnChain(w);
  await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: trade.tradeRef, rail: 'IMPS' as const, utr: utr(), fromBankAccountId: w.bankAccountId });
  await runAs(w.app, confirmOrderPaymentReceived(usdtTrader.admin.actor, w.traderDeps), usdtTrader.admin.ref, 'trader_order.confirm_received', { ref: trade.orderRef, senderName: CLIENT_SENDER });
  return trade;
}

/** A client selling to the INR trader: its USDT in the escrow, the trader's rupees confirmed by the client. */
async function paidSell(amount = '1000', clientRate = '103.000000') {
  const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount, clientRate, plannedClientRate: clientRate });
  await settleFirstLeg(w, trade.tradeId);
  const paid = await runAs(w.app, submitOrderPayment(inrTrader.admin.actor), inrTrader.admin.ref, 'trader_order.submit_payment', { ref: trade.orderRef, rail: 'IMPS' as const, utr: utr() });
  const holder = (await w.app.selectFrom('bank_account').select('holder_name').where('id', '=', inrTrader.bankAccountId).executeTakeFirstOrThrow()).holder_name;
  await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: trade.tradeRef, legRef: paid.settlementRef, senderName: holder });
  return trade;
}

beforeAll(async () => {
  w = await createRailsWorld('rails');
  inrTrader = await railsTrader(w, 'INR Provider', { buy: { capacity: '50000000', rate: '104.70', min: '100', max: '20000000' } }, '2000');
  usdtTrader = await railsTrader(w, 'USDT Provider', { sell: { capacity: '500000', rate: '105.20', min: '10', max: '200000' } }, '2000');
});
afterAll(async () => w.close());

describe('cancellation and refunds', () => {
  it('returns the client’s USDT when the trader never pays — its network cost borne by the trader, never the client', async () => {
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '300', clientRate: '102.000000', plannedClientRate: '102.000000' });
    await settleFirstLeg(w, trade.tradeId);
    const deposit = await depositOf(trade.tradeId);
    const source = await w.app.selectFrom('crypto_wallet').select('id').where('address', '=', w.clientSourceAddress).executeTakeFirstOrThrow();
    await observe(w, deposit.address);
    const refund = await runAs(w.app, createRefundLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'refund_leg.create', { tradeId: trade.tradeId, sourceDepositAddressId: deposit.id });
    // The person who created a refund never sends it.
    await expect(runAs(w.app, approveRefundSend(w.settlementOp.actor), w.settlementOp.ref, 'refund_leg.approve_send', { legId: refund.legId, bearer: 'TRADER' as const, toWalletId: source.id, reason: 'trader did not pay' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, approveRefundSend(w.finance.actor), w.finance.ref, 'refund_leg.approve_send', { legId: refund.legId, bearer: 'TRADER' as const, toWalletId: source.id, reason: 'the trader did not pay its INR' });
    await railsSettle(w, trade.tradeId);
    expect(w.chain.balanceOf(deposit.address)).toBe(0n);
    const legs = await w.app.selectFrom('settlement_leg').select(['side', 'status']).where('trade_id', '=', trade.tradeId).where('side', '=', 'REFUND_TO_CLIENT').execute();
    expect(legs).toEqual([{ side: 'REFUND_TO_CLIENT', status: 'COMPLETED' }]);
    const routePayments = (await sends(trade.tradeId)).filter((s) => s.purpose === 'ROUTE_PAYMENT');
    expect(routePayments).toEqual([]);
    const refundSend = (await sends(trade.tradeId)).find((s) => s.purpose === 'REFUND')!;
    expect(refundSend.bearer).toBe('TRADER');
    expect(refundSend.approved_by).toBe(w.finance.actor.userId);
    // The trade unwinds; what the return cost is the trader's (it never paid), so nothing is paid back to it.
    await runAs(w.app, refundAndCancel(w.owner.actor), w.owner.ref, 'trade.refund_and_cancel', { tradeId: trade.tradeId, reason: 'the trader did not pay' });
    await railsTurn(w, { mine: false });
    const hold = await w.app.selectFrom('network_budget_hold').select(['status', 'spent_sun']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.status).toBe('CLOSED');
    expect(hold.spent_sun).toBeGreaterThan(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('holds what a refund costs from acceptance on, so a trader cannot spend it on other orders first', async () => {
    const before = await networkAvailable(w.app, inrTrader.traderId);
    const trade = await railsTrade(w, inrTrader, { direction: 'SELL_USDT', amount: '200', clientRate: '101.000000', plannedClientRate: '101.000000' });
    const hold = await w.app.selectFrom('network_budget_hold').select(['amount_sun', 'per_send_sun', 'sends']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(hold.amount_sun).toBe(hold.per_send_sun! * 2n);
    expect(before - (await networkAvailable(w.app, inrTrader.traderId))).toBe(hold.amount_sun);
  });
});

describe('without real cover, nothing is sent', () => {
  it('refuses to accept a trade its trader’s network deposit cannot cover', async () => {
    const poor = await railsTrader(w, 'Thin Deposit', { buy: { capacity: '50000000', rate: '104.90', min: '100', max: '20000000' } }, '20');
    // Routing passes it over: it could not pay for one more order's transfers.
    const request = await import('@inrp2p/quotes').then((q) => runAs(w.app, q.createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', bankAccountId: w.bankAccountId,
    }));
    const { assignRequest } = await import('@inrp2p/traders');
    const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '103.000000' });
    expect(assigned.traderRef).not.toBe((await w.app.selectFrom('trader_profile').select('ref').where('id', '=', poor.traderId).executeTakeFirstOrThrow()).ref);
    expect(formatTrx(await networkAvailable(w.app, poor.traderId))).toBe('20.000000');
  });

  it('blocks a top-up the budget wallet does not hold on chain, and goes on once it does', async () => {
    const trade = await fundedBuy();
    // The records say the trader's TRX is there; the chain says the budget wallet is nearly empty.
    const onChain = w.net.trxOf(w.budgetAddress);
    w.net.externalTrxTransfer({ from: w.budgetAddress, to: w.clientSourceAddress, amountSun: 0n + onChain - parseTrx('1') }); // drained by someone outside
    await railsTurn(w); // plans the payout and its top-up
    await railsTurn(w); // the top-up cannot be signed
    const topup = (await sends(trade.tradeId)).find((s) => s.purpose === 'TOPUP')!;
    expect(topup.status).toBe('BLOCKED');
    expect(topup.blocked_reason).toMatch(/holds 1\.000000 TRX on chain/);
    const caseRow = await w.app.selectFrom('exception_case').select(['type', 'status']).where('subject_id', '=', topup.id).executeTakeFirstOrThrow();
    expect(caseRow).toEqual({ type: 'NETWORK_BUDGET_SHORT', status: 'OPEN' });
    // Funded again on chain: the desk sends it on (or the signer retries it by itself a little later), and the client is paid.
    w.net.externalTrxTransfer({ from: w.clientSourceAddress, to: w.budgetAddress, amountSun: onChain });
    const { unblockChainSend } = await import('@inrp2p/settlement');
    await runAs(w.app, unblockChainSend(w.finance.actor), w.finance.ref, 'chain_send.unblock', { sendId: topup.id, reason: 'the budget wallet was topped up on chain' });
    await railsSettle(w, trade.tradeId, 10);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });
});

describe('exactly once, whatever happens', () => {
  it('a broadcast that times out after reaching the node is never signed again: the chain’s answer settles it', async () => {
    const trade = await fundedBuy();
    for (const g of w.gateways) g.timeoutAfterBroadcast = true;
    try {
      await railsSettle(w, trade.tradeId, 6);
    } finally {
      for (const g of w.gateways) g.timeoutAfterBroadcast = false;
    }
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    expect(payout.status).toBe('CONFIRMED');
    expect(await attemptsOf(payout.id)).toHaveLength(1);
  });

  it('a crash between signing and broadcasting broadcasts the same bytes on restart, and a lost transaction is re-signed only once it provably expired', async () => {
    const trade = await fundedBuy();
    // Up to the top-up being final: the payout is next.
    await railsTurn(w);
    await railsTurn(w);
    // The worker signs and dies before any broadcast reaches a node.
    for (const g of w.gateways) g.loseBroadcast = true;
    await runSender(w.app, w.rails);
    for (const g of w.gateways) g.loseBroadcast = false;
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    const [signed] = await attemptsOf(payout.id);
    expect(signed!.status).toBe('SIGNED');
    // A node now takes the same bytes — and then drops them: they are never included.
    w.net.swallowed.add(signed!.txid);
    await railsTurn(w);
    expect(w.net.received.filter((t) => t === signed!.txid).length).toBeGreaterThanOrEqual(1);
    // While it could still land, nothing else is signed — however often the jobs run.
    for (let i = 0; i < 3; i++) await railsTurn(w);
    expect(await attemptsOf(payout.id)).toHaveLength(1);
    // Past its expiration on every provider's solidified head it is proved dead, and only then signed again.
    w.net.advance(200_000);
    await railsSettle(w, trade.tradeId, 6);
    const attempts = await attemptsOf(payout.id);
    expect(attempts.map((a) => a.status)).toEqual(['EXPIRED', 'CONFIRMED']);
    expect(attempts[0]!.txid).toBe(signed!.txid);
    const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
    const leg = await w.app.selectFrom('settlement_leg').select('amount_minor').where('trade_id', '=', trade.tradeId).where('side', '=', 'EXCHANGE_TO_CLIENT').executeTakeFirstOrThrow();
    expect(leg.amount_minor).toBe(usdt('1000'));
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    void client;
  });

  it('a provider that contradicts the others leaves the send blocked: never settled, never re-signed, never cancellable', async () => {
    const trade = await fundedBuy();
    await railsTurn(w);
    await railsTurn(w);
    w.gateways[1]!.liar = true;
    try {
      await railsTurn(w);
      await railsTurn(w);
      const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
      expect(payout.status).toBe('SENDING');
      expect(await attemptsOf(payout.id)).toHaveLength(1);
      const { cancelChainSend } = await import('@inrp2p/settlement');
      await expect(runAs(w.app, cancelChainSend(w.finance.actor), w.finance.ref, 'chain_send.cancel', { sendId: payout.id, reason: 'stuck' })).rejects.toMatchObject({ code: 'CHAIN_SEND_IN_FLIGHT' });
    } finally {
      w.gateways[1]!.liar = false;
    }
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });

  it('a transaction that fails on chain moves nothing; the send is fuelled and signed again', async () => {
    const trade = await fundedBuy();
    await railsTurn(w);
    await railsTurn(w);
    await railsTurn(w, { mine: false }); // the payout signed, not yet included
    const before = [w.net.params.energyToHolder, w.net.params.energyToNewHolder] as const;
    // The contract got dearer between the estimate and the block.
    w.net.params.energyToHolder = 400_000n;
    w.net.params.energyToNewHolder = 400_000n;
    w.net.mine();
    await railsTurn(w, { mine: false });
    [w.net.params.energyToHolder, w.net.params.energyToNewHolder] = before;
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    const first = await attemptsOf(payout.id);
    expect(first[0]!.status).toBe('FAILED');
    expect(first[0]!.result).toBe('OUT_OF_ENERGY');
    await railsSettle(w, trade.tradeId, 8);
    const attempts = await attemptsOf(payout.id);
    expect(attempts.map((a) => a.status)).toEqual(['FAILED', 'CONFIRMED']);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });

  it('the database refuses a second transaction for a send while one may still land', async () => {
    const live = await w.app.selectFrom('chain_send_attempt').select(['send_id']).where('status', '=', 'CONFIRMED').executeTakeFirstOrThrow();
    await expect(sql`insert into chain_send_attempt (send_id, seq, txid, raw_data_hex, signature_hex, ref_block_num, expiration)
                     values (${live.send_id}, 99, ${'ab'.repeat(32)}, ${'0a'.repeat(20)}, ${'0'.repeat(130)}, 1, now())`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX104');
  });
});

describe('concurrent operations', () => {
  it('two workers signing at once make one transaction', async () => {
    const trade = await fundedBuy();
    await railsTurn(w);
    await railsTurn(w);
    await Promise.all([runSender(w.app, w.rails), runSender(w.app, w.rails), runSender(w.app, w.rails)]);
    const payout = (await sends(trade.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    expect(await attemptsOf(payout.id)).toHaveLength(1);
    await railsSettle(w, trade.tradeId);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });

  it('two acceptances racing for a trader’s last TRX: one is accepted, the other refused', async () => {
    const lean = await railsTrader(w, 'Lean Deposit', { sell: { capacity: '500000', rate: '100.10', min: '10', max: '200000' } }, '0');
    const costs = await currentNetworkCosts(w.app);
    // A deal holds its transfer and a return of the escrow (migration 0040).
    const need = reservePerSendSun(costs.snapshot, costs.policy) * BigInt(1 + costs.policy.refundSendsSell);
    // One and a half orders' worth: enough for routing to offer it both, not for both trades to hold their transfer.
    await depositTrx(w, lean, formatTrx((need * 3n) / 2n));
    const quoteFor = async () => {
      const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'BUY_USDT' as const, fixedSide: 'BASE' as const, amount: '1000', walletId: w.walletId });
      const assigned = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '102.000000' });
      expect(assigned.traderRef).toBe((await w.app.selectFrom('trader_profile').select('ref').where('id', '=', lean.traderId).executeTakeFirstOrThrow()).ref);
      await runAs(w.app, acceptOrder(lean.admin.actor), lean.admin.ref, 'trader_order.accept', { ref: assigned.ref });
      const order = await w.app.selectFrom('trader_order').select('route_id').where('ref', '=', assigned.ref).executeTakeFirstOrThrow();
      const quote = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: order.route_id, clientRate: '102.000000', validitySeconds: 300 });
      await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: quote.quoteId });
      return quote.quoteId;
    };
    const [qa, qb] = [await quoteFor(), await quoteFor()];
    const results = await Promise.allSettled([qa, qb].map((quoteId) => runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.code ?? pgErrorCode(refused.reason)).toMatch(/NETWORK_BUDGET_INSUFFICIENT|IX108/);
    expect(await networkAvailable(w.app, lean.traderId)).toBeGreaterThanOrEqual(0n);
  });

});

/** What a USDT send has drawn on its trade's hold so far, and its cap. */
const drawn = async (sendId: string) => {
  const r = await sql<{ used: string; cap: string }>`
    select inrp2p_send_network_used(${sendId}::uuid)::text as used, network_cap_sun::text as cap from chain_send where id = ${sendId}`.execute(w.app);
  return { used: BigInt(r.rows[0]!.used), cap: BigInt(r.rows[0]!.cap) };
};
const holdOf = async (tradeId: string) => (await w.app.selectFrom('network_budget_hold').select('amount_sun').where('trade_id', '=', tradeId).executeTakeFirstOrThrow()).amount_sun!;
const payoutOf = async (tradeId: string) => (await sends(tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT');
const raiseCap = (sendId: string, cap: string, who = w.finance) =>
  runAs(w.app, raiseChainSendCap(who.actor), who.ref, 'chain_send.raise_network_cap', { sendId, cap, reason: 'checked the chain: energy is dearer now, the platform carries it' });

describe('after the database changed underneath, nothing leaves — TRX no more than USDT (FI-54)', () => {
  it('signs, plans and broadcasts nothing while the fence is up, and broadcasts the same bytes, once, after it is lifted', async () => {
    const trade = await fundedBuy();
    await railsTurn(w); // the payout is planned, and its top-up
    // The top-up is signed and the worker dies before a node takes it.
    for (const g of w.gateways) g.loseBroadcast = true;
    await runSender(w.app, w.rails);
    for (const g of w.gateways) g.loseBroadcast = false;
    const topup = (await sends(trade.tradeId)).find((s) => s.purpose === 'TOPUP')!;
    const [signed] = await attemptsOf(topup.id);
    expect(signed!.status).toBe('SIGNED');
    const seen = () => w.net.received.filter((t) => t === signed!.txid).length;
    const seenBefore = seen();

    await runAs(w.app, raiseRestoreFence(w.financeOp.actor), w.financeOp.ref, 'operations.raise_restore_fence', { reason: 'restored from the provider console in the test' });
    expect((await payoutsHeld(w.app)).held).toBe(true);
    // The worker restarts and runs its cycle again and again: the signed TRX transfer is not broadcast, nothing is signed.
    for (let i = 0; i < 3; i++) await railsTurn(w);
    expect(seen()).toBe(seenBefore);
    expect(await attemptsOf(topup.id)).toHaveLength(1);
    expect(await attemptsOf((await payoutOf(trade.tradeId))!.id)).toHaveLength(0);
    // The database says the same, whoever asks (IX100): no transaction signed, no TRX send planned.
    await expect(sql`insert into chain_send_attempt (send_id, seq, txid, raw_data_hex, signature_hex, ref_block_num, expiration)
                     values (${topup.id}, 2, ${'cd'.repeat(32)}, ${'0a'.repeat(20)}, ${'0'.repeat(130)}, 1, now())`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX100');
    const fee = await w.app.selectFrom('custody_hd_account').select('fee_wallet_path').executeTakeFirstOrThrow();
    await expect(sql`insert into chain_send (asset, purpose, trade_id, parent_send_id, from_address, from_path, to_address, amount_minor, funder_trader_id, bearer, status, needs_approval, requested_by)
                     values ('TRX', 'TOPUP', ${trade.tradeId}, ${topup.parent_send_id}, ${topup.from_address}, ${fee.fee_wallet_path}, ${topup.to_address}, 1000000,
                             ${topup.funder_trader_id}, 'CLIENT', 'PLANNED', false, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX100');
    // A trader's TRX withdrawal may be asked for, but not approved to leave.
    const asked = await runAs(w.app, requestNetworkWithdrawal(usdtTrader.admin.actor), usdtTrader.admin.ref, 'network_withdrawal.request', { amount: '5' });
    await expect(runAs(w.app, decideNetworkWithdrawal(w.finance.actor), w.finance.ref, 'network_withdrawal.decide', { withdrawalId: asked.withdrawalId, approve: true }))
      .rejects.toMatchObject({ code: 'PAYOUTS_HELD' });
    await runAs(w.app, decideNetworkWithdrawal(w.finance.actor), w.finance.ref, 'network_withdrawal.decide', { withdrawalId: asked.withdrawalId, approve: false, reason: 'after the reconciliation' });

    // One person records the reconciliation, another lifts the fence; new business is its own decision.
    const lift = await runAs(w.app, requestRestoreFenceLift(w.financeOp.actor), w.financeOp.ref, 'operations.request_restore_fence_lift', {
      reconciliation: 'Looked up every signed transaction on the chain: the budget wallet top-up is unseen and unexpired.',
    });
    await runAs(w.app, decideRestoreFenceLift(w.financeOp2.actor), w.financeOp2.ref, 'operations.approve_restore_fence_lift', { liftId: lift.lift!.id, approve: true, note: 'checked' });
    await runAs(w.app, setNewBusiness(w.financeOp.actor), w.financeOp.ref, 'settings.resume_new_business', { paused: false, reason: 'reconciled after the rails restore drill' });

    await railsSettle(w, trade.tradeId, 10);
    expect(seen()).toBeGreaterThan(seenBefore);
    const attempts = await attemptsOf(topup.id);
    expect(attempts.map((a) => [a.txid, a.status])).toEqual([[signed!.txid, 'CONFIRMED']]);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
  });
});

describe('a transfer never draws more TRX than was fixed for it', () => {
  it('blocks a transfer that dearer gas would take past its cap — the trader’s other TRX untouched — until a person raises it', async () => {
    const trade = await fundedBuy();
    const freeAfterAcceptance = await networkAvailable(w.app, usdtTrader.traderId);
    const heldBefore = await holdOf(trade.tradeId);
    w.net.params.energyPriceSun = 400n;
    await runFeeRefresh(w.app, w.rails);
    try {
      await railsTurn(w);
      const payout = (await payoutOf(trade.tradeId))!;
      expect(payout.status).toBe('BLOCKED');
      expect(payout.blocked_reason).toMatch(/may draw .* TRX in all/);
      expect((await sends(trade.tradeId)).filter((s) => s.purpose === 'TOPUP')).toEqual([]);
      const caseRow = await w.app.selectFrom('exception_case').select(['type', 'status']).where('subject_id', '=', payout.id).executeTakeFirstOrThrow();
      expect(caseRow).toEqual({ type: 'NETWORK_BUDGET_SHORT', status: 'OPEN' });
      // Retrying by itself changes nothing: the cap is the cap.
      await runAs(w.app, (await import('@inrp2p/settlement')).unblockChainSend(w.finance.actor), w.finance.ref, 'chain_send.unblock', { sendId: payout.id, reason: 'try again' });
      await railsTurn(w);
      expect((await payoutOf(trade.tradeId))!.status).toBe('BLOCKED');
      expect(await networkAvailable(w.app, usdtTrader.traderId)).toBe(freeAfterAcceptance);
      expect(await holdOf(trade.tradeId)).toBe(heldBefore);

      // Only a person who may manage the network raises it, upward only, with a reason; the hold rises with it.
      await expect(raiseCap(payout.id, '80', w.dealer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(raiseCap(payout.id, '1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      const raised = await raiseCap(payout.id, '80');
      expect(raised.status).toBe('PLANNED');
      expect(await holdOf(trade.tradeId)).toBe(parseTrx('80'));
      expect(freeAfterAcceptance - (await networkAvailable(w.app, usdtTrader.traderId))).toBe(parseTrx('80') - heldBefore);
      await railsSettle(w, trade.tradeId, 8);
      expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
      const { used, cap } = await drawn(payout.id);
      expect(cap).toBe(parseTrx('80'));
      expect(used).toBeLessThanOrEqual(cap);
    } finally {
      w.net.params.energyPriceSun = 100n;
      await runFeeRefresh(w.app, w.rails);
    }
  });

  it('retries burn their own cap: once the next top-up would pass it, the transfer waits for a person instead of drawing more', async () => {
    const trade = await fundedBuy();
    const freeAfterAcceptance = await networkAvailable(w.app, usdtTrader.traderId);
    // Every block the chain charges more energy than it estimated: each signed attempt fails OUT_OF_ENERGY.
    const failingBlock = () => {
      const before = [w.net.params.energyToHolder, w.net.params.energyToNewHolder] as const;
      w.net.params.energyToHolder = 400_000n;
      w.net.params.energyToNewHolder = 400_000n;
      w.net.mine();
      [w.net.params.energyToHolder, w.net.params.energyToNewHolder] = before;
    };
    for (let i = 0; i < 16 && (await payoutOf(trade.tradeId))?.status !== 'BLOCKED'; i++) {
      await railsTurn(w, { mine: false });
      failingBlock();
    }
    const payout = (await payoutOf(trade.tradeId))!;
    expect(payout.status).toBe('BLOCKED');
    expect(payout.blocked_reason).toMatch(/may draw .* TRX in all/);
    const failed = (await attemptsOf(payout.id)).filter((a) => a.status === 'FAILED');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed.length).toBeLessThan(3);
    const { used, cap } = await drawn(payout.id);
    expect(used).toBeLessThanOrEqual(cap);
    // Nothing beyond the trade's hold: the trader's free TRX is what it was right after acceptance.
    expect(await networkAvailable(w.app, usdtTrader.traderId)).toBe(freeAfterAcceptance);

    await raiseCap(payout.id, formatTrx(cap + parseTrx('20')));
    await railsSettle(w, trade.tradeId, 8);
    expect(await stateOf(trade.tradeId)).toBe('COMPLETED');
    expect((await attemptsOf(payout.id)).filter((a) => a.status === 'CONFIRMED')).toHaveLength(1);
  });

  it('fits a trade’s caps in its hold — the client’s transfer at its priced fee, the return at one held transfer — and the database holds every line (IX114, IX115)', async () => {
    // A client selling: the payment to the trader is capped at one held transfer, leaving the return its own.
    const trade = await paidSell('1000', '103.500000');
    await railsSettle(w, trade.tradeId);
    const payment = (await sends(trade.tradeId)).find((s) => s.purpose === 'ROUTE_PAYMENT')!;
    const hold = await w.app.selectFrom('network_budget_hold').select(['amount_sun', 'per_send_sun']).where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow();
    expect(payment.network_cap_sun).toBe(hold.per_send_sun);
    expect(hold.amount_sun! - (await drawn(payment.id)).used).toBeGreaterThanOrEqual(hold.per_send_sun!);

    const budget = await w.app.selectFrom('custody_hd_account').select(['fee_wallet_address', 'fee_wallet_path']).executeTakeFirstOrThrow();
    // A top-up past its send's cap (IX114).
    const open = await fundedBuy();
    await railsTurn(w);
    const parent = (await payoutOf(open.tradeId))!;
    const used = (await drawn(parent.id)).used;
    await expect(sql`insert into chain_send (asset, purpose, trade_id, parent_send_id, from_address, from_path, to_address, amount_minor, funder_trader_id, bearer, status, needs_approval, requested_by)
                     values ('TRX', 'TOPUP', ${open.tradeId}, ${parent.id}, ${budget.fee_wallet_address}, ${budget.fee_wallet_path}, ${parent.from_address},
                             ${parent.network_cap_sun! - used + 1n}, ${parent.funder_trader_id}, 'CLIENT', 'PLANNED', false, 'test')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX114');
    // A cap that falls, or rises past the hold, and a hold that falls (IX115).
    await expect(sql`update chain_send set network_cap_sun = network_cap_sun - 1 where id = ${parent.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX115');
    await expect(sql`update chain_send set network_cap_sun = network_cap_sun + 1000000000 where id = ${parent.id}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX115');
    await expect(sql`update network_budget_hold set amount_sun = amount_sun - 1 where trade_id = ${open.tradeId}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX115');
    await railsSettle(w, open.tradeId);
    expect(await stateOf(open.tradeId)).toBe('COMPLETED');
  });
});

describe('the TRX price keeps itself current', () => {
  it('publishes the market price under the system actor, and leaves a move too large for a person', async () => {
    const before = await latestTrxRate(w.app);
    expect(before).not.toBeNull();
    // A small move: published, so quotes never reach the 72-hour limit for want of someone publishing.
    const near = (before!.usdtPerTrxMicro * 105n) / 100n;
    const out = await runTrxRateRefresh(w.app, async () => ({ usdtPerTrxMicro: near, source: 'market: test 1.05x' }));
    expect(out.rateId).not.toBeNull();
    const now = await latestTrxRate(w.app);
    expect(now!.usdtPerTrxMicro).toBe(near);
    expect(now!.source).toBe('market: test 1.05x');
    // A jump of more than 30%: not published — a broken feed is not priced into anyone's fee.
    const far = near * 2n;
    const skipped = await runTrxRateRefresh(w.app, async () => ({ usdtPerTrxMicro: far, source: 'market: test 2x' }));
    expect(skipped.rateId).toBeNull();
    expect(skipped.skipped).toMatch(/left for a person/);
    expect((await latestTrxRate(w.app))!.usdtPerTrxMicro).toBe(near);
    // And quotes still price with it.
    await expect(currentNetworkCosts(w.app)).resolves.toMatchObject({ rate: { usdtPerTrxMicro: near } });
  });
});
