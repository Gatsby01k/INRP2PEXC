import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { cancelTrade } from '@inrp2p/settlement';
import { runOrphanSweep, runTronConfirm, runTronScan } from '../src/index.ts';
import { type ChainWorld, createChainWorld, depositAddressOf, entriesOf, legsOf, openCases, openTrade, stateOf, transferByHash } from './world.ts';

/** Regressions found by the end-to-end audit (2026-09-25): money the chain moved must never go unrecorded. */
let w: ChainWorld;
beforeAll(async () => { w = await createChainWorld('scanner_audit', { depositPoolSize: 20 }); });
afterAll(async () => w.close());

const usdt = (decimal: string) => Money.parse(decimal, 'USDT').minor;
const sellTrade = (baseUsdt: string) => openTrade(w, { baseUsdt, clientRate: '102.000000', routeRate: '104.200000' });

describe('deposits that outlive their trade are parked, not lost (T9)', () => {
  it('a deposit detected before the trade was cancelled confirms into suspense with a case', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    const sent = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    await runTronScan(w.app, w.scanDeps);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');
    await runAs(w.app, cancelTrade(w.dealer.actor), w.dealer.ref, 'trade.cancel', { tradeId: trade.tradeId, reason: 'client asked to cancel while the deposit was pending' });

    w.tron.solidifyAll();
    await runTronConfirm(w.app, w.scanDeps);
    const row = (await transferByHash(w, sent.txHash))!;
    expect(row.state).toBe('CONFIRMED');
    expect(await entriesOf(w, `crypto:${row.id}:confirm`)).toEqual([
      expect.stringMatching(/^ASSET:TREASURY_USDT:.* DR 10000000$/),
      'SUSPENSE:UNALLOCATED CR 10000000',
    ]);
    expect(await openCases(w, row.id)).toEqual(['FUNDS_AFTER_TRADE_CLOSED']);
  });

  it('a second deposit after the first leg was confirmed is recorded as an overpayment, and confirms with its journal', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    await runTronConfirm(w.app, w.scanDeps);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_CONFIRMED');

    const again = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    const row = (await transferByHash(w, again.txHash))!;
    expect(await openCases(w, row.id)).toEqual(['USDT_OVERPAYMENT']);

    const report = await runTronConfirm(w.app, w.scanDeps);
    expect(report.clientLegsConfirmed).toBeGreaterThanOrEqual(1);
    expect((await transferByHash(w, again.txHash))!.state).toBe('CONFIRMED');
    expect(await entriesOf(w, `crypto:${row.id}:confirm`)).toHaveLength(2);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_CONFIRMED');
    expect((await legsOf(w, trade.tradeId)).map((l) => l.status)).toEqual(['COMPLETED', 'COMPLETED']);
  });
});

describe('every watched address is read on every run (FI-26)', () => {
  it('a deposit to an address older than hundreds of newer ones is still detected', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    const pool = await w.app.selectFrom('deposit_address').select(['treasury_wallet_id', 'provider']).where('id', '=', address.addressId).executeTakeFirstOrThrow();
    // More recently touched addresses than one run used to read: before the fix, the oldest assigned address fell
    // off the end of the list while the cursor still moved past its blocks.
    const crowd = Array.from({ length: 205 }, (_, i) => ({
      treasury_wallet_id: pool.treasury_wallet_id, network: 'TRON' as const, address: encodeTronAddress(randomBytes(20)), source: 'POOL' as const,
      provider: pool.provider, custody_reference: `audit-crowd-${i}-${randomBytes(4).toString('hex')}`, status: 'AVAILABLE' as const, created_by: 'test',
    }));
    await w.t.owner.insertInto('deposit_address').values(crowd).execute();
    // Cooled-down addresses are what piles up in a busy week (seven days of cooldown per trade), and they are
    // watched too. The database only lets an address reach COOLDOWN through ASSIGNED.
    await w.t.owner.transaction().execute(async (tx) => {
      await sql`update deposit_address set status = 'ASSIGNED' where custody_reference like 'audit-crowd-%'`.execute(tx);
      await sql`update deposit_address set status = 'COOLDOWN', cooldown_until = statement_timestamp() + interval '7 days',
                updated_at = statement_timestamp() + interval '1 hour' where custody_reference like 'audit-crowd-%'`.execute(tx);
    });

    const sent = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('10') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    expect(await transferByHash(w, sent.txHash)).toBeDefined();
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');
  });
});

describe('a failed top-up does not undo the part that arrived (T3)', () => {
  it('an orphaned second transfer leaves the trade holding the first one', async () => {
    const trade = await sellTrade('10');
    const address = await depositAddressOf(w, trade.tradeId);
    w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('9') });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    await runTronConfirm(w.app, w.scanDeps);
    const topUp = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('1') });
    await runTronScan(w.app, w.scanDeps);

    w.tron.orphan(topUp.txHash);
    const swept = await runOrphanSweep(w.app, { ...w.scanDeps, scanner: { orphanAfterMinutes: 0 } });
    expect(swept.legsReverted).toBe(1);
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');
    expect((await legsOf(w, trade.tradeId)).map((l) => l.status)).toEqual(['COMPLETED', 'FAILED']);
  });
});
