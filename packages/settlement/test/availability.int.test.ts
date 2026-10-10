import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { executeCommand } from '@inrp2p/commands';
import type { Db } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { type BalanceObservationInput, recordBalanceObservation, registerTreasuryWallet, releaseCooledDownAddresses } from '@inrp2p/treasury';
import {
  cancelTrade, confirmPayout, confirmRouteSettlement, createPayoutLeg, physicalAvailability, recordLegEvidence, recordRouteSettlement, sendPayoutLeg,
} from '../src/index.ts';
import { clientDepositAddressOf, createWorld, deliverCounterparty, newUtr, observe, openTrade, settleFirstLeg, type World } from './world.ts';

/**
 * B2 (ADR 0016 §2.6): a USDT payout or refund leaves an address only when a fresh, usable reading of the chain shows
 * the money there, net of everything already leaving it. Economic cover (the funding earmarks) is necessary and is
 * not enough.
 */
let w: World;
beforeAll(async () => { w = await createWorld('custody_availability'); });
afterAll(async () => w.close());

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const usdt = (v: string) => Money.parse(v, 'USDT').minor;

/** A HOT wallet nobody has read yet, so each test decides what its latest reading says. */
async function freshWallet(): Promise<{ id: string; address: string }> {
  const address = encodeTronAddress(randomBytes(20));
  const r = await runAs(w.app, registerTreasuryWallet(w.finance.actor), w.finance.ref, 'treasury.register_wallet', { network: 'TRON' as const, address, label: `HOT ${address.slice(0, 8)}`, role: 'HOT' as const });
  return { id: r.walletId, address };
}

/** A BUY trade whose client paid and whose counterparty delivered `amount` USDT to `wallet`, with its payout planned from there. */
async function plannedPayout(wallet: { id: string }, amount: string): Promise<{ tradeId: string; legId: string }> {
  const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: amount, clientRate: '106.000000', routeRate: '104.200000' });
  await settleFirstLeg(w, trade.tradeId);
  await deliverCounterparty(w, trade.tradeId, { treasuryWalletId: wallet.id });
  const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, treasuryWalletId: wallet.id });
  return { tradeId: trade.tradeId, legId: leg.legId };
}

const send = (legId: string, db: Db = w.app) => runAs(db, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId });

/** Pays a sent leg on the fake chain and confirms it, as the desk would once the transfer is final. */
async function payOnChain(legId: string, from: string, amount: string): Promise<void> {
  const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
  const receipt = w.chain.add({ from, to: client.address, amountMinor: usdt(amount) });
  await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId, txHash: receipt.txHash, logIndex: receipt.logIndex, fromAddress: from });
  await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId, idempotencyKey: randomUUID() });
}

/** Records a reading of the quality a test needs; a usable one carries what the fake chain shows now. */
async function reading(address: string, quality: BalanceObservationInput['quality'], extra: Partial<BalanceObservationInput> = {}): Promise<void> {
  const usable = quality === 'AGREED' || quality === 'SINGLE_SOURCE';
  const truth = await w.chain.balanceSources()[0]!.getSolidifiedBalance(address, w.chain.tokenContract);
  const input: BalanceObservationInput = {
    address, tokenContract: w.chain.tokenContract, quality,
    balanceMinor: usable ? truth.balanceMinor : null, solidifiedBlock: usable ? truth.solidifiedBlock : null, trxSun: null,
    providers: quality === 'SINGLE_SOURCE' ? ['fake-node-a'] : ['fake-node-a', 'fake-node-b'],
    independentSources: quality === 'AGREED' ? 2 : quality === 'SINGLE_SOURCE' ? 1 : 0,
    detail: usable ? null : 'test: the sources could not be relied on',
    ...extra,
  };
  await executeCommand(w.app, { authorize: async () => {}, handle: (ctx) => recordBalanceObservation(ctx, input) }, { name: 'custody.observe_balance', actor: SYSTEM, payload: { address }, financial: false });
}

