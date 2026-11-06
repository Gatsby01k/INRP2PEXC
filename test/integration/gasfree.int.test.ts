import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, Rate, encodeTronAddress } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { executeCommand } from '@inrp2p/commands';
import { runAs } from '@inrp2p/identity/testing';
import { gasFreeAddressOf } from '@inrp2p/adapters';
import { FULL_ACCESS, deskTrade, deskTradeRecord, networkView } from '@inrp2p/desk';
import { globalImbalance } from '@inrp2p/ledger';
import { setNetworkFeePolicy } from '@inrp2p/network';
import { acceptQuote, createRequest, quoteDeskDealInTx } from '@inrp2p/quotes';
import { runGasFreeFeeRefresh } from '@inrp2p/onchain';
import { claimIncomingFiat, confirmClientReceipt, raiseChainSendCap, runP2pDeadlines } from '@inrp2p/settlement';
import { attachDeskClientInTx, configureTraderProgram } from '@inrp2p/trader-core';
import { assignRequest, confirmOrderPaymentReceived, openDesk, orderDeliveryAddress, setDeskPrices, setDeskStatus, submitOrderPayment } from '@inrp2p/traders';
import { registerTreasuryWallet } from '@inrp2p/treasury';
import { CLIENT_SENDER, balanceOf, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { confirmOnChain, sendUsdt, utr } from './traders-world.ts';
import { type RailsWorld, createRailsWorld, railsSettle, railsTrader, railsTurn } from './rails-world.ts';

/**
 * Network fees in USDT through GasFree (ADR 0022): a deal's escrow is the GasFree account of one of the exchange's keys; its
 * USDT leaves by a permit the key signs, and each transfer's network is paid in USDT out of that same account, in the same
 * transaction — carried by the deal itself. Nobody prepays anything: no trader holds TRX, the platform holds none.
 */
let w: RailsWorld;
let desk: Awaited<ReturnType<typeof railsTrader>>;
let deskId: string;

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const usdt = (d: string) => Money.parse(d, 'USDT').minor;
const system = <R>(name: string, fn: Parameters<typeof executeCommand<Record<string, unknown>, R>>[1]['handle']) =>
  executeCommand(w.app, { authorize: async () => {}, handle: fn }, { name, actor: SYSTEM, payload: {}, idempotencyKey: randomUUID(), financial: true }).then((o) => o.result);
const quoteDeal = (requestId: string, clientRate: string | null = null) =>
  system('desk_deal.quote', (ctx) => quoteDeskDealInTx(ctx, w.railsDeps, { requestId, clientRateMicro: clientRate ? Rate.parse(clientRate, 'CLIENT').micro : null, validitySeconds: 120, committedBy: desk.admin.userId }));
const deskRequest = (direction: 'SELL_USDT' | 'BUY_USDT', amount: string) =>
  runAs(w.app, createRequest(w.acceptor.actor, {}), w.acceptor.ref, 'request.create', {
    clientId: w.clientId, direction, fixedSide: 'BASE' as const, amount, deskId, ...(direction === 'SELL_USDT' ? { bankAccountId: w.bankAccountId } : { walletId: w.walletId }),
  });
const accept = (quoteId: string) => runAs(w.app, acceptQuote(w.acceptor.actor, w.railsDeps), w.acceptor.ref, 'quote.accept', { quoteId });
const refOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('ref').where('id', '=', tradeId).executeTakeFirstOrThrow()).ref;
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', tradeId).executeTakeFirstOrThrow()).lifecycle_state;
const orderRefOf = async (orderId: string) => (await w.app.selectFrom('trader_order').select('ref').where('id', '=', orderId).executeTakeFirstOrThrow()).ref;
const sends = (tradeId: string) => w.app.selectFrom('chain_send').selectAll().where('trade_id', '=', tradeId).orderBy('created_at').execute();
const permitsOf = (sendId: string) => w.app.selectFrom('gasfree_permit').selectAll().where('send_id', '=', sendId).orderBy('seq').execute();
const holdOf = (tradeId: string) => w.app.selectFrom('network_budget_hold').selectAll().where('trade_id', '=', tradeId).executeTakeFirstOrThrow();
const termsOf = (quoteId: string) => w.app.selectFrom('quote_network_fee').selectAll().where('quote_id', '=', quoteId).executeTakeFirstOrThrow();
const clientWallet = async () => (await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow()).address;
const dbCode = (p: Promise<unknown>) => p.then(() => null, (e) => pgErrorCode(e) ?? e);
const late = async (minutes = 31) => {
  const clock = await w.t.pinnedClock();
  await clock.set(new Date(Date.now() + minutes * 60_000));
  return clock;
};

