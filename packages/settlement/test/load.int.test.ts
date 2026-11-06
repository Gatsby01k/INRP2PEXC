import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isDomainError } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { confirmClientReceipt } from '../src/index.ts';
import { type World, createWorld, openTrade, payClient, settleFirstLeg } from './world.ts';

/**
 * The load test the launch checklist asks for: **quote accept and a deal's confirmation, under contention**
 * (IMPLEMENTATION_PLAN Phase 9).
 *
 * It is a test rather than a script because the interesting part is not the throughput — this product will
 * never be busy in the way a public exchange is busy. The interesting part is what concurrency does to the
 * invariants: acceptance allocates a deposit address from a shared pool, holds its trader's capacity and posts a
 * journal; every deal of a trader wants that trader's row at the same moment. Those are the places where a race
 * would cost real money, so the load runs them against each other and then checks that nothing moved that should
 * not have.
 *
 * Volume is an environment variable, with a small default so CI exercises the path on every run:
 *
 *     LOAD_WORKERS=12 LOAD_TRADES_PER_WORKER=25 pnpm run load:test
 *
 * The timings it prints are a property of whatever machine ran it and are reported, never asserted — a latency
 * budget enforced on a shared CI runner fails for reasons that have nothing to do with the product.
 */
const WORKERS = Number.parseInt(process.env.LOAD_WORKERS ?? '6', 10);
const PER_WORKER = Number.parseInt(process.env.LOAD_TRADES_PER_WORKER ?? '3', 10);
const TOTAL = WORKERS * PER_WORKER;

/** One deal: 1,000 USDT at ₹102, against the world's trader at ₹103. */
const BASE_USDT = '1000';
const CLIENT_RATE = '102.000000';

let w: World;
const accepted: Awaited<ReturnType<typeof openTrade>>[] = [];
const timings = new Map<string, number[]>();

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const list = timings.get(label) ?? [];
    list.push(performance.now() - started);
    timings.set(label, list);
  }
}

/** Percentiles, reported rather than asserted. */
function summary(label: string): { n: number; p50: number; p95: number; max: number } {
  const xs = [...(timings.get(label) ?? [])].sort((a, b) => a - b);
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))] ?? 0;
  return { n: xs.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(xs[xs.length - 1] ?? 0) };
}

/** Runs `fn` on `WORKERS` lanes at once, which is what makes this a load test rather than a loop. */
async function inParallel<T>(count: number, fn: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      for (let i = next++; i < count; i = next++) results.push(await fn(i));
    }),
  );
  return results;
}

beforeAll(async () => {
  w = await createWorld('load', { depositPoolSize: Math.max(64, TOTAL + 8) });
  // The trader comes with the first deal, here, rather than with whichever lane gets there first.
  await openTrade(w, { baseUsdt: BASE_USDT, clientRate: CLIENT_RATE });
}, 180_000);
afterAll(async () => w.close());

describe(`accepting ${TOTAL} quotes on ${WORKERS} lanes`, () => {
  it('opens every trade exactly once, with a deposit address of its own', async () => {
    const opened = await inParallel(TOTAL, async () => timed('quote.accept', () => openTrade(w, { baseUsdt: BASE_USDT, clientRate: CLIENT_RATE })));
    accepted.push(...opened);
    expect(new Set(accepted.map((t) => t.tradeId)).size).toBe(TOTAL);
    expect(new Set(accepted.map((t) => t.tradeRef)).size).toBe(TOTAL);

    // D-02: attribution is by address, so two trades sharing one open assignment would be the worst bug this
    // system could have. Under concurrency is exactly when a pool allocator hands the same address out twice.
    const shared = await sql<{ deposit_address_id: string; n: string }>`
      select deposit_address_id, count(*)::text as n from deposit_assignment
      where released_at is null group by deposit_address_id having count(*) > 1`.execute(w.app);
    expect(shared.rows).toEqual([]);
  }, 600_000);
});

describe(`settling ${TOTAL} deals on ${WORKERS} lanes`, () => {
  it('pays each one once, while every lane competes for the same trader', async () => {
    await inParallel(TOTAL, async (i) => {
      const trade = accepted[i]!;
      await timed('first_leg', () => settleFirstLeg(w, trade.tradeId));
      await timed('deal.confirm', () => payClient(w, trade));
    });
    const states = await w.app.selectFrom('trade').select('lifecycle_state').where('id', 'in', accepted.map((t) => t.tradeId)).execute();
    expect(states.every((t) => t.lifecycle_state === 'COMPLETED')).toBe(true);
  }, 600_000);

  it('confirms once when two lanes confirm the same payment at the same moment', async () => {
    const trade = await openTrade(w, { baseUsdt: BASE_USDT, clientRate: CLIENT_RATE });
    await settleFirstLeg(w, trade.tradeId);
    const paid = await payClient(w, trade, { confirm: false });
    const confirm = () => runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: trade.tradeRef, legRef: paid.legRef, senderName: 'Konkan Desk LLP' });
    const results = await Promise.allSettled([confirm(), confirm()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isDomainError(refused.reason)).toBe(true);
    const journals = await sql<{ n: string }>`
      select count(*)::text as n from ledger_journal where trade_id = ${trade.tradeId} and posting_key like 'fiat:%'`.execute(w.app);
    expect(journals.rows[0]!.n).toBe('1');
  }, 120_000);
});

describe('what the load did to the books', () => {
  it('left the ledger balanced and every trade within its obligation', async () => {
    expect(await w.app.selectFrom('ledger_global_imbalance').selectAll().execute()).toEqual([]);
    const over = await sql<{ id: string }>`
      select t.id from trade t
      where (select coalesce(sum(l.amount_minor), 0) from settlement_leg l where l.trade_id = t.id and l.side = 'EXCHANGE_TO_CLIENT' and l.status = 'COMPLETED')
            > inrp2p_trade_payout_obligation(t.id)`.execute(w.app);
    expect(over.rows).toEqual([]);
  });

  it('never held more of its trader’s capacity than its open orders', async () => {
    const blocks = await sql<{ reserved: string; open: string }>`
      select b.reserved_minor::text as reserved,
             coalesce((select sum(o.capacity_minor) from trader_order o where o.trader_id = b.trader_id and o.side = b.side and o.status in ('ACCEPTED', 'IN_PROGRESS')), 0)::text as open
      from trader_block b`.execute(w.app);
    for (const b of blocks.rows) expect(b.reserved).toBe(b.open);
  });

  it('gave every payment its own bank reference', async () => {
    const duplicates = await sql<{ utr: string; n: string }>`
      select f.utr, count(*)::text as n from fiat_transfer f group by f.utr having count(*) > 1`.execute(w.app);
    expect(duplicates.rows).toEqual([]);
  });

  it('reports what it measured', () => {
    const report = ['quote.accept', 'first_leg', 'deal.confirm'].map((label) => ({ step: label, ...summary(label) }));
    // The numbers are the deliverable of a load run, so they are printed rather than only asserted.
    console.table(report);
    for (const row of report) expect(row.n).toBeGreaterThan(0);
  });
});
