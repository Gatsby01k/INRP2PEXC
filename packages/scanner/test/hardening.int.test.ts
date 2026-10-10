import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, encodeTronAddress } from '@inrp2p/kernel';
import { QuorumChainVerifier, TronHttpProvider, type TronTransferWindowQuery, type TransferWindow } from '@inrp2p/adapters';
import { FAKE_USDT_CONTRACT, FakeTronGrid, FakeTronProvider } from '@inrp2p/adapters/testing';
import { createTestOperator, runAs } from '@inrp2p/identity/testing';
import { cancelChainBackfill, providerStatus, readCursor, requestChainBackfill, runChainBackfill, runOrphanSweep, runTronScan } from '../src/index.ts';
import { type ChainWorld, createChainWorld, depositAddressOf, legsOf, openTrade, stateOf, transferByHash } from './world.ts';

/**
 * Production task A2/A3 at the scanner: the cursor moves only across what was proved read, providers fail over
 * for detection, degradation is recorded, an orphan needs every provider's word, and a historical backfill reads
 * behind the cursor without moving it.
 */
let w: ChainWorld;
beforeAll(async () => { w = await createChainWorld('scanner_hardening', { depositPoolSize: 40 }); });
afterAll(async () => w.close());

const usdt = (decimal: string) => Money.parse(decimal, 'USDT').minor;
const stranger = () => encodeTronAddress(randomBytes(20));
const sellTrade = (baseUsdt: string) => openTrade(w, { baseUsdt, clientRate: '102.000000', routeRate: '104.200000' });

/** Scanner deps that read one `FakeTronGrid` over HTTP (the documented wire formats) and verify through it. */
function httpDeps(grid: FakeTronGrid, scanner: Record<string, unknown>, opts: { pageSize?: number } = {}) {
  const provider = new TronHttpProvider({ name: 'grid', independenceGroup: 'grid-op', baseUrl: grid.baseUrl, fetchImpl: grid.fetch, retryBaseDelayMs: 0, retries: 1, ...(opts.pageSize ? { pageSize: opts.pageSize } : {}) });
  return { chain: new QuorumChainVerifier({ providers: [provider], tokenContract: FAKE_USDT_CONTRACT }), providers: [provider], scanner };
}

describe('A2 at the scanner over the documented HTTP API', () => {
  // Its own world: the chain behind these tests is a FakeTronGrid, so its transfers must not meet the other tests'
  // fake chain in one database (an orphan sweep there would rightly find them unknown).
  let g: ChainWorld;
  beforeAll(async () => { g = await createChainWorld('scanner_http', { depositPoolSize: 10 }); });
  afterAll(async () => g.close());

  it('detects one new deposit behind 200 older transfers to the same address, over the documented HTTP API', async () => {
    const trade = await openTrade(g, { baseUsdt: '25', clientRate: '102.000000', routeRate: '104.200000' });
    const address = await depositAddressOf(g, trade.tradeId);
    const grid = new FakeTronGrid({ head: 1_000n });
    // 200 old transfers to the same address, long before the window the scanner will read.
    for (let i = 0; i < 200; i++) grid.addTransfer({ from: stranger(), to: address.address, value: BigInt(i + 1), blockNumber: 1_001n + BigInt(i) });
    grid.advance(3_800n);
    const fresh = grid.addTransfer({ from: g.clientSourceAddress, to: address.address, value: usdt('25') });
    grid.advance(30n);

    const report = await runTronScan(g.app, httpDeps(grid, { scanner: 'a2_two_hundred_old', startLookbackBlocks: 100n }));
    expect(report.truncated).toBe(false);
    expect(report.detected).toBe(1);
    expect((await transferByHash(g, fresh.txHash))?.state).toBe('DETECTED');
    expect(await stateOf(g, trade.tradeId)).toBe('FIRST_LEG_DETECTED');
    expect(report.cursorAt).toBe(grid.head);
  });

  it('a page that fails mid-window stops the cursor below it; the next run reads the rest, recording nothing twice', async () => {
    const treasury = await g.app.selectFrom('treasury_wallet').select('address').where('id', '=', g.treasuryWalletId).executeTakeFirstOrThrow();
    const grid = new FakeTronGrid({ head: 5_000n });
    grid.pageCap = 50;
    const start = grid.head;
    const mined = Array.from({ length: 120 }, (_, i) => grid.addTransfer({ from: stranger(), to: treasury.address, value: BigInt(1_000 + i), blockNumber: start + 10n + BigInt(i) }));
    grid.advance(20n);
    const deps = httpDeps(grid, { scanner: 'a2_page_failure', startLookbackBlocks: 200n, rescanOverlapBlocks: 0n }, { pageSize: 50 });

    grid.faults.push({ match: 'fingerprint=', status: 503 });
    const broken = await runTronScan(g.app, deps);
    expect(broken.truncated).toBe(true);
    expect(broken.incompleteReasons.join(' ')).toMatch(/history page 2 failed/);
    // Page 1 held 50 transfers in blocks start+10 … start+59; the proof stops below the last of them.
    expect(broken.cursorAt).toBe(start + 58n);
    const cursorRow = await g.app.selectFrom('chain_cursor').select(['last_complete', 'last_incomplete_reason', 'last_served_by']).where('scanner', '=', 'a2_page_failure').executeTakeFirstOrThrow();
    expect(cursorRow).toMatchObject({ last_complete: false, last_served_by: 'grid' });
    expect(cursorRow.last_incomplete_reason).toMatch(/history page 2 failed/);

    grid.faults = [];
    const resumed = await runTronScan(g.app, deps);
    expect(resumed.truncated).toBe(false);
    expect(resumed.cursorAt).toBe(grid.head);
    for (const t of mined) expect((await transferByHash(g, t.txHash))?.state).toBe('DETECTED');
    const rows = await g.app.selectFrom('crypto_transfer').select('tx_hash').where('tx_hash', 'in', mined.map((m) => m.txHash)).execute();
    expect(rows).toHaveLength(120);
  });

});

