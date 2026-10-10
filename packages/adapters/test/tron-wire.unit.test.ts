import { describe, expect, it } from 'vitest';
import { isDomainError } from '@inrp2p/kernel';
import { type TransferWindow, TronHttpProvider, parseTransactionInfo } from '../src/index.ts';
import { FAKE_USDT_CONTRACT, FakeTronGrid, fakeTronAddress, otherLog, transferLog } from '../src/testing/index.ts';

/**
 * A1/A2 regressions against the documented TRON wire formats, served by `FakeTronGrid` over HTTP:
 * a receipt log's `address` is 20-byte hex without the `41` prefix, the account TRC20 history carries no block
 * number and no event index, and the history pages at most 200 rows behind an opaque fingerprint.
 *
 * Before the fix (d0cc778): the receipt test failed with INVALID_ADDRESS ("invalid log contract"), the history test
 * with "unusable block number", the multi-log test reported log 0 instead of 2, and "200 old + 1 new" returned no
 * transfer after a single HTTP request (docs/PRODUCTION_HARDENING.md A1/A2).
 */
const watched = fakeTronAddress('deposit-a1');
const sender = fakeTronAddress('client-a1');
const USDT = FAKE_USDT_CONTRACT;

const providerOn = (grid: FakeTronGrid, opts: Partial<ConstructorParameters<typeof TronHttpProvider>[0]> = {}) =>
  new TronHttpProvider({ name: 'grid', independenceGroup: 'grid-operator', baseUrl: grid.baseUrl, fetchImpl: grid.fetch, retryBaseDelayMs: 0, ...opts });

const read = (p: TronHttpProvider, since: bigint, until: bigint): Promise<TransferWindow> =>
  p.readIncomingTransfers({ address: watched, contract: USDT, sinceBlock: since, untilBlock: until });

const historyCalls = (grid: FakeTronGrid) => grid.requests.filter((r) => r.includes('/transactions/trc20')).length;

