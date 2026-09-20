import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { HEALTH_CHECKS, systemHealth } from '../src/index.ts';
import { type World, createWorld, openTrade } from '../../settlement/test/world.ts';

/**
 * The health read model against a real database (launch checklist: monitoring + alerts).
 *
 * The unit test covers the thresholds; this covers the part that can only break against PostgreSQL — nine
 * subqueries over nine tables, any one of which could name a column that no longer exists and turn the health
 * endpoint into the thing that pages you.
 */
let w: World;

beforeAll(async () => {
  w = await createWorld('desk_health', { capacityInr: '500000000.00' });
}, 180_000);
afterAll(async () => w.close());

describe('the health snapshot', () => {
  it('answers every defined check, in one read', async () => {
    const health = await systemHealth(w.app);
    expect(health.checks.map((c) => c.id).sort()).toEqual(HEALTH_CHECKS.map((c) => c.id).sort());
    expect(new Date(health.checkedAt).getTime()).toBeGreaterThan(0);
    for (const check of health.checks) expect(Number.isFinite(check.value), check.id).toBe(true);
  });

  it('reports a quiet, working world as healthy on the books', async () => {
    const health = await systemHealth(w.app);
    const byId = new Map(health.checks.map((c) => [c.id, c]));
    // The two that must be true of any correct database, whatever else is going on.
    expect(byId.get('ledger_imbalance')!.value).toBe(0);
    expect(byId.get('ledger_imbalance')!.state).toBe('ok');
    expect(byId.get('blocking_exceptions')!.value).toBe(0);
    // Capacity is read from today's row and reported in whole rupees.
    expect(byId.get('inr_capacity_available')!.value).toBeGreaterThan(0);
    expect(byId.get('deposit_pool_free')!.value).toBeGreaterThan(0);
  });

  it('notices work arriving: an open trade takes an address out of the pool', async () => {
    const before = (await systemHealth(w.app)).checks.find((c) => c.id === 'deposit_pool_free')!.value;
    await openTrade(w, { baseUsdt: '1000', clientRate: '90.000000' });
    const after = (await systemHealth(w.app)).checks.find((c) => c.id === 'deposit_pool_free')!.value;
    expect(after).toBe(before - 1);
  }, 120_000);

  it('turns blocking cases into the state that wakes someone', async () => {
    const { openException } = await import('@inrp2p/settlement');
    const { runAs } = await import('@inrp2p/identity/testing');
    // Four **different** trades: a second case of the same type on the same subject is deliberately the same
    // case, so opening one four times would leave this check reading one.
    for (let i = 0; i < 4; i += 1) {
      const trade = await openTrade(w, { baseUsdt: '1000', clientRate: '90.000000' });
      await runAs(w.app, openException(w.settlementOp.actor), w.settlementOp.ref, 'exception.open', {
        type: 'USDT_WRONG_AMOUNT' as const, subjectType: 'TRADE' as const, subjectId: trade.tradeId,
        tradeId: trade.tradeId, details: { seq: i },
      });
    }
    const check = (await systemHealth(w.app)).checks.find((c) => c.id === 'blocking_exceptions')!;
    // Four open blocking cases is past `warn` (3) and short of `alarm` (10): the middle state exists so that a
    // busy afternoon is visible without being an emergency.
    expect(check.value).toBeGreaterThanOrEqual(4);
    expect(check.state === 'warn' || check.state === 'alarm').toBe(true);
    expect((await systemHealth(w.app)).state).not.toBe('ok');
  }, 120_000);

  it('reads the scanner’s own cursor rather than guessing', async () => {
    await sql`
      insert into chain_cursor (network, scanner, last_scanned_block, last_solidified_block, last_run_at)
      values ('TRON', 'health_probe', 1, 1, statement_timestamp() - interval '20 minutes')
      on conflict (network, scanner) do update set last_run_at = excluded.last_run_at`.execute(w.app);
    const check = (await systemHealth(w.app)).checks.find((c) => c.id === 'scanner_lag_seconds')!;
    // The cursor is twenty minutes old and it is the only one, so the lag is real and past the alarm.
    expect(check.value).toBeGreaterThan(600);
    expect(check.state).toBe('alarm');
  });
});
