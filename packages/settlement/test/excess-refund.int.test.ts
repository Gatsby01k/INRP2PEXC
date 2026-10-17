import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Money } from '@inrp2p/kernel';
import { pgErrorCode } from '@inrp2p/db';
import { runAs } from '@inrp2p/identity/testing';
import {
  confirmFirstLeg, confirmPayout, confirmRefundLeg, createPayoutLeg, createRefundLeg, openException, recordIncomingFiat, recordLegEvidence,
  refundAndCancel, refundExcess, sendPayoutLeg,
} from '../src/index.ts';
import { balanceOf, clientDepositAddressOf, createWorld, deliverCounterparty, newUtr, observe, openTrade, seeOwnSender, settleFirstLeg, type World } from './world.ts';

/**
 * D2 (TD-19): an overpayment is returned — at most what arrived beyond the receivable, to a verified destination of
 * the client — and the trade goes on; it completes only once the excess is confirmed back (FI-21).
 */
let w: World;
let sourceWalletId: string;
beforeAll(async () => {
  w = await createWorld('excess_refund', { capacityInr: '500000000.00' });
  sourceWalletId = (await w.app.selectFrom('crypto_wallet').select('id').where('address', '=', w.clientSourceAddress).executeTakeFirstOrThrow()).id;
});
afterAll(async () => w.close());

const usdt = (v: string) => Money.parse(v, 'USDT').minor;
const stateOf = async (tradeId: string) => (await w.app.selectFrom('trade').select(['lifecycle_state', 'hold']).where('id', '=', tradeId).executeTakeFirstOrThrow());

async function overpaidSell(base = '100', sent = '105') {
  const trade = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: base, clientRate: '102.000000', routeRate: '104.200000' });
  await settleFirstLeg(w, trade.tradeId, { amountUsdt: sent });
  const overpayment = await w.app.selectFrom('exception_case').select('id').where('trade_id', '=', trade.tradeId).where('type', '=', 'USDT_OVERPAYMENT').executeTakeFirstOrThrow();
  const deposit = await clientDepositAddressOf(w, trade.tradeId);
  return { ...trade, caseId: overpayment.id, deposit };
}

async function confirmExcessOnChain(legId: string, from: string, amount: string) {
  const tx = w.chain.add({ from, to: w.clientSourceAddress, amountMinor: usdt(amount) });
  return runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId, txHash: tx.txHash });
}