describe('A2 at the scanner — the cursor never passes a block it did not prove read', () => {
  it('an incomplete read from every provider holds the cursor at what they proved', async () => {
    const deps = { ...w.scanDeps, scanner: { scanner: 'a2_incomplete', startLookbackBlocks: 50n, rescanOverlapBlocks: 0n } };
    await runTronScan(w.app, deps);
    const before = (await readCursor(w.app, 'a2_incomplete'))!.lastScannedBlock;
    w.tron.advance(40n);
    const cut = before + 15n;
    const a = new FakeTronProvider('cut-a', w.tron, { incompleteFrom: cut });
    const b = new FakeTronProvider('cut-b', w.tron, { incompleteFrom: cut + 5n });
    const report = await runTronScan(w.app, { ...deps, providers: [a, b] });
    expect(report.truncated).toBe(true);
    // The union of the two reads proves through the better of them, and not one block further.
    expect(report.cursorAt).toBe(cut + 4n);
  });

  it('a listing that fails on every provider leaves the cursor where it was and says why', async () => {
    const deps = { ...w.scanDeps, scanner: { scanner: 'a2_listing_down', startLookbackBlocks: 50n } };
    await runTronScan(w.app, deps);
    const before = (await readCursor(w.app, 'a2_listing_down'))!.lastScannedBlock;
    w.tron.advance(25n);
    class ListingDown extends FakeTronProvider {
      override async readIncomingTransfers(_q: TronTransferWindowQuery): Promise<TransferWindow> { throw new Error('index is rebuilding'); }
    }
    const report = await runTronScan(w.app, { ...deps, providers: [new ListingDown('down-a', w.tron), new ListingDown('down-b', w.tron)] });
    expect(report.truncated).toBe(true);
    expect(report.incompleteReasons.join(' ')).toMatch(/index is rebuilding/);
    expect((await readCursor(w.app, 'a2_listing_down'))!.lastScannedBlock).toBe(before);
  });

  it('two scanner runs at once record each deposit once and leave the cursor at the furthest proof', async () => {
    const trades = await Promise.all([sellTrade('3'), sellTrade('4')]);
    const deposits = [];
    for (const t of trades) {
      const a = await depositAddressOf(w, t.tradeId);
      deposits.push(w.tron.add({ to: a.address, from: w.clientSourceAddress, amountMinor: a.expectedMinor! }));
    }
    w.tron.solidifyAll();
    const deps = { ...w.scanDeps, scanner: { scanner: 'a2_concurrent', startLookbackBlocks: 300n } };
    const outcomes = await Promise.allSettled([runTronScan(w.app, deps), runTronScan(w.app, deps)]);
    // A run that lost a race on the same chain event may fail and be retried by the worker; it can never double-count.
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    for (const o of outcomes) if (o.status === 'rejected') expect(String(o.reason)).toMatch(/IDEMPOTENCY|could not serialize|deadlock|duplicate/i);
    await runTronScan(w.app, deps);
    for (const [i, d] of deposits.entries()) {
      const rows = await w.app.selectFrom('crypto_transfer').select('id').where('tx_hash', '=', d.txHash).execute();
      expect(rows).toHaveLength(1);
      expect(await legsOf(w, trades[i]!.tradeId)).toHaveLength(1);
    }
  });
});

