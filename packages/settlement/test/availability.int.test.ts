import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { executeCommand } from '@inrp2p/commands';
import type { Db } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import { type BalanceObservationInput, recordBalanceObservation, registerTreasuryWallet, releaseCooledDownAddresses } from '@inrp2p/treasury';
import { cancelTrade, createRefundLeg, physicalAvailability } from '../src/index.ts';
import { clientDepositAddressOf, createWorld, observe, openTrade, payClient, settleFirstLeg, type World } from './world.ts';

/**
 * B2 (ADR 0016 §2.6): a USDT payout or refund leaves an address only when a fresh, usable reading of the chain shows
 * the money there, net of everything already leaving it. Economic cover (the funding earmarks) is necessary and is
 * not enough.
 */
let w: World;
beforeAll(async () => { w = await createWorld('availability', { depositPoolSize: 60 }); });
afterAll(async () => w.close());

const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const usdt = (v: string) => Money.parse(v, 'USDT').minor;

/** A SELL deal whose client's USDT is final at its deposit address: what a refund would leave from. */
async function escrowed(base: string) {
  const trade = await openTrade(w, { baseUsdt: base, clientRate: '102.000000' });
  await settleFirstLeg(w, trade.tradeId);
  return { ...trade, deposit: await clientDepositAddressOf(w, trade.tradeId) };
}
const refund = (t: { tradeId: string; deposit: { id: string } }, db: Db = w.app) =>
  runAs(db, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: t.tradeId, sourceDepositAddressId: t.deposit.id });

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
    const t = await escrowed('100');
    await expect(refund(t)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });

    // The sources contradicted each other: recorded, never relied on.
    await reading(t.deposit.address, 'DISAGREED');
    await expect(refund(t)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });
    // A failed reading after a good one makes the good one unusable too: the latest reading is the one that counts.
    await observe(w, t.deposit.address);
    await reading(t.deposit.address, 'ERROR');
    await expect(refund(t)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });

    // A good reading, past five minutes by the business clock, is too old to pay against. Its age is counted in whole
    // seconds, so the clock moves two: read in the same millisecond as the reading, 301 s would floor to the limit itself.
    await observe(w, t.deposit.address);
    const clock = await w.t.pinnedClock();
    try {
      await clock.set(new Date(Date.now() + 302_000));
      await expect(refund(t, clock.db)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });
    } finally {
      await clock.set(null);
    }
    const planned = await refund(t);
    expect((await w.app.selectFrom('settlement_leg').select('status').where('id', '=', planned.legId).executeTakeFirstOrThrow()).status).toBe('PENDING');
  });

  it('one source is enough below the D-05 threshold and never at or above it', async () => {
    const small = await escrowed('9999.999999');
    await reading(small.deposit.address, 'SINGLE_SOURCE');
    await refund(small);
    const large = await escrowed('10000');
    await reading(large.deposit.address, 'SINGLE_SOURCE');
    await expect(refund(large)).rejects.toMatchObject({ code: 'CUSTODY_OBSERVATION_STALE' });
    await observe(w, large.deposit.address); // two independent sources agree
    await refund(large);
  });
});

describe('physical and economic availability are separate questions (B2)', () => {
  it('a planned outflow counts against its address until a reading shows it gone', async () => {
    const t = await escrowed('300');
    await observe(w, t.deposit.address);
    expect(await physicalAvailability(w.app, {}, { address: t.deposit.address })).toMatchObject({ observedMinor: usdt('300'), pendingOutMinor: 0n, availableMinor: usdt('300') });
    await refund(t);
    expect(await physicalAvailability(w.app, {}, { address: t.deposit.address })).toMatchObject({ observedMinor: usdt('300'), pendingOutMinor: usdt('300'), availableMinor: 0n });
  });

  it('a reading that predates the money does not cover the outflow', async () => {
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000' });
    const deposit = await clientDepositAddressOf(w, trade.tradeId);
    await observe(w, deposit.address); // empty
    await settleFirstLeg(w, trade.tradeId);
    await expect(refund({ tradeId: trade.tradeId, deposit })).rejects.toMatchObject({ code: 'CUSTODY_BALANCE_INSUFFICIENT' });
    await observe(w, deposit.address);
    await refund({ tradeId: trade.tradeId, deposit });
  });

  it('USDT that left the address outside the platform is not available, whatever the earmarks say', async () => {
    const t = await escrowed('100');
    w.chain.add({ from: t.deposit.address, to: encodeTronAddress(randomBytes(20)), amountMinor: usdt('60') });
    await observe(w, t.deposit.address); // 40 left of the 100 that arrived
    await expect(refund(t)).rejects.toMatchObject({ code: 'CUSTODY_BALANCE_INSUFFICIENT', details: { observed: usdt('40').toString(), requested: usdt('100').toString() } });
  });
});

