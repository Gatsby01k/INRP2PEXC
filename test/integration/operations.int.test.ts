import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { databaseDeploymentProblems, pgErrorCode, SCHEMA_VERSION } from '@inrp2p/db';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import { acceptQuote, createQuote, createRequest, sendQuote } from '@inrp2p/quotes';
import { confirmPayout, createPayoutLeg, recordLegEvidence, sendPayoutLeg, setNewBusiness } from '@inrp2p/settlement';
import { operationsStatus, prometheusText, systemHealth } from '@inrp2p/desk';
import { recordHeartbeat } from '../../apps/worker/src/tasks.ts';
import { type World, createWorld, ensureCounterpartyFunds, newUtr, openTrade, settleFirstLeg } from '../../packages/settlement/test/world.ts';

/**
 * E3: what a deployment checks about its database before serving, the switch that pauses new business without
 * touching what is started, and the health picture that tells a stopped worker and missing liquidity apart.
 */
let w: World;
beforeAll(async () => {
  w = await createWorld('operations', { capacityInr: '500000000.00' });
});
afterAll(async () => w.close());

describe('the database a process is given (E3)', () => {
  it('is the schema version this release was built for, reached through the application login — never the owner', async () => {
    expect((await sql<{ v: number }>`select inrp2p_schema_version() as v`.execute(w.app)).rows[0]!.v).toBe(SCHEMA_VERSION);
    // The test database carries the test clock permit, which a production database never may — and the check says so.
    expect(await databaseDeploymentProblems(w.app)).toEqual(['the test clock permit exists in this database; it must never exist outside tests']);
    const asOwner = await databaseDeploymentProblems(w.t.owner);
    expect(asOwner.join('\n')).toMatch(/superuser|owns the schema/);
  });
});