describe('a USDT outflow needs a fresh, usable reading (B2)', () => {
  it('refuses on no reading, a contradicted or failed reading, and a reading older than five minutes', async () => {
    const wallet = await freshWallet();
    const p = await plannedPayout(wallet, '100');
    await expect(send(p.legId)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });

    // The sources contradicted each other: recorded, never relied on.
    await reading(wallet.address, 'DISAGREED');
    await expect(send(p.legId)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });
    // A failed reading after a good one makes the good one unusable too: the latest reading is the one that counts.
    await observe(w, wallet.address);
    await reading(wallet.address, 'ERROR');
    await expect(send(p.legId)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });

    // A good reading, five minutes and a second later by the business clock, is too old to pay against.
    await observe(w, wallet.address);
    const clock = await w.t.pinnedClock();
    try {
      await clock.set(new Date(Date.now() + 301_000));
      await expect(send(p.legId, clock.db)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });
    } finally {
      await clock.set(null);
    }
    await send(p.legId);
    expect((await w.app.selectFrom('settlement_leg').select('status').where('id', '=', p.legId).executeTakeFirstOrThrow()).status).toBe('PROCESSING');
  });

  it('one source is enough below the D-05 threshold and never at or above it', async () => {
    const wallet = await freshWallet();
    const small = await plannedPayout(wallet, '9999.999999');
    const large = await plannedPayout(wallet, '10000');
    await reading(wallet.address, 'SINGLE_SOURCE');
    await expect(send(large.legId)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });
    await send(small.legId);
    await observe(w, wallet.address); // two independent sources agree
    await send(large.legId);
  });
});

describe('physical and economic availability are separate questions (B2)', () => {
  it('an outflow counts against its address until a reading shows it gone — and then never again', async () => {
    const wallet = await freshWallet();
    const a = await plannedPayout(wallet, '300');
    const b = await plannedPayout(wallet, '200');
    await observe(w, wallet.address); // the chain shows 500
    expect(await physicalAvailability(w.app, {}, { address: wallet.address })).toMatchObject({ observedMinor: usdt('500'), pendingOutMinor: usdt('500'), availableMinor: 0n });

    await send(a.legId); // 500 held, 200 planned for b: 300 free for a
    await payOnChain(a.legId, wallet.address, '300');
    // Paid and confirmed, but the reading predates it: still subtracted, exactly once.
    expect(await physicalAvailability(w.app, {}, { address: wallet.address })).toMatchObject({ observedMinor: usdt('500'), pendingOutMinor: usdt('500'), availableMinor: 0n });

    await observe(w, wallet.address); // the chain shows 200: a has left, and is not subtracted a second time
    expect(await physicalAvailability(w.app, {}, { address: wallet.address })).toMatchObject({ observedMinor: usdt('200'), pendingOutMinor: usdt('200'), availableMinor: 0n });
    await send(b.legId);
  });

  it('a reading that predates the counterparty’s delivery does not cover the payout', async () => {
    const wallet = await freshWallet();
    await observe(w, wallet.address); // empty
    const p = await plannedPayout(wallet, '100'); // delivered and earmarked after that reading
    await expect(send(p.legId)).rejects.toMatchObject({ code: 'CUSTODY_BALANCE_INSUFFICIENT' });
    await observe(w, wallet.address);
    await send(p.legId);
  });

  it('USDT that left the address outside the platform is not available, whatever the earmarks say', async () => {
    const wallet = await freshWallet();
    const p = await plannedPayout(wallet, '100');
    w.chain.add({ from: wallet.address, to: encodeTronAddress(randomBytes(20)), amountMinor: usdt('60') });
    await observe(w, wallet.address); // 40 left of the 100 delivered
    await expect(send(p.legId)).rejects.toMatchObject({ code: 'CUSTODY_BALANCE_INSUFFICIENT', details: { observed: usdt('40').toString(), requested: usdt('100').toString() } });
    // The earmark still stands: the money is the trade's, it is just not where it should be. Nothing pays it from elsewhere.
    const earmark = await w.app.selectFrom('funding_allocation').select('status').where('use_leg_id', '=', p.legId).executeTakeFirstOrThrow();
    expect(earmark.status).toBe('ACTIVE');
  });
});

