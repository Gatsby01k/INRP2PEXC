import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { runAs } from '@inrp2p/identity/testing';
import { dispatchOutbox } from '@inrp2p/outbox';
import { traderNotificationHandler } from '@inrp2p/notifications';
import { systemHealth } from '@inrp2p/desk';
import { assignRequest, runTraderSweep } from '@inrp2p/traders';
import { observe } from '../../packages/settlement/test/world.ts';
import { type TradersWorld, clientRequest, configureProgram, createTradersWorld, liveTrader, traderClient, utr } from './traders-world.ts';

/**
 * D4: one trader's whole life against the real database — applied, approved, reserve funded, both sides traded with
 * the counterparty's money only (D-16), rewards paid out of the margin those trades realized and never out of
 * anyone's principal, switched off, reserve withdrawn — and every account it touched back at zero. Then the sweep
 * that moves orders on its own, keeping going when one order fails.
 */
let w: TradersWorld;
beforeAll(async () => {
  w = await createTradersWorld('trader_lifecycle');
  await configureProgram(w, { reserve: '500' });
});
afterAll(async () => w.close());

const usdt = (v: string) => Money.parse(v, 'USDT').minor;
/** The worker's outbox dispatch, run where the worker would have run it: right after the event. */
describe('the trader sweep (D4)', () => {
  it('keeps going when one order fails, reports it, retries it next run, and the health check shows it meanwhile', async () => {
    const t = await traderClient(w, 'Sweep Subject');
    await liveTrader(w, t, { buy: { capacity: '1000000', rate: '140.00', min: '1', max: '1000000' } });
    const first = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: await clientRequest(w, 'SELL_USDT', '10'), plannedClientRate: '139.000000' });
    const second = await runAs(w.app, assignRequest(w.dealer.actor), w.dealer.ref, 'trader_order.assign', { requestId: await clientRequest(w, 'SELL_USDT', '11'), plannedClientRate: '139.000000' });
    const expiry = await w.app.selectFrom('trader_order').select(sql<Date>`max(offer_expires_at)`.as('at')).where('id', 'in', [first.orderId, second.orderId]).executeTakeFirstOrThrow();

    // Something in one order's step fails — here a fault planted in the database for that one row.
    await sql.raw(`
      create function test_fail_one_order() returns trigger language plpgsql as $$
      begin
        if new.id = '${first.orderId}' and new.status = 'EXPIRED' then raise exception 'planted fault' using errcode = 'P0001'; end if;
        return new;
      end $$;
      create trigger test_fail_one_order before update on trader_order for each row execute function test_fail_one_order();`).execute(w.t.owner);
    const clock = await w.t.pinnedClock();
    try {
      await clock.set(new Date(expiry.at.getTime() + 11 * 60_000));
      const report = await runTraderSweep(clock.db);
      expect(report.offersExpired).toBeGreaterThanOrEqual(1);
      expect(report.failures).toEqual([expect.objectContaining({ step: 'trader_order.expire_offer', orderId: first.orderId, code: 'P0001' })]);
      const statuses = await w.app.selectFrom('trader_order').select(['id', 'status']).where('id', 'in', [first.orderId, second.orderId]).execute();
      expect(Object.fromEntries(statuses.map((s) => [s.id, s.status]))).toEqual({ [first.orderId]: 'OFFERED', [second.orderId]: 'EXPIRED' });
      const health = await systemHealth(clock.db);
      expect(health.checks.find((c) => c.id === 'trader_orders_overdue')).toMatchObject({ value: 1, state: 'warn', runbook: 'trader-sweep-behind' });

      await sql.raw('drop trigger test_fail_one_order on trader_order; drop function test_fail_one_order();').execute(w.t.owner);
      const retried = await runTraderSweep(clock.db);
      expect(retried.failures).toEqual([]);
      expect((await w.app.selectFrom('trader_order').select('status').where('id', '=', first.orderId).executeTakeFirstOrThrow()).status).toBe('EXPIRED');
      expect((await systemHealth(clock.db)).checks.find((c) => c.id === 'trader_orders_overdue')?.value).toBe(0);
    } finally {
      await clock.set(null);
      await sql.raw('drop trigger if exists test_fail_one_order on trader_order; drop function if exists test_fail_one_order();').execute(w.t.owner);
    }
  });
});