describe('pausing new business (E3)', () => {
  it('stops new requests, quotes and acceptances — in the commands and the database — and never what is started', async () => {
    // Started before the pause: a trade that has its client funds, and a quote already sent.
    const started = await openTrade(w, { baseUsdt: '100', clientRate: '90.000000', routeRate: '92.500000', executionMode: 'TO_EXCHANGE' });
    await settleFirstLeg(w, started.tradeId);
    const request = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '50', bankAccountId: w.bankAccountId });
    const sent = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: request.requestId, routeId: w.routeId, clientRate: '90.000000', validitySeconds: 300 });
    await runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: sent.quoteId });
    const draftRequest = await runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '60', bankAccountId: w.bankAccountId });
    const draft = await runAs(w.app, createQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.create', { requestId: draftRequest.requestId, routeId: w.routeId, clientRate: '90.000000', validitySeconds: 300 });

    const pause = (who: TestOperator, paused: boolean, reason = 'bank outage at the collection bank, assessing') =>
      runAs(w.app, setNewBusiness(who.actor), who.ref, paused ? 'settings.pause_new_business' : 'settings.resume_new_business', { paused, reason });
    await expect(pause(w.dealer, true)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(pause(w.financeOp, true, 'short')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await pause(w.financeOp, true)).toMatchObject({ paused: true, reason: 'bank outage at the collection bank, assessing' });
    await expect(pause(w.financeOp, true)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    // Nothing new: not a request, not a quote sent, not an acceptance — the client is told why.
    await expect(runAs(w.app, createRequest(w.dealer.actor, {}), w.dealer.ref, 'request.create', { clientId: w.clientId, direction: 'SELL_USDT' as const, fixedSide: 'BASE' as const, amount: '10', bankAccountId: w.bankAccountId }))
      .rejects.toMatchObject({ code: 'NEW_BUSINESS_PAUSED', message: expect.stringContaining('bank outage') });
    await expect(runAs(w.app, sendQuote(w.dealer.actor, {}), w.dealer.ref, 'quote.send', { quoteId: draft.quoteId })).rejects.toMatchObject({ code: 'NEW_BUSINESS_PAUSED' });
    await expect(runAs(w.app, acceptQuote(w.acceptor.actor, w.deps), w.acceptor.ref, 'quote.accept', { quoteId: sent.quoteId })).rejects.toMatchObject({ code: 'NEW_BUSINESS_PAUSED' });
    // …and whatever code tries without asking (IX098).
    await expect(sql`insert into trade_request (client_id, direction, fixed_side, requested_base_minor, bank_account_id, channel, created_by)
                     values (${w.clientId}, 'SELL_USDT', 'BASE', 1000000, ${w.bankAccountId}, 'OPERATOR', 'old-app')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX098');
    await expect(sql`update quote set status = 'SENT', sent_at = now(), expires_at = now() + interval '5 minutes', sent_by = 'old-app' where id = ${draft.quoteId}`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX098');

    // What is started goes on: the trade is paid out and completes.
    await ensureCounterpartyFunds(w, started.tradeId);
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: started.tradeId, amount: '9000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
    expect((await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() })).completed).toBe(true);

    expect((await operationsStatus(w.app)).newBusiness.paused).toBe(true);
    expect(prometheusText(await operationsStatus(w.app))).toContain('inrp2p_new_business_paused 1');

    // Resumed on the record: the quote sent before the pause can be accepted again while it is still valid.
    await expect(pause(w.financeOp, false, 'short')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await pause(w.owner, false, 'the bank confirmed service is restored');
    const accepted = await runAs(w.app, acceptQuote(w.acceptor.actor, w.deps), w.acceptor.ref, 'quote.accept', { quoteId: sent.quoteId });
    expect(accepted.tradeId).toBeTruthy();
    const audit = await w.app.selectFrom('audit_event').select('action').where('action', 'in', ['settings.new_business_paused', 'settings.new_business_resumed']).orderBy('seq').execute();
    expect(audit.map((a) => a.action)).toEqual(['settings.new_business_paused', 'settings.new_business_resumed']);
  });
});

describe('the health picture (E3)', () => {
  it('tells a stopped worker, money and liquidity apart', async () => {
    const before = await systemHealth(w.app);
    const heartbeat = before.checks.find((c) => c.id === 'worker_heartbeat_age_seconds')!;
    // No worker has ever reported in this database: a very long silence, an alarm.
    expect(heartbeat).toMatchObject({ group: 'infrastructure', state: 'alarm', runbook: 'worker-stopped' });
    await recordHeartbeat(w.t.worker, { workerId: 'test-worker-1', startedAt: new Date(), release: 'test', config: { chain: 'DISABLED', email: 'fake-email' } });
    const after = await operationsStatus(w.app);
    expect(after.checks.find((c) => c.id === 'worker_heartbeat_age_seconds')).toMatchObject({ state: 'ok' });
    expect(after.workers).toEqual([expect.objectContaining({ workerId: 'test-worker-1', release: 'test', config: { chain: 'DISABLED', email: 'fake-email' } })]);

    // No trader is ready on either side: liquidity says so, and readiness does not care.
    const liquidity = after.checks.filter((c) => c.group === 'liquidity');
    expect(liquidity.map((c) => [c.id, c.value, c.state])).toEqual([['traders_ready_sell_usdt', 0, 'warn'], ['traders_ready_buy_usdt', 0, 'warn']]);
    expect(after.liquidity).toBe('warn');
    expect(after.checks.filter((c) => c.group !== 'liquidity').some((c) => c.state === 'warn' || c.state === 'alarm') ? after.state : 'ok').toBe(after.state);
    expect(after.checks.find((c) => c.id === 'db_connections_percent')!.value).toBeGreaterThan(0);
    const text = prometheusText(after);
    expect(text).toMatch(/^inrp2p_health_state\{check="worker_heartbeat_age_seconds",group="infrastructure",runbook="worker-stopped"\} 0$/m);
    expect(text).toMatch(/^inrp2p_liquidity 1$/m);
  });
});
