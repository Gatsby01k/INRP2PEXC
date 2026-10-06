import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import {
  confirmPayout, createPayoutLeg, decideRestoreFenceLift, raiseRestoreFence, recordLegEvidence, requestRestoreFenceLift, sendPayoutLeg, setNewBusiness,
} from '@inrp2p/settlement';
import { approveReserveApplication, requestReserveApplication } from '@inrp2p/traders';
import { newBusinessState, payoutsHeld, restoreFenceState } from '@inrp2p/trades';
import { operationsStatus, prometheusText } from '@inrp2p/desk';
import { recordHeartbeat } from '../../apps/worker/src/tasks.ts';
import { deliverCounterparty, newUtr, openTrade, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { type TraderSetup, type TradersWorld, clientRequest, configureProgram, createTradersWorld, liveTrader, traderClient, tradeThroughTrader } from './traders-world.ts';

/**
 * E4 — a restore must not cause a second payout. A database that is not the one the workers last wrote to (recovered to
 * an earlier moment, failed over, moved to another cluster) may have forgotten payments already made, and the desk would
 * show them as still to pay. From the moment it changes, the steps that authorise money to leave the exchange are held —
 * in the commands and in the database (IX100) — until one person has recorded the reconciliation and another has
 * approved it (IX101). Recording what already happened is never held: it is what closes an obligation.
 */
let w: TradersWorld;
let seller: TraderSetup;
beforeAll(async () => {
  w = await createTradersWorld('restore_fence');
  await configureProgram(w, { reserve: '500', rewardBps: 10, collection: true });
  seller = await traderClient(w, 'Fence Seller');
  await liveTrader(w, seller, { sell: { capacity: '5000', rate: '105.20', min: '100', max: '2500' }, reserve: '800' });
}, 300_000);
afterAll(async () => w.close());

const beat = (workerId = 'worker-a') => recordHeartbeat(w.t.worker, { workerId, startedAt: new Date(), release: 'test', config: { chain: 'test' } });
/** What a database restored onto another cluster looks like from inside: every heartbeat it holds was written elsewhere. */
const restoredElsewhere = () => sql`update worker_heartbeat set db_identity = jsonb_build_object('cluster', '7000000000000000001', 'timeline', 1)`.execute(w.t.worker);
const send = (legId: string, who: TestOperator = w.settlementOp) => runAs(w.app, sendPayoutLeg(who.actor), who.ref, 'payout_leg.send', { legId });
const planLeg = async (tradeId: string, amount: string) =>
  runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
const raise = (who: TestOperator, reason: string) => runAs(w.app, raiseRestoreFence(who.actor), who.ref, 'operations.raise_restore_fence', { reason });
const askToLift = (who: TestOperator, reconciliation: string) => runAs(w.app, requestRestoreFenceLift(who.actor), who.ref, 'operations.request_restore_fence_lift', { reconciliation });
const decide = (who: TestOperator, liftId: string, approve: boolean) =>
  runAs(w.app, decideRestoreFenceLift(who.actor), who.ref, approve ? 'operations.approve_restore_fence_lift' : 'operations.decline_restore_fence_lift', { liftId, approve, note: approve ? 'checked the statements' : 'not yet' });
const resume = () => runAs(w.app, setNewBusiness(w.financeOp.actor), w.financeOp.ref, 'settings.resume_new_business', { paused: false, reason: 'reconciled after the restore drill' });

async function fundedSellTrade(baseUsdt: string) {
  const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt, clientRate: '102.000000', routeRate: '104.200000' });
  await settleFirstLeg(w, trade.tradeId);
  await deliverCounterparty(w, trade.tradeId);
  return trade;
}

