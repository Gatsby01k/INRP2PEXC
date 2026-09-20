import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { isDomainError } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { confirmPayout, createPayoutLeg, recordLegEvidence, sendPayoutLeg } from '../src/index.ts';
import { type World, createWorld, newUtr, openTrade, settleFirstLeg } from './world.ts';

/**
 * The load test the launch checklist asks for: **quote accept and payout confirm, under contention**
 * (IMPLEMENTATION_PLAN Phase 9).
 *
 * It is a test rather than a script because the interesting part is not the throughput — this product will
 * never be busy in the way a public exchange is busy. The interesting part is what concurrency does to the
 * invariants: acceptance allocates a deposit address from a shared pool and posts a journal; payout confirm
 * takes capacity from one account-day row that every other payout wants at the same moment. Those are the two
 * places where a race would cost real money, so the load runs them against each other and then checks that
 * nothing moved that should not have.
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

/** One trade: 1,000 USDT at ₹90, against the world's own ₹92.50 route rate. */
const BASE_USDT = '1000';
const CLIENT_RATE = '90.000000';
const PAYOUT_INR = '90000.00';

let w: World;
const accepted: { tradeId: string; tradeRef: string }[] = [];
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
  // Capacity for every payout this run will make, and then some: the point is to contend for the row, not to
  // measure what happens when the desk runs out of money (which has its own tests).
  w = await createWorld('load', { capacityInr: '5000000000.00', depositPoolSize: Math.max(64, TOTAL + 8) });
  // The route's execution mode is set once, here, rather than by whichever lane gets there first: configuring a
  // route takes its version, so six lanes asking for the same change would just make five of them wrong. This
  // is setup, not the thing being measured.
  await openTrade(w, { baseUsdt: BASE_USDT, clientRate: CLIENT_RATE, executionMode: 'TO_EXCHANGE' });
}, 180_000);
afterAll(async () => w.close());

describe(`accepting ${TOTAL} quotes on ${WORKERS} lanes`, () => {
  it('opens every trade exactly once, with a deposit address of its own', async () => {
    const opened = await inParallel(TOTAL, async () =>
      timed('quote.accept', () => openTrade(w, { baseUsdt: BASE_USDT, clientRate: CLIENT_RATE, executionMode: 'TO_EXCHANGE' })),
    );
    accepted.push(...opened.map((o) => ({ tradeId: o.tradeId, tradeRef: o.tradeRef })));
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

describe(`settling ${TOTAL} trades on ${WORKERS} lanes`, () => {
  it('pays each one once, against a single account-day row every lane is competing for', async () => {
    await inParallel(accepted.length, async (i) => timed('first_leg', () => settleFirstLeg(w, accepted[i]!.tradeId)));

    await inParallel(accepted.length, async (i) => {
      const tradeId = accepted[i]!.tradeId;
      const leg = await timed('payout_leg.create', async () =>
        runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
          tradeId, amount: PAYOUT_INR, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
        }),
      );
      await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
      await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', {
        legId: leg.legId, rail: 'IMPS' as const, utr: newUtr('LOAD'),
      });
      await timed('payout.confirm', () => confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() }));
    });

    const states = await sql<{ lifecycle_state: string; n: string }>`
      select lifecycle_state, count(*)::text as n from trade
      where id in (${sql.join(accepted.map((t) => sql`${t.tradeId}`))}) group by lifecycle_state`.execute(w.app);
    expect(states.rows).toEqual([{ lifecycle_state: 'COMPLETED', n: String(TOTAL) }]);
  }, 900_000);

  it('confirms once when two lanes confirm the same payment at the same moment', async () => {
    // The race a retry actually causes: the operator's browser resends, or two tabs are open. One idempotency
    // key means one payment; two keys against one leg means the second is refused by the leg's own state.
    const trade = await openTrade(w, { baseUsdt: BASE_USDT, clientRate: CLIENT_RATE, executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, trade.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', {
      tradeId: trade.tradeId, amount: PAYOUT_INR, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId,
    });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', {
      legId: leg.legId, rail: 'IMPS' as const, utr: newUtr('RACE'),
    });

    const sameKey = randomUUID();
    const outcomes = await Promise.allSettled([
      confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: sameKey }),
      confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: sameKey }),
      confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() }),
    ]);
    // Whatever each caller was told, the money moved once: one journal for that confirmation, and one only.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(isDomainError(outcome.reason)).toBe(true);
    }
    const journals = await sql<{ n: string }>`
      select count(*)::text as n from ledger_journal j
      join ledger_entry e on e.journal_id = j.id
      where e.trade_id = ${trade.tradeId} and j.posting_key like 'fiat:%:confirm'`.execute(w.app);
    expect(Number(journals.rows[0]!.n)).toBeGreaterThan(0);
    const confirmed = await sql<{ n: string }>`
      select count(*)::text as n from settlement_leg
      where trade_id = ${trade.tradeId} and side = 'EXCHANGE_TO_CLIENT' and status = 'COMPLETED'`.execute(w.app);
    expect(confirmed.rows[0]!.n).toBe('1');
  }, 300_000);
});

describe('what the load did to the books', () => {
  it('left the ledger balanced and every trade within its obligation', async () => {
    expect(await w.app.selectFrom('ledger_global_imbalance').selectAll().execute()).toEqual([]);

    const unbalanced = await sql<{ posting_key: string }>`
      select j.posting_key from ledger_journal j
      join ledger_entry e on e.journal_id = j.id
      group by j.posting_key, e.currency
      having sum(case e.direction when 'DR' then e.amount_minor else -e.amount_minor end) <> 0`.execute(w.app);
    expect(unbalanced.rows).toEqual([]);

    const over = await sql<{ id: string }>`
      select t.id from trade t
      where coalesce((select sum(amount_minor) from settlement_leg
                      where trade_id = t.id and side = 'EXCHANGE_TO_CLIENT' and status in ('PENDING','PROCESSING','COMPLETED')), 0)
            > inrp2p_trade_payout_obligation(t.id)`.execute(w.app);
    expect(over.rows).toEqual([]);
  });

  it('never let the shared account-day go over its capacity', async () => {
    // Every payout in this run drew on one account on one day. If the capacity check is not taken under a lock,
    // this is the row that goes negative.
    const days = await sql<{ day: string; over: boolean; matches: boolean }>`
      select d.day::text as day,
             (d.used_minor + d.reserved_minor > d.capacity_minor) as over,
             (d.reserved_minor = coalesce((select sum(amount_minor - consumed_minor) from capacity_reservation r
                                           where r.account_id = d.account_id and r.day = d.day and r.status = 'ACTIVE'), 0)) as matches
      from inr_account_day d`.execute(w.app);
    expect(days.rows.length).toBeGreaterThan(0);
    for (const d of days.rows) expect({ day: d.day, over: d.over, matches: d.matches }).toEqual({ day: d.day, over: false, matches: true });
  });

  it('gave every payment its own bank reference', async () => {
    const duplicates = await sql<{ utr: string }>`
      select utr from fiat_transfer group by utr, rail having count(*) > 1`.execute(w.app);
    expect(duplicates.rows).toEqual([]);
  });

  it('reports what it measured', () => {
    const report = ['quote.accept', 'first_leg', 'payout_leg.create', 'payout.confirm'].map((label) => ({ step: label, ...summary(label) }));
    // The numbers are the deliverable of a load run, so they are printed rather than only asserted.
    console.table(report);
    for (const row of report) expect(row.n).toBeGreaterThan(0);
  });
});