describe('A1 — receipts and history in the documented shapes', () => {
  it('reads a standard receipt whose log address is hex without the 41 prefix', async () => {
    const grid = new FakeTronGrid();
    const tx = grid.addTransfer({ from: sender, to: watched, value: 1_000_000n });
    const t = await providerOn(grid).getTransfer(tx.txHash, 0);
    expect(t).toEqual({ status: 'FOUND', transfer: expect.objectContaining({ tokenContract: USDT, fromAddress: sender, toAddress: watched, amountMinor: 1_000_000n, blockNumber: tx.blockNumber, receiptStatus: 'SUCCESS', logIndex: 0 }) });
  });

  it('decodes the TRON documentation example log exactly', () => {
    // developers.tron.network/docs/event — USDT (TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t) moving 3,000,000,000.
    const txHash = 'ab'.repeat(32);
    const evidence = parseTransactionInfo({
      id: txHash, blockNumber: 52_000_000, blockTimeStamp: 1_690_000_000_000, receipt: { result: 'SUCCESS' },
      log: [{
        address: 'a614f803b6fd780986a42c78ec9c7f77e6ded13c',
        topics: [
          'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // secret-scan:allow — documented example
          '00000000000000000000000079309abcff2cf531070ca9222a1f72c4a5136874', // secret-scan:allow — documented example
          '00000000000000000000000081b64b1c09d448d25c9eeb3ee3b8f3348a694c96', // secret-scan:allow — documented example
        ],
        data: '00000000000000000000000000000000000000000000000000000000b2d05e00', // secret-scan:allow — documented example
      }],
    }, txHash);
    expect(evidence.status).toBe('FOUND');
    if (evidence.status !== 'FOUND') return;
    const log = evidence.logs[0]!;
    expect(log.kind).toBe('TRANSFER');
    if (log.kind !== 'TRANSFER') return;
    expect(log.transfer.tokenContract).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(log.transfer.amountMinor).toBe(3_000_000_000n);
    expect(log.transfer.fromAddress).toMatch(/^T/);
    expect(log.transfer.toAddress).toMatch(/^T/);
  });

  it('reads the account history, which has no block number, from the receipts', async () => {
    const grid = new FakeTronGrid();
    const tx = grid.addTransfer({ from: sender, to: watched, value: 5_000_000n });
    grid.solidifyAll();
    const w = await read(providerOn(grid), 0n, grid.head);
    expect(w).toMatchObject({ complete: true, completeThrough: grid.head });
    expect(w.transfers).toHaveLength(1);
    expect(w.transfers[0]).toMatchObject({ txHash: tx.txHash, logIndex: 0, blockNumber: tx.blockNumber, amountMinor: 5_000_000n, receiptStatus: 'SUCCESS' });
  });

  it('identifies the actual Transfer log of a transaction that has several, never log 0 by default', async () => {
    const grid = new FakeTronGrid();
    grid.historyIncludesBlock = true; // even with a block field, the history never says which log
    const tx = grid.addTx({
      logs: [
        otherLog(),
        transferLog({ from: sender, to: fakeTronAddress('someone-else'), value: 3n }),
        transferLog({ from: sender, to: watched, value: 9_000_000n }),
      ],
    });
    const w = await read(providerOn(grid), 0n, grid.head);
    expect(w.transfers).toHaveLength(1);
    expect(w.transfers[0]).toMatchObject({ txHash: tx.txHash, logIndex: 2, amountMinor: 9_000_000n });
  });

  it('reports every transfer into the address when one transaction makes several, identical ones included', async () => {
    const grid = new FakeTronGrid();
    const tx = grid.addTx({
      logs: [
        transferLog({ from: sender, to: watched, value: 4_000_000n }),
        otherLog(),
        transferLog({ from: sender, to: watched, value: 4_000_000n }),
        transferLog({ contract: fakeTronAddress('other-token'), from: sender, to: watched, value: 1n }),
      ],
    });
    const w = await read(providerOn(grid), 0n, grid.head);
    expect(w.complete).toBe(true);
    expect(w.transfers.map((t) => [t.txHash, t.logIndex, t.amountMinor])).toEqual([[tx.txHash, 0, 4_000_000n], [tx.txHash, 2, 4_000_000n]]);
  });

  it('never reports a receipt that omits its result as a failed transfer', async () => {
    const grid = new FakeTronGrid();
    const tx = grid.addTransfer({ from: sender, to: watched, value: 2_000_000n });
    grid.receiptResultOmitted.add(tx.txHash);
    await expect(providerOn(grid).getTransfer(tx.txHash, 0)).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_EVIDENCE_INVALID'));
    // …and in a window it is a gap in the evidence, not "no transfer".
    const w = await read(providerOn(grid), 0n, grid.head);
    expect(w).toMatchObject({ complete: false, transfers: [] });
    expect(w.completeThrough).toBe(-1n);
  });

  it('reports a reverted transaction as TX_FAILED, and an unknown one as NOT_FOUND', async () => {
    const grid = new FakeTronGrid();
    const reverted = grid.addTransfer({ from: sender, to: watched, value: 2n, result: 'REVERT' });
    const p = providerOn(grid);
    expect(await p.getTransfer(reverted.txHash, 0)).toMatchObject({ status: 'TX_FAILED', result: 'REVERT', blockNumber: reverted.blockNumber });
    expect(await p.getTransfer('cd'.repeat(32), 0)).toEqual({ status: 'NOT_FOUND' });
  });

  it('refuses a receipt that answers for another transaction, or a log that is not a Transfer', async () => {
    const grid = new FakeTronGrid();
    const tx = grid.addTx({ logs: [otherLog(), transferLog({ from: sender, to: watched, value: 1n })] });
    const p = providerOn(grid);
    await expect(p.getTransfer(tx.txHash, 0)).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_EVIDENCE_INVALID'));
    await expect(p.getTransfer(tx.txHash, 7)).rejects.toSatisfy((e) => isDomainError(e, 'CHAIN_EVIDENCE_INVALID'));
    expect(() => parseTransactionInfo({ id: 'ef'.repeat(32), blockNumber: 1, blockTimeStamp: 1, receipt: { result: 'SUCCESS' } }, 'ab'.repeat(32)))
      .toThrow(expect.objectContaining({ code: 'CHAIN_EVIDENCE_INVALID' }));
  });

  it('marks a Transfer-signature log that does not decode as malformed, and steps over a TRC721 Transfer', () => {
    const txHash = 'ab'.repeat(32);
    const ev = parseTransactionInfo({
      id: txHash, blockNumber: 9, blockTimeStamp: 9, receipt: { result: 'SUCCESS' },
      log: [
        { ...transferLog({ from: sender, to: watched, value: 1n }), data: '00' },
        { ...transferLog({ from: sender, to: watched, value: 1n }), topics: [...transferLog({ from: sender, to: watched, value: 1n }).topics, '0'.repeat(63) + '1'], data: '' },
        { ...transferLog({ from: sender, to: watched, value: 1n }), topics: [transferLog({ from: sender, to: watched, value: 1n }).topics[0]!, `${'f'.repeat(24)}${'1'.repeat(40)}`, `${'0'.repeat(24)}${'2'.repeat(40)}`] },
      ],
    }, txHash);
    if (ev.status !== 'FOUND') throw new Error('expected FOUND');
    expect(ev.logs.map((l) => l.kind)).toEqual(['MALFORMED', 'OTHER', 'MALFORMED']);
  });
});