/** A client's sale to the desk, through to the desk's rupees confirmed by the client; the signer still to pay. */
async function sellToDesk(amount: string) {
  const request = await deskRequest('SELL_USDT', amount);
  const quote = await quoteDeal(request.requestId);
  const accepted = await accept(quote.quoteId);
  await settleFirstLeg(w, accepted.tradeId);
  const paid = await runAs(w.app, submitOrderPayment(desk.admin.actor, w.traderDeps), desk.admin.ref, 'trader_order.submit_payment', { ref: await orderRefOf(quote.orderId), rail: 'IMPS' as const, utr: utr() });
  const holder = (await w.app.selectFrom('bank_account').select('holder_name').where('id', '=', desk.bankAccountId).executeTakeFirstOrThrow()).holder_name;
  await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: await refOf(accepted.tradeId), legRef: paid.settlementRef, senderName: holder });
  return { quote, tradeId: accepted.tradeId };
}

/** A client's purchase from the desk: the desk funds the escrow; `pay` has the client pay and the desk confirm it. */
async function buyFromDesk(amount: string, opts: { pay: boolean }) {
  const request = await deskRequest('BUY_USDT', amount);
  const quote = await quoteDeal(request.requestId, '102.500000');
  const accepted = await accept(quote.quoteId);
  const orderRef = await orderRefOf(quote.orderId);
  const { address } = await runAs(w.app, orderDeliveryAddress(desk.admin.actor, w.traderDeps), desk.admin.ref, 'trader_order.delivery_address', { ref: orderRef });
  await sendUsdt(w, desk.walletAddress, address, quote.deskBase);
  await confirmOnChain(w);
  if (opts.pay) {
    await runAs(w.app, claimIncomingFiat(w.acceptor.actor), w.acceptor.ref, 'fiat_in.claim', { tradeRef: await refOf(accepted.tradeId), rail: 'IMPS' as const, utr: utr(), fromBankAccountId: w.bankAccountId });
    await runAs(w.app, confirmOrderPaymentReceived(desk.admin.actor, w.traderDeps), desk.admin.ref, 'trader_order.confirm_received', { ref: orderRef, senderName: CLIENT_SENDER });
  }
  return { quote, tradeId: accepted.tradeId, address };
}

beforeAll(async () => {
  w = await createRailsWorld('gasfree', { resourceMode: 'GASFREE' });
  const program = await w.app.selectFrom('trader_program').select('version').where('id', '=', 1).executeTakeFirstOrThrow();
  await runAs(w.app, configureTraderProgram(w.finance.actor), w.finance.ref, 'trader_program.configure', { expectedVersion: program.version, executionMode: 'P2P' as const, riskPolicy: null, reason: 'desks deal P2P' });
  // The desk holds no TRX at all, and has deposited nothing for the network.
  desk = await railsTrader(w, 'Konkan Desk', {
    buy: { capacity: '50000000', rate: '101.20', min: '100', max: '20000000' },
    sell: { capacity: '500000', rate: '101.80', min: '10', max: '200000' },
  }, '0');
  const opened = await runAs(w.app, openDesk(desk.admin.actor), desk.admin.ref, 'desk.open', { handle: 'konkan', displayName: 'Konkan' });
  await runAs(w.app, setDeskStatus(desk.admin.actor), desk.admin.ref, 'desk.set_status', { expectedVersion: opened.version, status: 'LIVE' as const });
  await runAs(w.app, setDeskPrices(desk.admin.actor), desk.admin.ref, 'desk.set_prices', {
    prices: [{ direction: 'SELL_USDT' as const, rate: '100.900000', min: '10', max: '20000', live: true }, { direction: 'BUY_USDT' as const, rate: '102.100000', min: '10', max: '20000', live: true }],
    validForHours: 48,
  });
  await system('desk_client.attach', (ctx) => attachDeskClientInTx(ctx, { deskId: opened.deskId, clientId: w.clientId, source: 'PAGE' }));
  deskId = opened.deskId;
  await runAs(w.app, registerTreasuryWallet(w.owner.actor), w.owner.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(Buffer.alloc(20, 7)), label: 'INRP2P revenue', role: 'REVENUE' as const });
  await runAs(w.app, setNetworkFeePolicy(w.owner.actor), w.owner.ref, 'settings.network_fees', { feeSweepMin: '1', reason: 'sweep every completed deal in this test' });
});
afterAll(async () => w.close());