describe('the database names where it is (E4)', () => {
  it('tells the application its cluster and timeline, and holds nothing while it is the one the workers last wrote to', async () => {
    const identity = (await sql<{ i: { cluster: string; timeline: number } }>`select inrp2p_database_identity() as i`.execute(w.app)).rows[0]!.i;
    expect(identity).toEqual({ cluster: expect.stringMatching(/^\d+$/), timeline: expect.any(Number) });
    expect(identity.timeline).toBeGreaterThanOrEqual(1);
    expect(await beat()).toEqual({ raised: null });
    expect(await beat('worker-b')).toEqual({ raised: null });
    const recorded = await w.app.selectFrom('worker_heartbeat').select('db_identity').where('worker_id', '=', 'worker-a').executeTakeFirstOrThrow();
    expect(recorded.db_identity).toEqual(identity);
    expect(await payoutsHeld(w.app)).toEqual({ held: false, ref: null });
  });
});

describe('after the database changed underneath (E4)', () => {
  it('holds every step that authorises money out from that moment, records what already happened, and the worker fences it', async () => {
    // Before the change: a payout already sent, one only planned, and a reserve application waiting for approval.
    const trade = await fundedSellTrade('1000');
    const sent = await planLeg(trade.tradeId, '20000.00');
    await send(sent.legId);
    const planned = await planLeg(trade.tradeId, '30000.00');
    const order = await tradeThroughTrader(w, seller, { requestId: await clientRequest(w, 'BUY_USDT', '500'), clientRate: '106.000000' });
    await settleFirstLeg(w, order.tradeId);
    const application = await runAs(w.app, requestReserveApplication(w.financeOp.actor), w.financeOp.ref, 'trader_reserve.request_application', {
      orderId: order.orderId, reason: 'the trader stopped answering and its USDT did not arrive',
    });

    await restoredElsewhere();
    // Held at once, before any worker has noticed: the change is in the database, not in a process.
    expect(await payoutsHeld(w.app)).toEqual({ held: true, ref: null });
    expect((await restoreFenceState(w.app)).unacknowledgedChange).toBe(true);
    await expect(send(planned.legId)).rejects.toMatchObject({ code: 'PAYOUTS_HELD' });
    await expect(sql`update settlement_leg set status = 'PROCESSING', sent_at = now(), sent_by = ${w.settlementOp.ref.id} where id = ${planned.legId}`.execute(w.app))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX100');
    await expect(runAs(w.app, approveReserveApplication(w.financeOp2.actor, w.traderDeps), w.financeOp2.ref, 'trader_reserve.approve_application', { applicationId: application.applicationId }))
      .rejects.toMatchObject({ code: 'PAYOUTS_HELD' });
    // What already happened is recorded as usual: the payout sent before the change gets its UTR and is confirmed.
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: sent.legId, rail: 'IMPS' as const, utr: newUtr() });
    await confirmPayout(w.app, w.settlementOp2.actor, w.settlementDeps, { legId: sent.legId, idempotencyKey: randomUUID() });
    expect((await w.app.selectFrom('settlement_leg').select('status').where('id', '=', sent.legId).executeTakeFirstOrThrow()).status).toBe('COMPLETED');

    // The worker's next beat raises the fence, pauses new business with it, and says so on the record — once.
    const raised = await beat();
    expect(raised.raised).toMatch(/^RF-\d{4,}$/);
    expect(await beat('worker-b')).toEqual({ raised: null });
    const state = await restoreFenceState(w.app);
    expect(state).toMatchObject({
      held: true, unacknowledgedChange: false,
      fence: { ref: raised.raised, raisedBy: 'the system', identityBefore: { cluster: '7000000000000000001', timeline: 1 }, knownUntil: expect.any(String) },
      toReconcile: { payoutLegsToSend: 1, payoutLegsInFlight: 0 },
    });
    expect(state.fence!.reason).toMatch(/another cluster/);
    expect(await newBusinessState(w.app)).toMatchObject({ paused: true, setBy: 'the system' });
    const audit = await w.app.selectFrom('audit_event').select(['actor_type', 'after']).where('action', '=', 'operations.restore_fence_raised').executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_type: 'SYSTEM', after: { ref: raised.raised, paused_new_business: true } });

    // The alarm the pager sees, and the gauge a scraper reads.
    const status = await operationsStatus(w.app);
    expect(status.checks.find((c) => c.id === 'payouts_held')).toMatchObject({ value: 1, state: 'alarm', group: 'money', runbook: 'restore-fence' });
    expect(prometheusText(status)).toContain('inrp2p_payouts_held 1\n');

    // Released by two people: one records what was reconciled, another approves it — never the same one.
    const asked = await askToLift(w.financeOp, 'Compared every payout and reserve movement since the last heartbeat with the bank statements and the chain; one IMPS payout found and recorded.');
    const liftId = asked.lift!.id;
    await expect(askToLift(w.financeOp2, 'A second reconciliation while the first one is still waiting.')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(decide(w.financeOp, liftId, true)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(decide(w.settlementOp, liftId, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(sql`update restore_fence_lift set status = 'APPROVED', decided_by = requested_by, decided_at = now() where id = ${liftId}`.execute(w.app))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX101');
    await expect(sql`update restore_fence set status = 'LIFTED', lift_id = ${liftId}, lifted_by = ${w.financeOp2.ref.id}, lifted_at = now() where ref = ${raised.raised}`.execute(w.app))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX101');
    expect(await payoutsHeld(w.app)).toMatchObject({ held: true });

    const released = await decide(w.financeOp2, liftId, true);
    expect(released).toMatchObject({ held: false, fence: null, lastLifted: { ref: raised.raised } });
    // The same change is not held again: the fence named it, and the next heartbeat records it as the database's own.
    expect(await beat()).toEqual({ raised: null });
    expect(await payoutsHeld(w.app)).toEqual({ held: false, ref: null });
    await send(planned.legId);
    await runAs(w.app, approveReserveApplication(w.financeOp2.actor, w.traderDeps), w.financeOp2.ref, 'trader_reserve.approve_application', { applicationId: application.applicationId });
    // New business is its own decision.
    expect((await newBusinessState(w.app)).paused).toBe(true);
    await resume();
  });

  it('is raised by hand where the platform hides its identity, and a declined or withdrawn reconciliation releases nothing', async () => {
    await expect(raise(w.dealer, 'restored from the provider console to 10:42 IST')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(raise(w.financeOp, 'short')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const raised = await raise(w.financeOp, 'restored from the provider console to 10:42 IST');
    expect(raised).toMatchObject({ held: true, fence: { raisedBy: expect.not.stringMatching(/system/) } });
    await expect(raise(w.financeOp2, 'restored from the provider console a second time')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await newBusinessState(w.app)).paused).toBe(true);

    // Withdrawn by the person who recorded it, then declined by another: still held, still raised.
    const first = await askToLift(w.financeOp, 'Compared the bank statements since 10:42 IST; nothing found that is not recorded.');
    expect((await decide(w.financeOp, first.lift!.id, false)).held).toBe(true);
    const second = await askToLift(w.financeOp2, 'Compared the chain since 10:42 IST for every exchange address; nothing unrecorded.');
    const declined = await decide(w.financeOp, second.lift!.id, false);
    expect(declined).toMatchObject({ held: true, lift: null, fence: { ref: raised.fence!.ref } });

    const third = await askToLift(w.financeOp, 'Compared the bank statements and the chain since 10:42 IST; nothing unrecorded on either.');
    expect(await decide(w.financeOp2, third.lift!.id, true)).toMatchObject({ held: false });
    const lifts = await w.app.selectFrom('restore_fence_lift').select('status').where('fence_id', '=', raised.fence!.id).orderBy('requested_at').execute();
    expect(lifts.map((l) => l.status)).toEqual(['DECLINED', 'DECLINED', 'APPROVED']);
    await resume();
  });
});
