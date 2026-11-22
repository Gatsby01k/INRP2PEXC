import { describe, expect, it } from 'vitest';
import { BALANCE_BRACKET_BLOCKS, TronHttpProvider } from '../src/tron.ts';
import { FAKE_USDT_CONTRACT, FakeTronGrid, fakeTronAddress } from '../src/testing/index.ts';

/**
 * A balance is read from a node's solidified state, which names no block, so the read is bracketed by the solidified
 * head before and after it (`getSolidifiedBalance`). These are the shapes a real provider gives that bracket: a head that
 * moves while the read is in flight (a provider a few hundred milliseconds away, a block every three seconds), and two
 * nodes behind one balancer whose heads disagree.
 */

const USDT = FAKE_USDT_CONTRACT;
const holder = fakeTronAddress('balance-holder');
const sender = fakeTronAddress('balance-sender');

/** A grid whose `/walletsolidity/getnowblock` answers come from `heads` in turn — what the provider's nodes say. */
function scripted(grid: FakeTronGrid, heads: () => bigint): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/walletsolidity/getnowblock')) {
      grid.requests.push(`POST /walletsolidity/getnowblock`);
      const n = heads();
      return new Response(JSON.stringify({ blockID: n.toString(16).padStart(64, '0'), block_header: { raw_data: { number: Number(n), timestamp: grid.blockTimestamp(n) } } }), { status: 200 });
    }
    return grid.fetch(input, init);
  };
}

function world() {
  const grid = new FakeTronGrid({ head: 1_000n, solidificationLag: 19n });
  grid.addTransfer({ from: sender, to: holder, value: 25_000_000n, blockNumber: 900n });
  grid.trx.set(holder, 3_000_000n);
  return grid;
}

const provider = (grid: FakeTronGrid, fetchImpl: typeof fetch) =>
  new TronHttpProvider({ name: 'remote', independenceGroup: 'remote-vendor', baseUrl: grid.baseUrl, fetchImpl, retryBaseDelayMs: 0 });

describe('reading a balance at a pinned solidified block', () => {
  it('reads balance and TRX between two equal heads, labelled with that block', async () => {
    const grid = world();
    const reading = await provider(grid, grid.fetch).getSolidifiedBalance(holder, USDT);
    expect(reading).toEqual({ balanceMinor: 25_000_000n, solidifiedBlock: grid.solidified, trxSun: 3_000_000n });
    // Both reads sit inside the bracket: head, balanceOf and account (in either order), head.
    const order = grid.requests.map((r) => r.split(' ')[1]);
    expect(order[0]).toBe('/walletsolidity/getnowblock');
    expect(new Set(order.slice(1, 3))).toEqual(new Set(['/walletsolidity/triggerconstantcontract', '/walletsolidity/getaccount']));
    expect(order[3]).toBe('/walletsolidity/getnowblock');
    expect(order).toHaveLength(4);
  });

  it('a head that moves a block under every read is still read — the reading carries the lower block', async () => {
    // A provider far enough away that a block is always produced while the read is in flight. Demanding the same head
    // before and after failed all three attempts here, every time: the second source dropped out of every reading.
    const grid = world();
    let head = grid.solidified;
    const reading = await provider(grid, scripted(grid, () => head++)).getSolidifiedBalance(holder, USDT);
    expect(reading.balanceMinor).toBe(25_000_000n);
    expect(reading.solidifiedBlock).toBe(grid.solidified);
  });

  it(`accepts a bracket of ${BALANCE_BRACKET_BLOCKS} blocks and reads again when the head moved further`, async () => {
    const grid = world();
    const base = grid.solidified;
    const answers = [base, base + BALANCE_BRACKET_BLOCKS + 1n, base + 10n, base + 10n + BALANCE_BRACKET_BLOCKS];
    const reading = await provider(grid, scripted(grid, () => answers.shift()!)).getSolidifiedBalance(holder, USDT);
    expect(reading.solidifiedBlock).toBe(base + 10n);
  });

  it('a head that goes backwards (two nodes behind a balancer) is never a bracket: it is read again, and refused if it keeps happening', async () => {
    const grid = world();
    const base = grid.solidified;
    let calls = 0;
    const p = provider(grid, scripted(grid, () => (calls++ % 2 === 0 ? base + 1n : base)));
    await expect(p.getSolidifiedBalance(holder, USDT)).rejects.toMatchObject({ code: 'CHAIN_EVIDENCE_INVALID', message: expect.stringContaining('went back') });
    // Four attempts, each a full bracket — never an answer pinned to a block the node had not reached.
    expect(grid.requests.filter((r) => r.includes('triggerconstantcontract'))).toHaveLength(4);
  });

  it('a recovery after one backwards bracket reads normally', async () => {
    const grid = world();
    const base = grid.solidified;
    const answers = [base + 1n, base, base + 1n, base + 1n];
    const reading = await provider(grid, scripted(grid, () => answers.shift()!)).getSolidifiedBalance(holder, USDT);
    expect(reading.solidifiedBlock).toBe(base + 1n);
  });
});