describe('an overpayment is returned and the trade goes on (D2)', () => {
  it('returns the excess to a registered sending wallet; the trade completes only once it is back', async () => {
    const t = await overpaidSell();
    expect(await stateOf(t.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_DETECTED', hold: true });
    await observe(w, t.deposit.address);
    const excess = (extra: Record<string, unknown>) => runAs(w.app, refundExcess(w.settlementOp.actor), w.settlementOp.ref, 'trade.refund_excess', {
      tradeId: t.tradeId, sourceDepositAddressId: t.deposit.id, destinationWalletId: sourceWalletId, ...extra,
    });
    await expect(excess({ amount: '5.000001' })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    // Not to a wallet the client registered only for receiving — never simply back to wherever it came from.
    await expect(excess({ destinationWalletId: w.walletId })).rejects.toMatchObject({ code: 'DESTINATION_INVALID' });

    const planned = await excess({ exceptionId: t.caseId });
    expect(planned.amount).toBe('5.000000');
    const leg = await w.app.selectFrom('settlement_leg').select(['refund_kind', 'destination_wallet_id', 'status']).where('id', '=', planned.legId).executeTakeFirstOrThrow();
    expect(leg).toEqual({ refund_kind: 'EXCESS', destination_wallet_id: sourceWalletId, status: 'PENDING' });
    // The excess is on its way back: the case is answered and the trade is payable.
    expect(await stateOf(t.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_CONFIRMED', hold: false });
    expect((await w.app.selectFrom('exception_case').select('resolution_command').where('id', '=', t.caseId).executeTakeFirstOrThrow()).resolution_command).toBe('refund_excess');
    await expect(excess({})).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    // The client is paid in full — and the trade still waits for the excess to reach them.
    await deliverCounterparty(w, t.tradeId);
    const payout = await runAs(w.app, createPayoutLeg(w.settlementOp.actor, {}), w.settlementOp.ref, 'payout_leg.create', { tradeId: t.tradeId, amount: '10200.00', payer: 'EXCHANGE_ACCOUNT' as const, inrAccountId: w.inrAccountId });
    await runAs(w.app, sendPayoutLeg(w.settlementOp.actor), w.settlementOp.ref, 'payout_leg.send', { legId: payout.legId });
    await runAs(w.app, recordLegEvidence(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'payout_leg.record_evidence', { legId: payout.legId, rail: 'IMPS' as const, utr: newUtr() });
    const paid = await confirmPayout(w.app, w.settlementOp.actor, w.settlementDeps, { legId: payout.legId, idempotencyKey: randomUUID() });
    expect(paid.completed).toBe(false);
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('PARTIALLY_SETTLED');
    await expect(sql`update trade set lifecycle_state = 'COMPLETED', completed_at = now() where id = ${t.tradeId}`.execute(w.t.owner)).rejects.toSatisfy((e) => pgErrorCode(e) === 'IX021');

    // Confirmed back by someone with refund:approve who did not plan it, to the wallet it names — and only then is
    // the trade done.
    await expect(runAs(w.app, confirmRefundLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'refund_leg.confirm', { legId: planned.legId, txHash: 'ab'.repeat(32) }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    const wrongWallet = w.chain.add({ from: t.deposit.address, to: (await w.app.selectFrom('crypto_wallet').select('address').where('id', '=', w.walletId).executeTakeFirstOrThrow()).address, amountMinor: usdt('5') });
    await expect(runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId: planned.legId, txHash: wrongWallet.txHash }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await confirmExcessOnChain(planned.legId, t.deposit.address, '5');
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('COMPLETED');
    expect(await balanceOf(w.app, 'ASSET:CLIENT_RECEIVABLE', 'USDT', { tradeId: t.tradeId })).toBe(0n);
  });

  it('never returns more than arrived beyond the receivable, whatever code writes it (IX093)', async () => {
    const t = await overpaidSell('50', '52');
    await expect(sql`insert into settlement_leg (trade_id, seq, ref, side, asset, amount_minor, payer, treasury_wallet_id, destination_wallet_id, refund_kind, created_by)
                     values (${t.tradeId}, 95, 'x', 'REFUND_TO_CLIENT', 'USDT', ${usdt('3')}, 'EXCHANGE_ACCOUNT', ${w.treasuryWalletId}, ${sourceWalletId}, 'EXCESS', 'old-app')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === 'IX093');
    await expect(sql`insert into settlement_leg (trade_id, seq, ref, side, asset, amount_minor, payer, treasury_wallet_id, refund_kind, created_by)
                     values (${t.tradeId}, 96, 'y', 'REFUND_TO_CLIENT', 'USDT', ${usdt('1')}, 'EXCHANGE_ACCOUNT', ${w.treasuryWalletId}, 'EXCESS', 'old-app')`.execute(w.t.owner))
      .rejects.toSatisfy((e) => pgErrorCode(e) === '23514'); // an excess refund names where it goes
    const exact = await openTrade(w, { executionMode: 'TO_EXCHANGE', baseUsdt: '10', clientRate: '102.000000', routeRate: '104.200000' });
    await settleFirstLeg(w, exact.tradeId);
    await expect(runAs(w.app, refundExcess(w.settlementOp.actor), w.settlementOp.ref, 'trade.refund_excess', { tradeId: exact.tradeId, sourceDepositAddressId: (await clientDepositAddressOf(w, exact.tradeId)).id, destinationWalletId: sourceWalletId }))
      .rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('is not mixed with an unwind: the unwind returns the rest, and the trade is cancelled with everything back', async () => {
    const t = await overpaidSell('20', '21');
    await observe(w, t.deposit.address);
    const excess = await runAs(w.app, refundExcess(w.settlementOp.actor), w.settlementOp.ref, 'trade.refund_excess', { tradeId: t.tradeId, sourceDepositAddressId: t.deposit.id, destinationWalletId: sourceWalletId, exceptionId: t.caseId });
    const opened = await runAs(w.app, openException(w.dealer.actor), w.dealer.ref, 'exception.open', { type: 'TRADE_CANCELLATION' as const, subjectType: 'TRADE' as const, subjectId: t.tradeId, tradeId: t.tradeId, notes: 'client changed their mind' });
    await observe(w, t.deposit.address);
    const unwind = await runAs(w.app, createRefundLeg(w.owner.actor), w.owner.ref, 'refund_leg.create', { tradeId: t.tradeId, sourceDepositAddressId: t.deposit.id });
    expect(unwind.amount).toBe('20.000000');
    // An excess cannot be planned on top of an unwind.
    await expect(runAs(w.app, refundExcess(w.settlementOp.actor), w.settlementOp.ref, 'trade.refund_excess', { tradeId: t.tradeId, sourceDepositAddressId: t.deposit.id, destinationWalletId: sourceWalletId }))
      .rejects.toMatchObject({ code: 'REFUND_IN_PROGRESS' });
    await confirmExcessOnChain(excess.legId, t.deposit.address, '1');
    await confirmExcessOnChain(unwind.legId, t.deposit.address, '20');
    await runAs(w.app, refundAndCancel(w.owner.actor), w.owner.ref, 'exception.refund_and_cancel', { tradeId: t.tradeId, exceptionId: opened.exceptionId, reason: 'everything back with the client' });
    expect((await stateOf(t.tradeId)).lifecycle_state).toBe('CANCELLED');
  });

  it('returns an INR overpayment to a verified bank account of the client, from where the INR arrived', async () => {
    const trade = await openTrade(w, { direction: 'BUY_USDT', executionMode: 'TO_EXCHANGE', baseUsdt: '100', clientRate: '106.000000', routeRate: '104.200000' });
    const recorded = await runAs(w.app, recordIncomingFiat(w.settlementOp.actor), w.settlementOp.ref, 'fiat_in.record', {
      tradeId: trade.tradeId, rail: 'IMPS' as const, utr: newUtr('IN'), amount: '10700.00', inrAccountId: w.inrAccountId,
    });
    await seeOwnSender(w.app, w.settlementOp, { legId: recorded.legId });
    await runAs(w.app, confirmFirstLeg(w.settlementOp.actor, w.settlementDeps), w.settlementOp.ref, 'settlement.confirm_incoming', { legId: recorded.legId });
    expect((await stateOf(trade.tradeId)).hold).toBe(true);
    const planned = await runAs(w.app, refundExcess(w.settlementOp.actor), w.settlementOp.ref, 'trade.refund_excess', {
      tradeId: trade.tradeId, inrAccountId: w.inrAccountId, destinationBankAccountId: w.bankAccountId,
      exceptionId: (await w.app.selectFrom('exception_case').select('id').where('trade_id', '=', trade.tradeId).where('type', '=', 'USDT_OVERPAYMENT').executeTakeFirstOrThrow()).id,
    });
    expect(planned.amount).toBe('100.00');
    expect(await stateOf(trade.tradeId)).toEqual({ lifecycle_state: 'FIRST_LEG_CONFIRMED', hold: false });
    await runAs(w.app, confirmRefundLeg(w.financeOp.actor, w.settlementDeps), w.financeOp.ref, 'refund_leg.confirm', { legId: planned.legId, rail: 'IMPS' as const, utr: newUtr('RF') });
    const earmark = await w.app.selectFrom('funding_allocation').select(['source_kind', 'status', 'location']).where('use_leg_id', '=', planned.legId).executeTakeFirstOrThrow();
    expect(earmark).toEqual({ source_kind: 'CLIENT_FUNDS', status: 'CONSUMED', location: `INR:${w.inrAccountId}` });
  });
});