describe('the observed balance cannot be written by hand (IX089)', () => {
  it('accepts only the latest recorded reading, and the readings themselves are append-only', async () => {
    const hot = await runAs(w.app, registerTreasuryWallet(w.finance.actor), w.finance.ref, 'treasury.register_wallet', { network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), label: `Wallet ${randomUUID().slice(0, 6)}`, role: 'COLD' as const });
    const address = (await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', hot.walletId).executeTakeFirstOrThrow()).address;
    await expect(sql`update treasury_wallet set observed_balance_minor = 1000000000000, observed_at = now() where id = ${hot.walletId}`.execute(w.app))
      .rejects.toMatchObject({ code: 'IX089' });

    w.chain.add({ from: encodeTronAddress(randomBytes(20)), to: address, amountMinor: usdt('100') });
    await observe(w, address); // 100
    const first = await w.app.selectFrom('custody_balance_observation').select(['id', 'balance_minor']).where('address', '=', address).orderBy('observed_at', 'desc').executeTakeFirstOrThrow();
    expect(first.balance_minor).toBe(usdt('100'));
    w.chain.add({ from: address, to: encodeTronAddress(randomBytes(20)), amountMinor: usdt('100') });
    await observe(w, address); // 0
    expect((await w.app.selectFrom('treasury_wallet').select('observed_balance_minor').where('id', '=', hot.walletId).executeTakeFirstOrThrow()).observed_balance_minor).toBe(0n);

    // Winding the wallet back to the earlier, larger reading is refused: only the latest reading stands.
    await expect(sql`
      update treasury_wallet t set observed_balance_minor = o.balance_minor, observed_at = o.observed_at
        from custody_balance_observation o where o.id = ${first.id} and t.id = ${hot.walletId}`.execute(w.app)).rejects.toMatchObject({ code: 'IX089' });
    await expect(sql`delete from custody_balance_observation where id = ${first.id}`.execute(w.app)).rejects.toThrow();
    await expect(sql`update custody_balance_observation set balance_minor = 0 where id = ${first.id}`.execute(w.app)).rejects.toThrow();
  });
});

describe('a deposit address holding a trade’s money stays out of the pool (IX088)', () => {
  it('the cooldown job passes over it and releases the others', async () => {
    // A SELL deal completes when the client is paid (FI-62); its USDT is still at its deposit address, owed to the trader.
    const trade = await openTrade(w, { baseUsdt: '100', clientRate: '102.000000' });
    await settleFirstLeg(w, trade.tradeId);
    await payClient(w, trade);
    expect((await w.app.selectFrom('trade').select('lifecycle_state').where('id', '=', trade.tradeId).executeTakeFirstOrThrow()).lifecycle_state).toBe('COMPLETED');
    const held = await clientDepositAddressOf(w, trade.tradeId);

    // An address with nothing in it, cancelled before any money arrived.
    const idle = await openTrade(w, { baseUsdt: '50' });
    const idleAddress = await clientDepositAddressOf(w, idle.tradeId);
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: idle.tradeId, reason: 'client stood down before sending' });

    const statusOf = async (id: string) => (await w.app.selectFrom('deposit_address').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
    expect([await statusOf(held.id), await statusOf(idleAddress.id)]).toEqual(['COOLDOWN', 'COOLDOWN']);
    // Both cooldowns elapse (test setup: a week passes).
    await sql`update deposit_address set cooldown_until = statement_timestamp() - interval '1 minute' where id in (${held.id}, ${idleAddress.id})`.execute(w.t.owner);
    await executeCommand(w.app, { authorize: async () => {}, handle: (ctx) => releaseCooledDownAddresses(ctx) }, { name: 'deposit_address.cooldown_release', actor: SYSTEM, payload: {}, idempotencyKey: randomUUID(), financial: false });

    expect([await statusOf(held.id), await statusOf(idleAddress.id)]).toEqual(['COOLDOWN', 'AVAILABLE']);
    // Nor can anything else put it back: the database refuses (IX088).
    await expect(sql`update deposit_address set status = 'AVAILABLE', cooldown_until = null where id = ${held.id}`.execute(w.app)).rejects.toMatchObject({ code: 'IX088' });
  });
});