describe('the observed balance cannot be written by hand (IX089)', () => {
  it('accepts only the latest recorded reading, and the readings themselves are append-only', async () => {
    const wallet = await freshWallet();
    await expect(sql`update treasury_wallet set observed_balance_minor = 1000000000000, observed_at = now() where id = ${wallet.id}`.execute(w.app))
      .rejects.toMatchObject({ code: 'IX089' });

    const p = await plannedPayout(wallet, '100');
    await observe(w, wallet.address); // 100
    const first = await w.app.selectFrom('custody_balance_observation').select(['id', 'balance_minor']).where('address', '=', wallet.address).orderBy('observed_at', 'desc').orderBy('id', 'desc').executeTakeFirstOrThrow();
    expect(first.balance_minor).toBe(usdt('100'));
    await send(p.legId);
    await payOnChain(p.legId, wallet.address, '100');
    await observe(w, wallet.address); // 0
    expect((await w.app.selectFrom('treasury_wallet').select('observed_balance_minor').where('id', '=', wallet.id).executeTakeFirstOrThrow()).observed_balance_minor).toBe(0n);

    // Winding the wallet back to the earlier, larger reading is refused: only the latest reading stands.
    await expect(sql`
      update treasury_wallet t set observed_balance_minor = o.balance_minor, observed_at = o.observed_at
        from custody_balance_observation o where o.id = ${first.id} and t.id = ${wallet.id}`.execute(w.app)).rejects.toMatchObject({ code: 'IX089' });
    await expect(sql`delete from custody_balance_observation where id = ${first.id}`.execute(w.app)).rejects.toThrow();
    await expect(sql`update custody_balance_observation set balance_minor = 0 where id = ${first.id}`.execute(w.app)).rejects.toThrow();
  });
});

describe('a deposit address holding a trade’s money stays out of the pool (IX088)', () => {
  it('the cooldown job passes over it, releases the others, and releases it once the money has left', async () => {
    // A SELL trade completes when the client is paid (FI-62); the client's USDT can still be at its deposit address,
    // owed to the counterparty that delivered the INR.
    const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '100', clientRate: '102.000000', routeRate: '104.200000' });
    await settleFirstLeg(w, trade.tradeId);
    await deliverCounterparty(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '10200.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    await send(leg.legId);
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
    await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    const held = await clientDepositAddressOf(w, trade.tradeId);

    // An address with nothing in it, cancelled before any money arrived.
    const idle = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '50' });
    const idleAddress = await clientDepositAddressOf(w, idle.tradeId);
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: idle.tradeId, reason: 'client stood down before sending' });

    const statusOf = async (id: string) => (await w.app.selectFrom('deposit_address').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
    expect([await statusOf(held.id), await statusOf(idleAddress.id)]).toEqual(['COOLDOWN', 'COOLDOWN']);
    // Both cooldowns elapse (test setup: a week passes).
    await sql`update deposit_address set cooldown_until = statement_timestamp() - interval '1 minute' where id in (${held.id}, ${idleAddress.id})`.execute(w.t.owner);
    const release = () => executeCommand(w.app, { authorize: async () => {}, handle: (ctx) => releaseCooledDownAddresses(ctx) }, { name: 'deposit_address.cooldown_release', actor: SYSTEM, payload: { run: randomUUID() }, idempotencyKey: randomUUID(), financial: true });

    await release();
    expect([await statusOf(held.id), await statusOf(idleAddress.id)]).toEqual(['COOLDOWN', 'AVAILABLE']);
    // Nor can anything else put it back: the database refuses (IX088).
    await expect(sql`update deposit_address set status = 'AVAILABLE', cooldown_until = null where id = ${held.id}`.execute(w.app)).rejects.toMatchObject({ code: 'IX088' });

    // The client's USDT goes to the counterparty — once that is planned, it is still there; once confirmed, it is gone.
    const route = await w.app.selectFrom('liquidity_route').select('registered_route_address').where('id', '=', w.routeId).executeTakeFirstOrThrow();
    const sent = w.chain.add({ from: held.address, to: route.registered_route_address!, amountMinor: usdt('100') });
    const toRoute = await runAs(w.app, recordRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.record', {
      routeObligationId: trade.routeObligationId, flow: 'TO_ROUTE' as const, amount: '100', txHash: sent.txHash, logIndex: sent.logIndex, sourceDepositAddressId: held.id,
    });
    await release();
    expect(await statusOf(held.id)).toBe('COOLDOWN');
    await runAs(w.app, confirmRouteSettlement(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'route_settlement.confirm', { routeSettlementId: toRoute.routeSettlementId });
    await release();
    expect(await statusOf(held.id)).toBe('AVAILABLE');
  });
});