describe('a desk on GasFree', () => {
  it('prices a deal with its network in the desk’s USDT side, at GasFree’s fees — activation, payout, sweep — nothing prepaid', async () => {
    const request = await deskRequest('SELL_USDT', '1000');
    const quote = await quoteDeal(request.requestId);
    const terms = await termsOf(quote.quoteId);
    expect(terms).toMatchObject({ unit: 'USDT', transfer_fee_usdt_minor: usdt('1.5'), activate_fee_usdt_minor: usdt('1.5'), fee_usdt_minor: usdt('4.5'), funder_trader_id: desk.traderId });
    expect(terms).toMatchObject({ snapshot_id: null, trx_rate_id: null, reserve_sun: null });
    // 1,000 USDT less INRP2P's 0.25% and the network.
    expect(usdt(quote.deskBase)).toBe(usdt('1000') - usdt('2.5') - usdt('4.5'));
  });

  it('a client sells: its USDT reaches a GasFree account; the desk is paid by one permit whose network comes out of the allowance', async () => {
    const before = w.chain.balanceOf(desk.walletAddress);
    const deal = await sellToDesk('1000');
    const deposit = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id')
      .select(['d.address', 'd.owner_address', 'd.custody_reference']).where('a.trade_id', '=', deal.tradeId).executeTakeFirstOrThrow();
    // The address the client was given is the GasFree account of the HD key at that path — computed, never asked for.
    expect(deposit.owner_address).toBe(w.signer.addressOf(deposit.custody_reference));
    expect(deposit.address).toBe(gasFreeAddressOf(deposit.owner_address!, w.gasFree.chain));
    expect(await holdOf(deal.tradeId)).toMatchObject({ unit: 'USDT', deal_funded_usdt_minor: usdt('4.5'), amount_sun: null });

    await railsSettle(w, deal.tradeId);
    expect(await stateOf(deal.tradeId)).toBe('COMPLETED');
    expect(w.chain.balanceOf(desk.walletAddress) - before).toBe(usdt(deal.quote.deskBase));
    const [payment] = await sends(deal.tradeId);
    expect(payment).toMatchObject({ purpose: 'ROUTE_PAYMENT', status: 'CONFIRMED', fee_cap_usdt_minor: usdt('3'), network_cap_sun: null });
    const [permit] = await permitsOf(payment!.id);
    expect(permit).toMatchObject({ status: 'CONFIRMED', nonce: 0n, fee_minor: usdt('3'), activate_fee_minor: usdt('1.5'), owner_address: deposit.owner_address });
    // No TRX anywhere: not at the deal address, not sent by anyone; one permit taken by GasFree.
    expect(w.net.trxOf(deposit.address)).toBe(0n);
    expect(await w.app.selectFrom('chain_send').select('id').where('purpose', '=', 'TOPUP').where('trade_id', '=', deal.tradeId).execute()).toHaveLength(0);
    // What is left at the address: INRP2P's fee and the sweep's own network.
    expect(w.chain.balanceOf(deposit.address)).toBe(usdt('2.5') + usdt('1.5'));
    // The allowance settled at cost: the payout's network recovered, the rest INRP2P's margin until the sweep pays from it.
    expect(await holdOf(deal.tradeId)).toMatchObject({ status: 'CLOSED', spent_usdt_minor: usdt('3'), unused_usdt_minor: usdt('1.5') });
    expect(await balanceOf(w.app, 'LIAB:NETWORK_ALLOWANCE', 'USDT', { tradeId: deal.tradeId })).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);

    // The sweep: one more permit, its network out of what the allowance left; INRP2P receives its fee exactly.
    const revenue = (await w.app.selectFrom('treasury_wallet').select('address').where('role', '=', 'REVENUE').executeTakeFirstOrThrow()).address;
    const earned = w.chain.balanceOf(revenue);
    for (let i = 0; i < 4; i++) await railsTurn(w);
    const sweep = await w.app.selectFrom('chain_send').selectAll().where('purpose', '=', 'FEE_SWEEP').where('from_address', '=', deposit.address).executeTakeFirstOrThrow();
    expect(sweep).toMatchObject({ status: 'CONFIRMED', amount_minor: usdt('2.5'), fee_cap_usdt_minor: usdt('1.5') });
    expect(w.chain.balanceOf(revenue) - earned).toBe(usdt('2.5'));
    expect(w.chain.balanceOf(deposit.address)).toBe(0n);
    expect(w.gasFree.taken.filter((p) => p.user === deposit.owner_address)).toHaveLength(2);
    expect(await globalImbalance(w.app)).toEqual([]);

    // The operator's pages read such a deal: it froze no TRX price, so nothing there may convert TRX.
    const seen = await deskTrade(w.app, deal.tradeId, FULL_ACCESS);
    expect(seen.network?.gasFree).toMatchObject({ allowance: '4.500000', spent: '3.000000', unused: '1.500000' });
    expect(seen.settlesP2p).toBe(true);
    await expect(deskTradeRecord(w.app, deal.tradeId, FULL_ACCESS)).resolves.toBeTruthy();
    // The table of what TRX cost each trade leaves it out; the rest of the page still reads.
    expect((await networkView(w.app)).trades.map((t) => t.tradeId)).not.toContain(deal.tradeId);
  });

  it('a client buys: the desk funds the escrow with the allowance in it, and the client receives exactly its USDT', async () => {
    const before = w.chain.balanceOf(await clientWallet());
    const deal = await buyFromDesk('300', { pay: true });
    expect(usdt(deal.quote.deskBase)).toBe(usdt('300') + usdt('0.75') + usdt('4.5'));
    await railsSettle(w, deal.tradeId);
    expect(await stateOf(deal.tradeId)).toBe('COMPLETED');
    expect(w.chain.balanceOf(await clientWallet()) - before).toBe(usdt('300'));
    const payout = (await sends(deal.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
    expect((await permitsOf(payout.id))[0]).toMatchObject({ status: 'CONFIRMED', fee_minor: usdt('3') });
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('a buy the client never paid: the desk’s escrow goes back less its return’s own network', async () => {
    const deal = await buyFromDesk('200', { pay: false });
    const before = w.chain.balanceOf(desk.walletAddress);
    // The client is warned when its time is up, and has the final period before the deal is cancelled (ADR 0023).
    await runP2pDeadlines((await late()).db);
    expect(await stateOf(deal.tradeId)).toBe('AWAITING_FIRST_LEG');
    await runP2pDeadlines((await late(37)).db);
    expect(await stateOf(deal.tradeId)).toBe('CANCELLED');
    await railsSettle(w, deal.tradeId);
    const back = (await sends(deal.tradeId)).find((s) => s.purpose === 'ESCROW_RETURN')!;
    expect(back).toMatchObject({ status: 'CONFIRMED', amount_minor: usdt(deal.quote.deskBase) - usdt('3'), fee_cap_usdt_minor: usdt('3') });
    expect(w.chain.balanceOf(desk.walletAddress) - before).toBe(usdt(deal.quote.deskBase) - usdt('3'));
    expect(w.chain.balanceOf(deal.address)).toBe(0n);
    // Nothing of it was INRP2P's: nothing to sweep, the route receivable closed by the return and its network.
    const sweepable = await sql<{ n: string }>`select inrp2p_trade_sweepable(${deal.tradeId}::uuid, ${`TRON:${deal.address}`})::text as n`.execute(w.app);
    expect(sweepable.rows[0]!.n).toBe('0');
    expect(await balanceOf(w.app, 'ASSET:ROUTE_RECEIVABLE', 'USDT', { tradeId: deal.tradeId })).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('a sale the desk never paid: the client’s USDT goes back less the refund’s own network, stated on the leg', async () => {
    const request = await deskRequest('SELL_USDT', '500');
    const quote = await quoteDeal(request.requestId);
    const accepted = await accept(quote.quoteId);
    await settleFirstLeg(w, accepted.tradeId);
    // The desk is warned when its time is up, and has the final period before the deal unwinds (ADR 0023).
    expect((await runP2pDeadlines((await late()).db)).unwound).toBe(0);
    expect((await runP2pDeadlines((await late(37)).db)).unwound).toBe(1);
    const before = w.chain.balanceOf(w.clientSourceAddress);
    await railsSettle(w, accepted.tradeId);
    expect(await stateOf(accepted.tradeId)).toBe('CANCELLED');
    expect(w.chain.balanceOf(w.clientSourceAddress) - before).toBe(usdt('497'));
    const leg = await w.app.selectFrom('settlement_leg').select(['amount_minor', 'network_fee_minor', 'status']).where('trade_id', '=', accepted.tradeId).where('side', '=', 'REFUND_TO_CLIENT').executeTakeFirstOrThrow();
    expect(leg).toMatchObject({ amount_minor: usdt('497'), network_fee_minor: usdt('3'), status: 'COMPLETED' });
    const refund = (await sends(accepted.tradeId)).find((s) => s.purpose === 'REFUND')!;
    expect(refund).toMatchObject({ status: 'CONFIRMED', bearer: 'CLIENT', fee_cap_usdt_minor: usdt('3') });
    // The client receivable is closed by the refund and its network together.
    expect(await balanceOf(w.app, 'ASSET:CLIENT_RECEIVABLE', 'USDT', { tradeId: accepted.tradeId })).toBe(0n);
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('when GasFree does not carry a permit out', () => {
  it('a permit it holds past its deadline is proved dead — never executed — before the send is signed again; one transfer in all', async () => {
    w.gasFree.stall = true;
    let tradeId: string | undefined;
    let sendId: string | undefined;
    try {
      const deal = await buyFromDesk('120', { pay: true });
      tradeId = deal.tradeId;
      await railsTurn(w);
      await railsTurn(w);
      const payout = (await sends(tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
      sendId = payout.id;
      expect(payout.status).toBe('SENDING');
      expect(await permitsOf(sendId)).toMatchObject([{ status: 'SUBMITTED', seq: 1 }]);
      // Past its deadline on every provider, its nonce unused: dead, and only then a second permit, the same nonce.
      w.net.advance(5 * 60_000);
      await railsTurn(w);
    } finally {
      w.gasFree.stall = false;
    }
    const before = w.chain.balanceOf(await clientWallet());
    await railsSettle(w, tradeId!);
    const permits = await permitsOf(sendId!);
    expect(permits.map((p) => p.status)).toEqual(['EXPIRED', 'CONFIRMED']);
    expect(permits[1]!.nonce).toBe(permits[0]!.nonce);
    // The stalled one can never execute now: past its deadline, its nonce used by the second.
    w.gasFree.finish();
    expect(w.chain.balanceOf(await clientWallet()) - before).toBe(usdt('120'));
    expect(await stateOf(tradeId!)).toBe('COMPLETED');
    expect(await globalImbalance(w.app)).toEqual([]);
  });

  it('a fee that rose past the cap stops the send for a person, who raises it out of INRP2P’s fee', async () => {
    const deal = await buyFromDesk('150', { pay: true });
    w.gasFree.transferFee = 2_000_000n;
    let payoutId: string | undefined;
    try {
      await railsTurn(w);
      const payout = (await sends(deal.tradeId)).find((s) => s.purpose === 'CLIENT_PAYOUT')!;
      payoutId = payout.id;
      expect(payout).toMatchObject({ status: 'BLOCKED', fee_cap_usdt_minor: usdt('3') });
      expect(payout.blocked_reason).toMatch(/GasFree now charges 3\.500000 USDT/);
      await runAs(w.app, raiseChainSendCap(w.owner.actor), w.owner.ref, 'chain_send.raise_network_cap', { sendId: payout.id, cap: '3.5', reason: 'GasFree raised its fee: INRP2P carries it' });
      await railsSettle(w, deal.tradeId);
    } finally {
      w.gasFree.transferFee = 1_500_000n;
    }
    expect((await permitsOf(payoutId!))[0]).toMatchObject({ status: 'CONFIRMED', fee_minor: usdt('3.5') });
    expect(await holdOf(deal.tradeId)).toMatchObject({ status: 'CLOSED', spent_usdt_minor: usdt('3.5'), unused_usdt_minor: usdt('1') });
    expect(await globalImbalance(w.app)).toEqual([]);
  });
});

describe('what the database refuses', () => {
  it('a permit of a send that is not sending, a changed decided permit, a lowered cap, and a GasFree send without its network earmarked', async () => {
    const confirmed = await w.app.selectFrom('gasfree_permit').selectAll().where('status', '=', 'CONFIRMED').executeTakeFirstOrThrow();
    const { id: _id, signed_at: _s, ...copy } = confirmed;
    expect(await dbCode(w.app.insertInto('gasfree_permit').values({ ...copy, seq: 99, digest_hex: 'ab'.repeat(32), status: 'SIGNED', trace_id: null, txid: null, fee_minor: null, activate_fee_minor: null, decided_at: null, decided_by: null }).execute()))
      .toBe('IX131');
    expect(await dbCode(w.app.updateTable('gasfree_permit').set({ last_answer: 'rewritten' }).where('id', '=', confirmed.id).execute())).toBe('IX132');
    const send = await w.app.selectFrom('chain_send').select(['id', 'fee_cap_usdt_minor']).where('id', '=', confirmed.send_id).executeTakeFirstOrThrow();
    expect(await dbCode(w.app.updateTable('chain_send').set({ fee_cap_usdt_minor: send.fee_cap_usdt_minor! - 1n }).where('id', '=', send.id).execute())).toBe('IX131');
    // A live GasFree send must have its whole cap earmarked by commit (IX133).
    w.gasFree.stall = true;
    try {
      const deal = await buyFromDesk('110', { pay: true });
      await railsTurn(w);
      const payout = (await sends(deal.tradeId)).find((x) => x.purpose === 'CLIENT_PAYOUT')!;
      expect(payout.status).toBe('SENDING');
      const earmark = await w.app.selectFrom('funding_allocation').select('id').where('use_chain_send_id', '=', payout.id).where('use_kind', '=', 'NETWORK_FEE').where('status', '=', 'ACTIVE').executeTakeFirstOrThrow();
      expect(await dbCode(w.app.updateTable('funding_allocation').set({ status: 'RELEASED', closed_by: 'test', closed_at: new Date(), close_reason: 'test' }).where('id', '=', earmark.id).execute())).toBe('IX133');
      w.gasFree.stall = false;
      w.gasFree.finish();
      await railsSettle(w, deal.tradeId);
      expect(await stateOf(deal.tradeId)).toBe('COMPLETED');
    } finally {
      w.gasFree.stall = false;
    }
  });

  it('switching deals to GasFree is refused until its fees were read within the hour; going back to TRX never is', async () => {
    const set = (payload: Record<string, unknown>) => runAs(w.app, setNetworkFeePolicy(w.owner.actor), w.owner.ref, 'settings.network_fees', { reason: 'test: switching how deals are fuelled', ...payload });
    await set({ resourceMode: 'BURN' });
    const clock = await late(120);
    try {
      await expect(runAs(clock.db, setNetworkFeePolicy(w.owner.actor), w.owner.ref, 'settings.network_fees', { resourceMode: 'GASFREE', reason: 'test: switching how deals are fuelled' }))
        .rejects.toMatchObject({ code: 'NETWORK_FEES_UNKNOWN' });
    } finally {
      await clock.set(null);
    }
    await set({ resourceMode: 'GASFREE' });
  });
});

describe('on GasFree, TRX does not decide anything', () => {
  it('routes a P2P request to a trader while the TRX price and the chain’s TRX fees are stale — they price nothing here', async () => {
    // Three days and an hour on: the TRX price and the chain's fee reading are past their limits; GasFree's fees, read
    // again now, are current.
    const clock = await w.t.pinnedClock();
    await clock.set(new Date(Date.now() + (72 + 1) * 3600_000));
    await runGasFreeFeeRefresh(clock.db, w.rails);
    const request = await runAs(clock.db, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', {
      clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '200', bankAccountId: w.bankAccountId,
    });
    const assigned = await runAs(clock.db, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: request.requestId, plannedClientRate: '100.500000' });
    expect(assigned).toMatchObject({ ref: expect.stringMatching(/^TO-/) });
    const order = await w.app.selectFrom('trader_order').select(['trader_id', 'status']).where('ref', '=', (assigned as { ref: string }).ref).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ trader_id: desk.traderId, status: 'OFFERED' });
    await clock.set(null);
  });
});
