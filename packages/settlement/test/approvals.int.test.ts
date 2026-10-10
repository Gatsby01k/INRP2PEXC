import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import {
  confirmPayout, createPayoutLeg, payoutApprovalPolicy, recordLegEvidence, sendPayoutLeg, setPayoutApprovalPolicy,
} from '../src/index.ts';
import { createStaleSettlementOperator, createWorld, deliverCounterparty, newUtr, observe, openTrade, settleFirstLeg, type World } from './world.ts';

/**
 * C1 (SECURITY §4): above ₹2,500,000 per leg the person who marked a payout sent does not confirm it. The sender and
 * the confirmer come from the verified actor; the database refuses a confirmation that breaks the rule whatever code
 * writes it (IX090); the threshold is OWNER's to move or switch off, on the record.
 */
let w: World;
beforeAll(async () => { w = await createWorld('payout_approvals', { capacityInr: '500000000.00' }); });
afterAll(async () => w.close());

async function fundedSellTrade(baseUsdt: string) {
  const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt, clientRate: '102.000000', routeRate: '104.200000' });
  await settleFirstLeg(w, trade.tradeId);
  await deliverCounterparty(w, trade.tradeId);
  return trade;
}

/** Created, sent and referenced by `by` — the person who may not confirm it above the threshold. */
async function sentInrLeg(tradeId: string, amount: string, by: TestOperator = w.settlementOp) {
  const leg = await runAs(w.app, createPayoutLeg(by.actor, {}), by.ref, 'payout_leg.create', { tradeId, amount, payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
  await runAs(w.app, sendPayoutLeg(by.actor), by.ref, 'payout_leg.send', { legId: leg.legId });
  await runAs(w.app, recordLegEvidence(by.actor, w.settlementDeps), by.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
  return leg;
}

const confirmBy = (who: TestOperator, legId: string, key: string = randomUUID()) => confirmPayout(w.app, who.actor, w.settlementDeps, { legId, idempotencyKey: key });
const people = async (legId: string) => w.app.selectFrom('settlement_leg').select(['sent_by', 'confirmed_by', 'status']).where('id', '=', legId).executeTakeFirstOrThrow();

describe('a large payout is confirmed by a second person (C1)', () => {
  it('below and exactly at ₹2,500,000 the sender may confirm; a paisa above, only someone else can', async () => {
    const trade = await fundedSellTrade('100000'); // ₹10,200,000 owed to the client
    const below = await sentInrLeg(trade.tradeId, '2499999.99');
    await confirmBy(w.settlementOp, below.legId);
    const at = await sentInrLeg(trade.tradeId, '2500000.00');
    await confirmBy(w.settlementOp, at.legId);
    expect(await people(at.legId)).toEqual({ sent_by: w.settlementOp.ref.id, confirmed_by: w.settlementOp.ref.id, status: 'COMPLETED' });

    const above = await sentInrLeg(trade.tradeId, '2500000.01');
    await expect(confirmBy(w.settlementOp, above.legId)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    // Someone else, but without a fresh step-up, or without the permission: still no.
    await expect(confirmBy(await createStaleSettlementOperator(w), above.legId)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(confirmBy(w.financeOp, above.legId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await people(above.legId)).status).toBe('PROCESSING');

    const key = randomUUID();
    const done = await confirmBy(w.settlementOp2, above.legId, key);
    expect(await people(above.legId)).toEqual({ sent_by: w.settlementOp.ref.id, confirmed_by: w.settlementOp2.ref.id, status: 'COMPLETED' });
    // The same intent retried returns what it returned, and posts nothing again.
    const journals = async () => (await w.app.selectFrom('ledger_journal').select('id').where('trade_id', '=', trade.tradeId).execute()).length;
    const before = await journals();
    expect(await confirmBy(w.settlementOp2, above.legId, key)).toEqual(done);
    expect(await journals()).toBe(before);
    const audit = await w.app.selectFrom('audit_event').select('after').where('entity_id', '=', above.legId).where('action', '=', 'leg.confirmed').executeTakeFirstOrThrow();
    expect(audit.after).toMatchObject({ sent_by: w.settlementOp.ref.id, confirmed_by: w.settlementOp2.ref.id });
  });

  it('two people confirming at once: exactly one confirmation', async () => {
    const trade = await fundedSellTrade('30000'); // ₹3,060,000
    const leg = await sentInrLeg(trade.tradeId, '3060000.00');
    const results = await Promise.allSettled([confirmBy(w.settlementOp2, leg.legId), confirmBy(w.owner, leg.legId)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('a USDT payout is measured in INR at its trade’s frozen client rate', async () => {
    const hot = await w.app.selectFrom('treasury_wallet').select('address').where('id', '=', w.treasuryWalletId).executeTakeFirstOrThrow();
    const usdtLeg = async (baseUsdt: string) => {
      const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt, clientRate: '106.000000', routeRate: '104.200000' });
      await settleFirstLeg(w, trade.tradeId);
      await deliverCounterparty(w, trade.tradeId);
      const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: baseUsdt, payer: 'EXCHANGE_ACCOUNT' as const, treasuryWalletId: w.treasuryWalletId });
      await observe(w, hot.address);
      await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
      const client = await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow();
      const tx = w.chain.add({ from: hot.address, to: client.address, amountMinor: Money.parse(baseUsdt, 'USDT').minor });
      await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, txHash: tx.txHash });
      return leg;
    };
    const small = await usdtLeg('23584.905660'); // × ₹106 = ₹2,499,999.99996: not above
    await confirmBy(w.settlementOp, small.legId);
    const large = await usdtLeg('23584.905661'); // × ₹106 = ₹2,500,000.000066: above
    await expect(confirmBy(w.settlementOp, large.legId)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await confirmBy(w.settlementOp2, large.legId);
  });

  it('the database refuses a confirmation that breaks the rule, whatever code writes it (IX090)', async () => {
    const trade = await fundedSellTrade('30000');
    const leg = await sentInrLeg(trade.tradeId, '3000000.00');
    const complete = (by: string) => sql`update settlement_leg set status = 'COMPLETED', confirmed_at = now(), confirmed_by = ${by} where id = ${leg.legId}`.execute(w.app);
    await expect(complete(w.settlementOp.ref.id!)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
    await expect(complete('SYSTEM:payout_leg.confirm')).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
    await expect(sql`update settlement_leg set status = 'COMPLETED', confirmed_at = now() where id = ${leg.legId}`.execute(w.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
    await expect(sql`update settlement_leg set sent_by = ${w.settlementOp2.ref.id} where id = ${leg.legId}`.execute(w.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
    // Sending names its sender.
    const unsent = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: trade.tradeId, amount: '10000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    await expect(sql`update settlement_leg set status = 'PROCESSING', sent_at = now() where id = ${unsent.legId}`.execute(w.app)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX090');
  });

  it('a leg sent before its sender was recorded is confirmed by someone other than its creator — nobody is invented', async () => {
    const trade = await fundedSellTrade('30000');
    const leg = await sentInrLeg(trade.tradeId, '3000000.00');
    // What a leg already in flight at migration 0027 looks like: no sender on record.
    await sql`set session_replication_role = replica`.execute(w.t.owner);
    try {
      await sql`update settlement_leg set sent_by = null where id = ${leg.legId}`.execute(w.t.owner);
    } finally {
      await sql`set session_replication_role = default`.execute(w.t.owner);
    }
    await expect(confirmBy(w.settlementOp, leg.legId)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await confirmBy(w.settlementOp2, leg.legId);
    expect(await people(leg.legId)).toEqual({ sent_by: null, confirmed_by: w.settlementOp2.ref.id, status: 'COMPLETED' });
  });

  it('the threshold is the OWNER’s to move or switch off, with a reason, on the record', async () => {
    const set = (who: TestOperator, payload: { enabled: boolean; threshold: string; reason: string }) => runAs(w.app, setPayoutApprovalPolicy(who.actor), who.ref, 'settings.payout_approval', payload);
    await expect(set(w.settlementOp, { enabled: false, threshold: '2500000.00', reason: 'single-person desk this week' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(set(w.owner, { enabled: false, threshold: '2500000.00', reason: 'short' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await set(w.owner, { enabled: false, threshold: '2500000.00', reason: 'single-person desk this week' });
    expect(await payoutApprovalPolicy(w.app)).toMatchObject({ enabled: false, threshold: '2500000.00', setBy: w.owner.ref.id });

    const trade = await fundedSellTrade('30000');
    const leg = await sentInrLeg(trade.tradeId, '3000000.00');
    await confirmBy(w.settlementOp, leg.legId); // switched off: the sender may confirm

    await set(w.owner, { enabled: true, threshold: '1000000.00', reason: 'second person back on the desk' });
    const history = await w.app.selectFrom('payout_approval_policy').select(['enabled', 'threshold_inr_minor', 'set_by']).orderBy('set_at').orderBy('id').execute();
    expect(history.map((h) => [h.enabled, h.threshold_inr_minor])).toEqual([[true, 250000000n], [false, 250000000n], [true, 100000000n]]);
    const audits = await w.app.selectFrom('audit_event').select('after').where('action', '=', 'settings.payout_approval_changed').orderBy('seq').execute();
    expect(audits.map((a) => (a.after as { enabled: boolean }).enabled)).toEqual([false, true]);
    await expect(sql`delete from payout_approval_policy`.execute(w.app)).rejects.toThrow();
    await set(w.owner, { enabled: true, threshold: '2500000.00', reason: 'back to the SECURITY §4 default' });
  });
});
