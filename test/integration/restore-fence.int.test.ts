import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import { executeCommand } from '@inrp2p/commands';
import { confirmClientReceipt, createPayoutLegInTx, decideRestoreFenceLift, raiseRestoreFence, requestRestoreFenceLift, sendPayoutLegInTx, setNewBusiness } from '@inrp2p/settlement';
import { newBusinessState, payoutsHeld, restoreFenceState } from '@inrp2p/trades';
import { operationsStatus, prometheusText } from '@inrp2p/desk';
import { recordHeartbeat } from '../../apps/worker/src/tasks.ts';
import { clientPaysTrader, observe, openTrade, payClient, scenarioTrader, settleFirstLeg } from '../../packages/settlement/test/world.ts';
import { type TradersWorld, configureProgram, createTradersWorld } from './traders-world.ts';

/**
 * E4 — a restore must not cause a second payout. A database that is not the one the workers last wrote to (recovered to
 * an earlier moment, failed over, moved to another cluster) may have forgotten payments already made, and the desk would
 * show them as still to pay. From the moment it changes, the steps that authorise money to leave the exchange are held —
 * in the commands and in the database (IX100) — until one person has recorded the reconciliation and another has
 * approved it (IX101). Recording what already happened is never held: it is what closes an obligation.
 */
let w: TradersWorld;
beforeAll(async () => {
  w = await createTradersWorld('restore_fence');
  await configureProgram(w, { reserve: '500' });
  await scenarioTrader(w);
}, 300_000);
afterAll(async () => w.close());

const beat = (workerId = 'worker-a') => recordHeartbeat(w.t.worker, { workerId, startedAt: new Date(), release: 'test', config: { chain: 'test' } });
/** What a database restored onto another cluster looks like from inside: every heartbeat it holds was written elsewhere. */
const restoredElsewhere = () => sql`update worker_heartbeat set db_identity = jsonb_build_object('cluster', '7000000000000000001', 'timeline', 1)`.execute(w.t.worker);
const SYSTEM = { type: 'SYSTEM' as const, id: null, surface: 'SYSTEM' as const };
const system = <R>(name: string, handle: Parameters<typeof executeCommand<Record<string, unknown>, R>>[1]['handle']) =>
  executeCommand(w.app, { authorize: async () => {}, handle }, { name, actor: SYSTEM, payload: {}, idempotencyKey: randomUUID(), financial: true }).then((o) => o.result);
/** What the signer's driver does with a purchase's USDT: a payout out of the escrow, sent as the system. */
const send = (legId: string) => system('payout_leg.send', (ctx) => sendPayoutLegInTx(ctx, {}, legId));
const planLeg = (tradeId: string, amount: string, sourceDepositAddressId: string) =>
  system('payout_leg.create', (ctx) => createPayoutLegInTx(ctx, {}, { tradeId, amount, payer: 'EXCHANGE_ACCOUNT', sourceDepositAddressId }));
const raise = (who: TestOperator, reason: string) => runAs(w.app, raiseRestoreFence(who.actor), who.ref, 'operations.raise_restore_fence', { reason });
const askToLift = (who: TestOperator, reconciliation: string) => runAs(w.app, requestRestoreFenceLift(who.actor), who.ref, 'operations.request_restore_fence_lift', { reconciliation });
const decide = (who: TestOperator, liftId: string, approve: boolean) =>
  runAs(w.app, decideRestoreFenceLift(who.actor), who.ref, approve ? 'operations.approve_restore_fence_lift' : 'operations.decline_restore_fence_lift', { liftId, approve, note: approve ? 'checked the statements' : 'not yet' });
const resume = () => runAs(w.app, setNewBusiness(w.financeOp.actor), w.financeOp.ref, 'settings.resume_new_business', { paused: false, reason: 'reconciled after the restore drill' });

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
    // Before the change: a trader's payment already filed, and a purchase's USDT planned out of its escrow.
    const sale = await openTrade(w, { baseUsdt: '1000', clientRate: '102.000000' });
    await settleFirstLeg(w, sale.tradeId);
    const filed = await payClient(w, sale, { confirm: false });
    const purchase = await openTrade(w, { direction: 'BUY_USDT', baseUsdt: '300', clientRate: '106.000000' });
    await clientPaysTrader(w, purchase);
    const escrow = await w.app.selectFrom('deposit_assignment as a').innerJoin('deposit_address as d', 'd.id', 'a.deposit_address_id').select(['d.id', 'd.address']).where('a.route_obligation_id', '=', purchase.routeObligationId).executeTakeFirstOrThrow();
    const planned = await planLeg(purchase.tradeId, '300', escrow.id);
    await observe(w, escrow.address);

    await restoredElsewhere();
    // Held at once, before any worker has noticed: the change is in the database, not in a process.
    expect(await payoutsHeld(w.app)).toEqual({ held: true, ref: null });
    expect((await restoreFenceState(w.app)).unacknowledgedChange).toBe(true);
    await expect(send(planned.legId)).rejects.toMatchObject({ code: 'PAYOUTS_HELD' });
    await expect(sql`update settlement_leg set status = 'PROCESSING', sent_at = now(), sent_by = ${w.settlementOp.ref.id} where id = ${planned.legId}`.execute(w.app))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX100');
    // What already happened is recorded as usual: the rupees the trader paid before the change, confirmed by the client.
    await runAs(w.app, confirmClientReceipt(w.acceptor.actor, w.settlementDeps), w.acceptor.ref, 'payout.confirm_received', { tradeRef: sale.tradeRef, legRef: filed.legRef, senderName: 'Konkan Desk LLP' });
    expect((await w.app.selectFrom('settlement_leg').select('status').where('ref', '=', filed.legRef).executeTakeFirstOrThrow()).status).toBe('COMPLETED');

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
    await observe(w, escrow.address);
    await send(planned.legId);
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

    // Nothing is written already decided: not a fence already lifted, not a lift already approved (IX101).
    await expect(sql`insert into restore_fence (status, reason, raised_by, lift_id, lifted_by, lifted_at)
                     values ('LIFTED', 'written already lifted', 'SYSTEM:test', gen_random_uuid(), ${w.financeOp2.ref.id}, now())`.execute(w.app))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX101');
    await expect(sql`insert into restore_fence_lift (fence_id, status, reconciliation, requested_by, decided_by, decided_at)
                     values (${raised.fence!.id}, 'APPROVED', 'a reconciliation written already approved', ${w.financeOp.ref.id}, ${w.financeOp2.ref.id}, now())`.execute(w.app))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX101');

    const third = await askToLift(w.financeOp, 'Compared the bank statements and the chain since 10:42 IST; nothing unrecorded on either.');
    expect(await decide(w.financeOp2, third.lift!.id, true)).toMatchObject({ held: false });
    const lifts = await w.app.selectFrom('restore_fence_lift').select('status').where('fence_id', '=', raised.fence!.id).orderBy('requested_at').execute();
    expect(lifts.map((l) => l.status)).toEqual(['DECLINED', 'DECLINED', 'APPROVED']);
    await resume();
  });
});
