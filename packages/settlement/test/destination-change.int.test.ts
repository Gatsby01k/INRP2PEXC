import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { pgErrorCode } from '@inrp2p/db';
import { runAs, type TestOperator } from '@inrp2p/identity/testing';
import { addBankAccount, archiveBankAccount, createClient } from '@inrp2p/clients';
import {
  approveDestinationChange, cancelDestinationChange, confirmPayout, createPayoutLeg, failPayoutLeg, openDestinationChangedCases, recordLegEvidence,
  rejectDestinationChange, requestDestinationChange, resolveException, sendPayoutLeg, tradePayoutDestination,
} from '../src/index.ts';
import { createStaleSettlementOperator, createWorld, deliverCounterparty, newUtr, openTrade, settleFirstLeg, type World } from './world.ts';

/**
 * D1 (TD-18): an open trade whose client replaced their bank account pays the new one — on the record, with two
 * people, to a verified account of the same client — instead of being unwound. `trade_economics` never changes.
 */
let w: World;
beforeAll(async () => { w = await createWorld('destination_change', { capacityInr: '500000000.00' }); });
afterAll(async () => w.close());

let accountSeq = 7_700_000_000;
async function newBankAccount(clientId = w.clientId): Promise<string> {
  const r = await runAs(w.app, addBankAccount(w.owner.actor, w.deps.protector), w.owner.ref, 'client_bank.add', {
    clientId, holderName: 'Acme Pay Private Limited', bankName: 'Axis Bank', ifsc: 'UTIB0000123', accountNumber: String(accountSeq++), railPreferences: ['IMPS', 'NEFT'] as const,
  });
  return r.bankAccountId;
}

/** A funded SELL trade, paying an account of its own, whose route delivered. */
async function tradeWithArchivedDestination(baseUsdt = '1000') {
  const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt, clientRate: '102.000000', routeRate: '104.200000', bankAccountId: await newBankAccount() });
  await settleFirstLeg(w, trade.tradeId);
  await deliverCounterparty(w, trade.tradeId);
  const old = (await w.app.selectFrom('trade_economics').select('bank_account_id').where('trade_id', '=', trade.tradeId).executeTakeFirstOrThrow()).bank_account_id!;
  return { ...trade, old };
}

async function archive(bankAccountId: string) {
  await runAs(w.app, archiveBankAccount(w.owner.actor), w.owner.ref, 'client_bank.archive', { bankAccountId, reason: 'client closed this account' });
  await openDestinationChangedCases(w.app, { eventId: randomUUID(), destination: 'BANK_ACCOUNT', destinationId: bankAccountId });
}

const request = (who: TestOperator, tradeId: string, toBankAccountId: string, extra: Record<string, unknown> = {}) =>
  runAs(w.app, requestDestinationChange(who.actor), who.ref, 'trade.request_destination_change', {
    tradeId, toBankAccountId, reason: 'client replaced their payout account', evidence: 'client admin added it with an authenticator code; confirmed on a call to the number on file', ...extra,
  });
const approve = (who: TestOperator, requestId: string) => runAs(w.app, approveDestinationChange(who.actor), who.ref, 'trade.approve_destination_change', { requestId });

