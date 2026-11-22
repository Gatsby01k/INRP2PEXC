import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Db } from '@inrp2p/db';
import { latestObservation } from '@inrp2p/treasury';
import { QUIET_WALLET_REFRESH_SECONDS, addressesDueForObservation, addressesToObserve, observeBalances, providerStatus, runTronConfirm, runTronScan } from '../src/index.ts';
import { type ChainWorld, createChainWorld, openTrade, settleFirstLeg } from './world.ts';

/**
 * The scheduled observation (`custody_observe`) reads deal addresses every run and quiet treasury wallets once their
 * reading is due; every source's answer is recorded for the desk; and a reading is never paid for with an
 * idempotency key nobody can present again.
 */
let w: ChainWorld;
let clock: { readonly db: Db; set(at: Date | null): Promise<void> };
let wallets: string[];
let now: Date;

beforeAll(async () => {
  w = await createChainWorld('observation_cadence');
  clock = await w.t.pinnedClock();
  wallets = (await w.app.selectFrom('treasury_wallet').select('address').where('network', '=', 'TRON').where('status', '=', 'ACTIVE').execute()).map((r) => r.address).sort();
  now = new Date(Date.now() + 60_000);
  await clock.set(now);
});
afterAll(async () => w.close());

const scheduled = () => observeBalances(clock.db, { sources: w.scanDeps.providers, contract: w.scanDeps.chain.tokenContract });
const at = async (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
  await clock.set(now);
};
const statusOf = async (name: string) => (await providerStatus(w.app)).find((p) => p.provider === name);

describe('custody_observe cadence', () => {
  it('reads every treasury wallet with no reading yet, then leaves the quiet ones until their reading is due', async () => {
    expect((await addressesDueForObservation(clock.db)).due).toEqual(wallets);
    const first = await scheduled();
    expect(first).toMatchObject({ observed: wallets.length, notDue: 0, usable: wallets.length });

    await at(60);
    const quiet = await scheduled();
    expect(quiet).toMatchObject({ observed: 0, notDue: wallets.length });

    await at(QUIET_WALLET_REFRESH_SECONDS - 60);
    const due = await scheduled();
    expect(due).toMatchObject({ observed: wallets.length, notDue: 0 });
    // The reading a quiet wallet carries is never older than the refresh plus one minute — well inside the 300 s a
    // payout may rely on (DEFAULT_SETTLEMENT_POLICY.maxObservationAgeSeconds).
    for (const a of wallets) expect((await latestObservation(clock.db, a))!.ageSeconds).toBe(0);
    expect(QUIET_WALLET_REFRESH_SECONDS + 60).toBeLessThan(300);
  });

  it('reads a wallet again on the next run while its latest reading is unusable', async () => {
    const hot = wallets[0]!;
    w.secondary.balanceSkew = 1n;
    try {
      await observeBalances(clock.db, { sources: w.scanDeps.providers, contract: w.scanDeps.chain.tokenContract }, { addresses: [hot] });
    } finally {
      w.secondary.balanceSkew = 0n;
    }
    expect((await latestObservation(clock.db, hot))!.quality).toBe('DISAGREED');
    await at(30);
    expect((await addressesDueForObservation(clock.db)).due).toEqual([hot]);
    await scheduled();
    expect((await latestObservation(clock.db, hot))!.quality).toBe('AGREED');
  });

  it('reads the deposit addresses that hold a trade’s money on every run', async () => {
    const trade = await openTrade(w, { baseUsdt: '25', clientRate: '102.000000' });
    await settleFirstLeg(w, trade.tradeId);
    const deal = (await addressesToObserve(w.app)).filter((a) => !wallets.includes(a));
    expect(deal.length).toBeGreaterThan(0);
    for (let run = 0; run < 3; run++) {
      await at(20);
      const plan = await addressesDueForObservation(clock.db);
      for (const a of deal) expect(plan.due).toContain(a);
      await scheduled();
    }
  });
});