describe('A3 — failover, degradation and the orphan rule', () => {
  it('fails over to the next provider for detection and records the failing one as degraded', async () => {
    const trade = await sellTrade('6');
    const address = await depositAddressOf(w, trade.tradeId);
    const t = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('6') });
    w.tron.solidifyAll();
    const down = new FakeTronProvider('primary-down', w.tron, { failWith: new Error('ECONNREFUSED primary') });
    const report = await runTronScan(w.app, { ...w.scanDeps, providers: [down, w.secondary], scanner: { scanner: 'a3_failover', startLookbackBlocks: 300n } });
    expect(report.servedBy).toBe(w.secondary.name);
    expect(report.providersDown).toEqual(['primary-down']);
    expect((await transferByHash(w, t.txHash))?.state).toBe('DETECTED');
    const status = await providerStatus(w.app);
    expect(status.find((s) => s.provider === 'primary-down')).toMatchObject({ health: 'DEGRADED', consecutiveFailures: 1 });
    expect(status.find((s) => s.provider === w.secondary.name)).toMatchObject({ health: 'OK' });
    expect(status.find((s) => s.provider === 'primary-down')!.lastError).toMatch(/ECONNREFUSED/);
  });

  it('never orphans a transfer while any provider is unavailable — absence needs every provider', async () => {
    const trade = await sellTrade('7');
    const address = await depositAddressOf(w, trade.tradeId);
    const doomed = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('7') });
    await runTronScan(w.app, w.scanDeps);
    w.tron.orphan(doomed.txHash, doomed.logIndex);
    w.secondary.failWith = new Error('secondary unreachable');
    try {
      const swept = await runOrphanSweep(w.app, { ...w.scanDeps, scanner: { orphanAfterMinutes: 0 } });
      expect(swept.orphaned).toBe(0);
      expect((await transferByHash(w, doomed.txHash))?.state).toBe('DETECTED');
    } finally {
      w.secondary.failWith = undefined;
    }
    const swept = await runOrphanSweep(w.app, { ...w.scanDeps, scanner: { orphanAfterMinutes: 0 } });
    expect(swept.orphaned).toBeGreaterThanOrEqual(1);
    expect((await transferByHash(w, doomed.txHash))?.state).toBe('ORPHANED');
  });
});