describe('A2 — the whole window is read, page by page, and the read says how far it is proven', () => {
  it('finds one new transfer behind 200 older ones', async () => {
    const grid = new FakeTronGrid({ head: 100n });
    grid.historyIncludesBlock = true; // the legacy shape the old code relied on
    for (let i = 0; i < 200; i++) grid.addTransfer({ from: sender, to: watched, value: BigInt(i + 1), blockNumber: 101n + BigInt(i) });
    const fresh = grid.addTransfer({ from: sender, to: watched, value: 777_000_000n, blockNumber: 900n });
    grid.advance(60n);
    const w = await read(providerOn(grid), 800n, 950n);
    expect(w.transfers.map((r) => r.txHash)).toEqual([fresh.txHash]);
    expect(w).toMatchObject({ complete: true, completeThrough: 950n });
    // The window is asked for by time, so the 200 old transfers are not even fetched.
    expect(grid.requests.some((r) => r.includes('min_timestamp='))).toBe(true);
  });

  it.each([0, 1, 199, 200, 201, 450])('reads all %i transfers of a window', async (n) => {
    const grid = new FakeTronGrid({ head: 10n });
    for (let i = 0; i < n; i++) grid.addTransfer({ from: sender, to: watched, value: BigInt(i + 1), blockNumber: 20n + BigInt(Math.floor(i / 3)) });
    grid.advance(5n);
    const w = await read(providerOn(grid), 11n, grid.head);
    expect(w.complete).toBe(true);
    expect(w.transfers).toHaveLength(n);
    expect(new Set(w.transfers.map((t) => `${t.txHash}:${t.logIndex}`)).size).toBe(n);
    expect(w.pages).toBe(Math.max(1, Math.ceil(n / 200) + (n > 0 && n % 200 === 0 ? 1 : 0)));
  });

  it('reads past a full page that carries no continuation token, via the last timestamp', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    grid.fingerprintOnFullPage = false;
    grid.pageCap = 50;
    for (let i = 0; i < 120; i++) grid.addTransfer({ from: sender, to: watched, value: BigInt(i + 1), blockNumber: 20n + BigInt(i) });
    // Also drop the fingerprint when more follows: an index that never paginates by token.
    const rawFetch = grid.fetch;
    const stripped = (async (input: unknown, init?: RequestInit) => {
      const res = await rawFetch(input as string, init);
      if (!String(input).includes('/transactions/trc20')) return res;
      const body = (await res.json()) as { meta?: Record<string, unknown> };
      delete body.meta?.fingerprint;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const w = await providerOn(grid, { fetchImpl: stripped, pageSize: 50 }).readIncomingTransfers({ address: watched, contract: USDT, sinceBlock: 11n, untilBlock: grid.head });
    expect(w.complete).toBe(true);
    expect(w.transfers).toHaveLength(120);
  });

  it('keeps every event of a block together when many share one timestamp across a page boundary', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    grid.pageCap = 25;
    // 60 transfers in only two blocks: pages split a block, and every row of a block has the same timestamp.
    for (let i = 0; i < 60; i++) grid.addTransfer({ from: sender, to: watched, value: BigInt(i + 1), blockNumber: i < 40 ? 30n : 31n });
    const w = await providerOn(grid, { pageSize: 25 }).readIncomingTransfers({ address: watched, contract: USDT, sinceBlock: 11n, untilBlock: grid.head });
    expect(w.complete).toBe(true);
    expect(w.transfers).toHaveLength(60);
  });

  it('a failing second page leaves the window incomplete, proven only below the last block it fully read', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    for (let i = 0; i < 300; i++) grid.addTransfer({ from: sender, to: watched, value: BigInt(i + 1), blockNumber: 100n + BigInt(i) });
    grid.faults.push({ match: 'fingerprint=', status: 503 }); // every next page fails, retries included
    const w = await read(providerOn(grid), 50n, grid.head);
    expect(w.complete).toBe(false);
    expect(w.incompleteReason).toMatch(/history page 2 failed/);
    // Page 1 held blocks 100…299; block 299's rows may continue on page 2, so the proof stops at 298.
    expect(w.completeThrough).toBe(298n);
    expect(w.transfers.every((t) => t.blockNumber <= 299n)).toBe(true);
  });

  it('retries a transient failure and then reads the window completely', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    grid.addTransfer({ from: sender, to: watched, value: 5n, blockNumber: 20n });
    grid.faults.push({ match: '/transactions/trc20', times: 1, status: 503 }, { match: 'gettransactioninfobyid', times: 1 });
    const w = await read(providerOn(grid), 11n, grid.head);
    expect(w).toMatchObject({ complete: true });
    expect(w.transfers).toHaveLength(1);
  });

  it('a receipt the index lists but the node cannot produce is a gap, and the proof stops before its block', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    const early = grid.addTransfer({ from: sender, to: watched, value: 1n, blockNumber: 20n });
    const missing = grid.addTransfer({ from: sender, to: watched, value: 2n, blockNumber: 25n });
    const late = grid.addTransfer({ from: sender, to: watched, value: 3n, blockNumber: 30n });
    grid.receiptsWithheld.add(missing.txHash);
    const w = await read(providerOn(grid), 11n, grid.head);
    expect(w.complete).toBe(false);
    expect(w.incompleteReason).toMatch(/receipt unavailable/);
    expect(w.completeThrough).toBe(early.blockNumber);
    // What it could prove it still reports — detection is idempotent, so reporting more is never harmful.
    expect(w.transfers.map((t) => t.txHash).sort()).toEqual([early.txHash, late.txHash].sort());
  });

  it('a receipt that contradicts the index is a gap, never a silent drop', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    const tx = grid.addTransfer({ from: sender, to: watched, value: 10n, blockNumber: 20n });
    const rawFetch = grid.fetch;
    const lying = (async (input: unknown, init?: RequestInit) => {
      const res = await rawFetch(input as string, init);
      if (!String(input).includes('/transactions/trc20')) return res;
      const body = (await res.json()) as { data: { value: string }[] };
      for (const row of body.data) row.value = '11';
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const w = await providerOn(grid, { fetchImpl: lying }).readIncomingTransfers({ address: watched, contract: USDT, sinceBlock: 11n, untilBlock: grid.head });
    expect(w).toMatchObject({ complete: false, completeThrough: 10n });
    expect(w.incompleteReason).toMatch(/does not contain the transfer the history lists/);
    expect(tx.txHash).toBeTruthy();
  });

  it('a repeating pagination token stops the read and says so', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    for (let i = 0; i < 250; i++) grid.addTransfer({ from: sender, to: watched, value: BigInt(i + 1), blockNumber: 20n + BigInt(i) });
    grid.fingerprintLoop = true;
    const w = await read(providerOn(grid), 11n, grid.head);
    expect(w.complete).toBe(false);
    expect(w.incompleteReason).toMatch(/pagination token repeated/);
    expect(w.completeThrough).toBeLessThan(grid.head);
  });

  it('the page limit and the time budget end a read as incomplete, not as complete', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    for (let i = 0; i < 450; i++) grid.addTransfer({ from: sender, to: watched, value: BigInt(i + 1), blockNumber: 20n + BigInt(i) });
    const limited = await providerOn(grid, { maxPages: 2 }).readIncomingTransfers({ address: watched, contract: USDT, sinceBlock: 11n, untilBlock: grid.head });
    expect(limited).toMatchObject({ complete: false });
    expect(limited.incompleteReason).toMatch(/page limit/);
    const rushed = await providerOn(grid, { readBudgetMs: 1, fetchImpl: (async (i: unknown, init?: RequestInit) => { await new Promise((r) => setTimeout(r, 5)); return grid.fetch(i as string, init); }) as typeof fetch })
      .readIncomingTransfers({ address: watched, contract: USDT, sinceBlock: 11n, untilBlock: grid.head });
    expect(rushed.complete).toBe(false);
  });

  it('edges unavailable: nothing is proven, nothing is reported as "no transfers"', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    grid.addTransfer({ from: sender, to: watched, value: 5n, blockNumber: 20n });
    grid.faults.push({ match: 'getblockbynum', status: 500 });
    const w = await read(providerOn(grid), 11n, grid.head);
    expect(w).toMatchObject({ complete: false, completeThrough: 10n, transfers: [] });
  });

  it('a reverted transaction the index lists anyway moved nothing; a missed slot does not shift the window', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    grid.skipSlot(21n, 4);
    const ok = grid.addTransfer({ from: sender, to: watched, value: 5n, blockNumber: 21n });
    const reverted = grid.addTransfer({ from: sender, to: watched, value: 6n, blockNumber: 22n, result: 'REVERT' });
    const w = await read(providerOn(grid), 21n, 22n);
    expect(w.complete).toBe(true);
    expect(w.transfers.map((t) => t.txHash)).toEqual([ok.txHash]);
    expect(reverted.logs).toHaveLength(0);
  });

  it('transfers outside the window are not reported, whatever the timestamp margin lets in', async () => {
    const grid = new FakeTronGrid({ head: 10n });
    const before = grid.addTransfer({ from: sender, to: watched, value: 1n, blockNumber: 19n });
    const inside = grid.addTransfer({ from: sender, to: watched, value: 2n, blockNumber: 20n });
    const after = grid.addTransfer({ from: sender, to: watched, value: 3n, blockNumber: 21n });
    const w = await read(providerOn(grid), 20n, 20n);
    expect(w.transfers.map((t) => t.txHash)).toEqual([inside.txHash]);
    expect([before.txHash, after.txHash]).not.toContain(w.transfers[0]!.txHash);
    expect(historyCalls(grid)).toBe(1);
  });
});