describe('what each source answered, for the desk', () => {
  it('records a second source that fails balance reads, with its reason, and clears it when it answers again', async () => {
    await at(QUIET_WALLET_REFRESH_SECONDS + 1);
    w.secondary.failWith = new Error('HTTP 429 from the second provider: monthly request quota exhausted');
    try {
      const out = await scheduled();
      expect(out.observed).toBeGreaterThan(0);
    } finally {
      w.secondary.failWith = undefined;
    }
    expect(await statusOf('fake-node-b')).toMatchObject({ health: 'DEGRADED', consecutiveFailures: 1, lastError: expect.stringContaining('quota exhausted') });
    expect((await statusOf('fake-node-a'))?.health).toBe('OK');
    for (const a of wallets) expect((await latestObservation(clock.db, a))!.quality).toBe('SINGLE_SOURCE');

    await at(QUIET_WALLET_REFRESH_SECONDS + 1);
    await scheduled();
    expect(await statusOf('fake-node-b')).toMatchObject({ health: 'OK', consecutiveFailures: 0 });
    for (const a of wallets) expect((await latestObservation(clock.db, a))!.quality).toBe('AGREED');
  });

  it('the signer’s own reading before a send leaves the record to the schedule (one write fewer on the payout path)', async () => {
    const before = await w.app.selectFrom('chain_provider_status').select(['provider', 'updated_at']).execute();
    w.secondary.failWith = new Error('down');
    try {
      await at(5);
      await observeBalances(clock.db, { sources: w.scanDeps.providers, contract: w.scanDeps.chain.tokenContract }, { addresses: [wallets[0]!] });
    } finally {
      w.secondary.failWith = undefined;
    }
    expect(await w.app.selectFrom('chain_provider_status').select(['provider', 'updated_at']).execute()).toEqual(before);
  });

  it('records each provider’s part in a verification (tron_confirm)', async () => {
    const trade = await openTrade(w, { baseUsdt: '25', clientRate: '102.000000', direction: 'SELL_USDT' });
    const address = (await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select('d.address').where('a.trade_id', '=', trade.tradeId).executeTakeFirstOrThrow()).address;
    w.tron.add({ to: address, amountMinor: 25_000_000n });
    w.tron.solidifyAll();
    await runTronScan(w.app, w.scanDeps);
    await sql`update chain_provider_status set consecutive_failures = 0, last_error = null`.execute(w.t.owner);
    w.secondary.failWith = new Error('HTTP 503 from the second provider');
    try {
      const out = await runTronConfirm(w.app, w.scanDeps);
      expect(out.examined).toBeGreaterThan(0);
    } finally {
      w.secondary.failWith = undefined;
    }
    expect(await statusOf('fake-node-b')).toMatchObject({ health: 'DEGRADED', lastError: expect.stringContaining('verification') });
    expect((await statusOf('fake-node-a'))?.health).toBe('OK');
  });
});

describe('what a reading writes', () => {
  it('one observation and one audit event per reading, and no idempotency key nobody could present again', async () => {
    await at(QUIET_WALLET_REFRESH_SECONDS + 1);
    const count = async (q: string) => Number((await sql<{ n: string }>`select count(*)::text as n from ${sql.raw(q)}`.execute(w.t.owner)).rows[0]!.n);
    const keys = await count(`idempotency_key where scope = 'custody.observe_balance'`);
    const audits = await count(`audit_event where action = 'custody.balance_observed'`);
    const readings = await count('custody_balance_observation');
    const out = await scheduled();
    expect(out.observed).toBeGreaterThan(0);
    expect(await count(`idempotency_key where scope = 'custody.observe_balance'`)).toBe(keys);
    expect(await count(`audit_event where action = 'custody.balance_observed'`)).toBe(audits + out.observed);
    expect(await count('custody_balance_observation')).toBe(readings + out.observed);
  });
});