describe('TD-06 — audited historical backfill', () => {
  it('reads a range behind the cursor for one exchange address, detects what it missed, never moves the cursor', async () => {
    const trade = await sellTrade('8');
    const address = await depositAddressOf(w, trade.tradeId);
    const deps = { ...w.scanDeps, scanner: { scanner: 'tron_deposits', backfillBlocksPerRun: 40n } };
    // The deposit sits far below the cursor and its overlap: the live scanner will never read that block again.
    await runTronScan(w.app, deps);
    const cursor = (await readCursor(w.app, 'tron_deposits'))!;
    const block = cursor.lastScannedBlock - 600n;
    const missed = w.tron.add({ to: address.address, from: w.clientSourceAddress, amountMinor: usdt('8'), blockNumber: block });
    w.tron.solidifyAll();
    await runTronScan(w.app, deps);
    expect(await transferByHash(w, missed.txHash)).toBeUndefined();

    const finance = await createTestOperator(w.t.owner, ['FINANCE']);
    const requested = await runAs(w.app, requestChainBackfill(finance.actor), finance.ref, 'chain.backfill_request', {
      fromBlock: (block - 50n).toString(), toBlock: (block + 50n).toString(), addresses: [address.address], reason: 'deposit address watched after the funds arrived',
    });
    let report = await runChainBackfill(w.app, deps);
    let runs = 1;
    while (report && report.status === 'RUNNING' && runs < 10) {
      report = await runChainBackfill(w.app, deps);
      runs += 1;
    }
    expect(report?.status).toBe('COMPLETED');
    expect(runs).toBeGreaterThan(1);
    expect((await transferByHash(w, missed.txHash))?.state).toBe('DETECTED');
    expect(await stateOf(w, trade.tradeId)).toBe('FIRST_LEG_DETECTED');
    const row = await w.app.selectFrom('chain_backfill').selectAll().where('id', '=', requested.backfillId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'COMPLETED', detected: 1 });
    expect(row.next_block).toBe(block + 51n);
    expect((await readCursor(w.app, 'tron_deposits'))!.lastScannedBlock).toBeGreaterThanOrEqual(cursor.lastScannedBlock);
    const audit = await w.app.selectFrom('audit_event').select('action').where('entity_id', '=', requested.backfillId).orderBy('seq').execute();
    expect(audit.map((a) => a.action)).toContain('chain.backfill_requested');
    expect(audit.map((a) => a.action)).toContain('chain.backfill_completed');

    // A second pass over the same range records nothing twice.
    const again = await runAs(w.app, requestChainBackfill(finance.actor), finance.ref, 'chain.backfill_request', {
      fromBlock: (block - 5n).toString(), toBlock: (block + 5n).toString(), addresses: [address.address], reason: 'second pass over the same range',
    });
    const second = await runChainBackfill(w.app, deps);
    expect(second).toMatchObject({ detected: 0, alreadyKnown: 1, status: 'COMPLETED' });
    expect(again.ref).toMatch(/^BF-/);
    expect(await legsOf(w, trade.tradeId)).toHaveLength(1);
  });

  it('is step-up, limited to roles that configure custody, and refuses the live edge, strangers and a second run', async () => {
    const treasury = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const payload = { fromBlock: '1', toBlock: '10', addresses: [treasury.address], reason: 'import of an old range for review' };
    await expect(runAs(w.app, requestChainBackfill(w.settlementOp.actor), w.settlementOp.ref, 'chain.backfill_request', payload)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stale = await createTestOperator(w.t.owner, ['FINANCE'], 'stale');
    await expect(runAs(w.app, requestChainBackfill(stale.actor), stale.ref, 'chain.backfill_request', payload)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const finance = await createTestOperator(w.t.owner, ['FINANCE']);
    const solidified = (await w.app.selectFrom('chain_cursor').select('last_solidified_block').where('scanner', '=', 'tron_deposits').executeTakeFirstOrThrow()).last_solidified_block;
    await expect(runAs(w.app, requestChainBackfill(finance.actor), finance.ref, 'chain.backfill_request', { ...payload, toBlock: (solidified + 1n).toString() }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runAs(w.app, requestChainBackfill(finance.actor), finance.ref, 'chain.backfill_request', { ...payload, addresses: [stranger()] }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(runAs(w.app, requestChainBackfill(finance.actor), finance.ref, 'chain.backfill_request', { ...payload, toBlock: '3000000' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const first = await runAs(w.app, requestChainBackfill(finance.actor), finance.ref, 'chain.backfill_request', payload);
    await expect(runAs(w.app, requestChainBackfill(finance.actor), finance.ref, 'chain.backfill_request', payload)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await runAs(w.app, cancelChainBackfill(finance.actor), finance.ref, 'chain.backfill_cancel', { backfillId: first.backfillId, reason: 'not needed after all' });
    expect((await w.app.selectFrom('chain_backfill').select('status').where('id', '=', first.backfillId).executeTakeFirstOrThrow()).status).toBe('CANCELLED');
  });
});