describe('a changed destination for an open trade (D1)', () => {
  it('is requested by one person, approved by another, and the trade then pays the new account', async () => {
    const t = await tradeWithArchivedDestination();
    // The account is archived: the trade is held and its payout refused, as before.
    await archive(t.old);
    const held = await w.app.selectFrom('trade').select('hold').where('id', '=', t.tradeId).executeTakeFirstOrThrow();
    expect(held.hold).toBe(true);
    const fresh = await newBankAccount();

    // Not to another client's account, not to an archived one, not without a fresh step-up.
    const stranger = await runAs(w.app, createClient(w.dealer.actor), w.dealer.ref, 'client.create', { legalName: 'Other Co Private Limited', displayName: 'Other Co', type: 'COMPANY' as const });
    await expect(request(w.financeOp, t.tradeId, await newBankAccount(stranger.clientId))).rejects.toMatchObject({ code: 'DESTINATION_INVALID' });
    await expect(request(w.financeOp, t.tradeId, t.old)).rejects.toMatchObject({ code: 'DESTINATION_INVALID' });
    await expect(request(await createStaleSettlementOperator(w), t.tradeId, fresh)).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });

    const asked = await request(w.financeOp, t.tradeId, fresh);
    expect(asked.ref).toMatch(/^DC-\d{4,}$/);
    // Nothing changes until someone else approves it — not the requester, not a role without the permission.
    expect((await tradePayoutDestination(w.app, t.tradeId)).bankAccountId).toBe(t.old);
    await expect(approve(w.financeOp, asked.requestId)).rejects.toMatchObject({ code: 'SECOND_APPROVER_REQUIRED' });
    await expect(approve(w.settlementOp, asked.requestId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(approve(w.dealer, asked.requestId)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const done = await approve(w.financeOp2, asked.requestId);
    expect(done).toMatchObject({ ref: asked.ref, legsCancelled: 0 });
    // The economics are as accepted; the destination in force is the new account.
    expect((await w.app.selectFrom('trade_economics').select('bank_account_id').where('trade_id', '=', t.tradeId).executeTakeFirstOrThrow()).bank_account_id).toBe(t.old);
    expect((await tradePayoutDestination(w.app, t.tradeId)).bankAccountId).toBe(fresh);
    const trade = await w.app.selectFrom('trade').select('hold').where('id', '=', t.tradeId).executeTakeFirstOrThrow();
    expect(trade.hold).toBe(false);
    const cases = await w.app.selectFrom('exception_case').select(['status', 'resolution_command']).where('trade_id', '=', t.tradeId).where('type', '=', 'CLIENT_BANK_CHANGED').execute();
    expect(cases).toEqual([{ status: 'RESOLVED', resolution_command: 'confirm_new_destination' }]);
    const told = await w.app.selectFrom('outbox_event').select('type').where('aggregate_id', '=', t.tradeId).where('type', '=', 'client.trade_destination_changed').execute();
    expect(told).toHaveLength(1);

    // The payout goes to the new account — and the database would refuse one to the old account.
    const leg = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: t.tradeId, amount: '102000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    expect((await w.app.selectFrom('settlement_leg').select('destination_bank_account_id').where('id', '=', leg.legId).executeTakeFirstOrThrow()).destination_bank_account_id).toBe(fresh);
    await expect(sql`insert into settlement_leg (trade_id, seq, ref, side, asset, amount_minor, payer, inr_account_id, destination_bank_account_id, created_by)
                     values (${t.tradeId}, 91, 'x', 'EXCHANGE_TO_CLIENT', 'INR', 100, 'EXCHANGE_ACCOUNT', ${w.inrAccountId}, ${t.old}, 'old-app')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX092');
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: leg.legId });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: leg.legId, rail: 'IMPS' as const, utr: newUtr() });
    const paid = await confirmPayout(w.app, w.settlementOp2.actor, w.settlementDeps, { legId: leg.legId, idempotencyKey: randomUUID() });
    expect(paid.completed).toBe(true);
  });

  it('cancels a payout only planned to the old account, and waits while one was already sent to it', async () => {
    const t = await tradeWithArchivedDestination('500');
    const planned = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: t.tradeId, amount: '20000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    const sent = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: t.tradeId, amount: '10000.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: sent.legId });
    await archive(t.old);
    const fresh = await newBankAccount();
    const asked = await request(w.settlementOp, t.tradeId, fresh);
    await expect(approve(w.financeOp2, asked.requestId)).rejects.toMatchObject({ code: 'PAYOUT_IN_FLIGHT' });
    // The bank returned the payout to the closed account: it failed, so nothing reached anybody.
    await runAs(w.app, failPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.fail', { legId: sent.legId, reason: 'returned by the bank: account closed' });
    const done = await approve(w.financeOp2, asked.requestId);
    expect(done.legsCancelled).toBe(1);
    const leg = await w.app.selectFrom('settlement_leg').select(['status', 'capacity_reservation_id']).where('id', '=', planned.legId).executeTakeFirstOrThrow();
    expect(leg.status).toBe('CANCELLED');
    const reservation = await w.app.selectFrom('capacity_reservation').select('status').where('id', '=', leg.capacity_reservation_id!).executeTakeFirstOrThrow();
    expect(reservation.status).toBe('RELEASED');
    const earmarks = await w.app.selectFrom('funding_allocation').select('status').where('use_leg_id', '=', planned.legId).execute();
    expect(earmarks.map((e) => e.status)).toEqual(['RELEASED']);
  });

  it('is declined by someone else or withdrawn by the requester, and the database holds the rules', async () => {
    const t = await tradeWithArchivedDestination('50');
    await archive(t.old);
    const fresh = await newBankAccount();
    // The case is not closed as "new destination confirmed" by a click: only an approved change records that.
    const held = await w.app.selectFrom('exception_case').select('id').where('trade_id', '=', t.tradeId).where('type', '=', 'CLIENT_BANK_CHANGED').executeTakeFirstOrThrow();
    await expect(runAs(w.app, resolveException(w.settlementOp.actor), w.settlementOp.ref, 'exception.resolve', { exceptionId: held.id, resolution: 'confirm_new_destination' as never, notes: 'client says the new account is fine' }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const first = await request(w.settlementOp, t.tradeId, fresh);
    await expect(request(w.settlementOp2, t.tradeId, fresh)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await runAs(w.app, rejectDestinationChange(w.financeOp.actor), w.financeOp.ref, 'trade.reject_destination_change', { requestId: first.requestId, note: 'the client did not confirm this account' });
    const second = await request(w.settlementOp, t.tradeId, fresh);
    await expect(runAs(w.app, cancelDestinationChange(w.settlementOp2.actor), w.settlementOp2.ref, 'trade.cancel_destination_change', { requestId: second.requestId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await runAs(w.app, cancelDestinationChange(w.settlementOp.actor), w.settlementOp.ref, 'trade.cancel_destination_change', { requestId: second.requestId });
    expect((await tradePayoutDestination(w.app, t.tradeId)).bankAccountId).toBe(t.old);

    // Whatever code wrote it: approved by its own requester, or to an archived account — refused.
    const user = w.settlementOp.ref.id!;
    await expect(sql`insert into trade_destination_change (trade_id, from_bank_account_id, to_bank_account_id, reason, evidence, status, requested_by, decided_by, decided_at)
                     values (${t.tradeId}, ${t.old}, ${fresh}, 'client replaced their account', 'confirmed on a call', 'APPROVED', ${user}, ${user}, now())`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    await expect(sql`insert into trade_destination_change (trade_id, from_bank_account_id, to_bank_account_id, reason, evidence, requested_by)
                     values (${t.tradeId}, ${t.old}, ${t.old}, 'client replaced their account', 'confirmed on a call', ${user})`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX092');
  });
});
