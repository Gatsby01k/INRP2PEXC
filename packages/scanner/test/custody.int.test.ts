import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UnconfiguredChainVerifier } from '@inrp2p/adapters';
import { fakeTronAddress } from '@inrp2p/adapters/testing';
import { runAs } from '@inrp2p/identity/testing';
import { latestObservation } from '@inrp2p/treasury';
import { addressesToObserve, observeBalances, readRequestedBalance, recordRequestedBalance } from '../src/index.ts';
import { type ChainWorld, createChainWorld, openTrade, settleFirstLeg } from './world.ts';

/** B2: what each exchange address holds, read by the worker every minute and by the desk on request. */
let w: ChainWorld;
let hot: { id: string; address: string };
beforeAll(async () => {
  w = await createChainWorld('custody_observe');
  hot = await w.app.selectFrom('treasury_wallet').select(['id', 'address']).where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
});
afterAll(async () => w.close());

const observeNow = (addresses?: readonly string[]) =>
  observeBalances(w.app, { sources: w.scanDeps.providers, contract: w.scanDeps.chain.tokenContract }, addresses ? { addresses } : {});

describe('custody_observe', () => {
  it('reads each ACTIVE treasury wallet through every provider and keeps the wallet’s observed balance in step', async () => {
    w.tron.add({ to: hot.address, amountMinor: 1_000_000n });
    w.tron.solidifyAll();
    const report = await observeNow();
    expect(report.unusable).toEqual([]);
    expect(await latestObservation(w.app, hot.address)).toMatchObject({ quality: 'AGREED', balanceMinor: 1_000_000n, independentSources: 2, providers: 'fake-node-a,fake-node-b' });
    const wallet = await w.app.selectFrom('treasury_wallet').select('observed_balance_minor').where('id', '=', hot.id).executeTakeFirstOrThrow();
    expect(wallet.observed_balance_minor).toBe(1_000_000n);
    const audit = await w.app.selectFrom('audit_event').select('action').where('entity_id', '=', hot.id).where('action', '=', 'custody.balance_observed').execute();
    expect(audit.length).toBeGreaterThan(0);
  });

  it('a provider that reports another balance makes the reading unusable; one that is down leaves a single source', async () => {
    w.secondary.balanceSkew = 1n;
    try {
      const report = await observeNow([hot.address]);
      expect(report.unusable).toEqual([expect.objectContaining({ address: hot.address, quality: 'DISAGREED' })]);
      expect(await latestObservation(w.app, hot.address)).toMatchObject({ quality: 'DISAGREED', balanceMinor: null });
      // An unusable reading never overwrites the wallet's last observed number — and never stands in for it either:
      // the payout gate reads the latest reading, which is this one.
      expect((await w.app.selectFrom('treasury_wallet').select('observed_balance_minor').where('id', '=', hot.id).executeTakeFirstOrThrow()).observed_balance_minor).toBe(1_000_000n);
    } finally {
      w.secondary.balanceSkew = 0n;
    }
    w.secondary.failWith = new Error('HTTP 503 from the second provider');
    try {
      await observeNow([hot.address]);
      expect(await latestObservation(w.app, hot.address)).toMatchObject({ quality: 'SINGLE_SOURCE', balanceMinor: 1_000_000n, independentSources: 1, providers: 'fake-node-a' });
    } finally {
      w.secondary.failWith = undefined;
    }
  });

  it('reads the deposit addresses that hold a trade’s money, and not the idle ones', async () => {
    const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '25', clientRate: '102.000000', routeRate: '104.200000' });
    const idle = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '25', clientRate: '102.000000' });
    const deposit = async (tradeId: string) => (await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', tradeId).executeTakeFirstOrThrow()).address;
    expect(await addressesToObserve(w.app)).not.toContain(await deposit(trade.tradeId));
    await settleFirstLeg(w, trade.tradeId);
    const watched = await addressesToObserve(w.app);
    expect(watched).toContain(await deposit(trade.tradeId));
    expect(watched).not.toContain(await deposit(idle.tradeId));
    expect(watched).toContain(hot.address);
  });
});

describe('the desk’s refresh (custody:refresh_balance)', () => {
  it('records a reading of an exchange address as the operator who asked', async () => {
    const reading = await readRequestedBalance(w.scanDeps.chain, hot.address);
    const out = await runAs(w.app, recordRequestedBalance(w.settlementOp.actor, reading), w.settlementOp.ref, 'custody.refresh_balance', { address: hot.address });
    expect(out).toMatchObject({ address: hot.address, quality: 'AGREED', balance: '1.000000' });
    const row = await w.app.selectFrom('custody_balance_observation').select('observed_by').where('id', '=', out.observationId).executeTakeFirstOrThrow();
    expect(row.observed_by).toBe(w.settlementOp.ref.id);
  });

  it('is refused to a role without the permission, for a reading of another address, and for an address that is not ours', async () => {
    const reading = await readRequestedBalance(w.scanDeps.chain, hot.address);
    await expect(runAs(w.app, recordRequestedBalance(w.dealer.actor, reading), w.dealer.ref, 'custody.refresh_balance', { address: hot.address }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The balance comes from the providers the server asked, never from the request: a reading cannot be filed
    // under a different address.
    const other = await w.app.selectFrom('deposit_address').select('address').executeTakeFirstOrThrow();
    await expect(runAs(w.app, recordRequestedBalance(w.settlementOp.actor, reading), w.settlementOp.ref, 'custody.refresh_balance', { address: other.address }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const foreign = fakeTronAddress('not-an-exchange-address');
    const foreignReading = await readRequestedBalance(w.scanDeps.chain, foreign);
    await expect(runAs(w.app, recordRequestedBalance(w.settlementOp.actor, foreignReading), w.settlementOp.ref, 'custody.refresh_balance', { address: foreign }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await latestObservation(w.app, foreign)).toBeNull();
  });

  it('makes nothing up when no provider is configured', async () => {
    await expect(readRequestedBalance(new UnconfiguredChainVerifier(), hot.address)).rejects.toMatchObject({ code: 'CHAIN_MONITORING_UNCONFIGURED' });
  });
});
