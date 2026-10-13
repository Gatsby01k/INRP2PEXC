import { sql } from 'kysely';
import { DomainError, formatTrx, isDomainError } from '@inrp2p/kernel';
import type { CombinedOutcome } from '@inrp2p/adapters';
import { type Db, type TxContext, pgErrorCode } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { openExceptionInTx, settleSignedSendInTx } from '@inrp2p/settlement';
import { lockSend, recordSpent } from '@inrp2p/network';
import { broadcastAttempt } from './sender.ts';
import { type OnchainDeps, clockOf, policyOf, settlementDepsOf, step } from './deps.ts';

/**
 * The signer's following half (ADR 0017 §4): every signed attempt is followed until the chain decides it.
 *
 * - FINAL and successful in a solidified block → the attempt is CONFIRMED and what it paid settles in the same step
 *   (a top-up becomes the trade's spend of its budget; a USDT transfer its payout, refund or payment to the
 *   counterparty, verified like any transfer, FI-24).
 * - FINAL and failed (out of energy, reverted) → no USDT moved; the TRX it burned was already the trade's spend; the
 *   send is decided again (a new top-up, a new attempt) — up to a limit, then it waits for a person.
 * - Unknown everywhere and past its expiration on every provider's solidified head → provably never landed: EXPIRED,
 *   and only then may the send be signed again.
 * - Anything else — still pending, a provider unreachable, providers contradicting each other — changes nothing: the
 *   same bytes are broadcast again, and after a while a case tells the desk the send is stuck. It is never re-signed.
 */
export interface MonitorReport {
  readonly examined: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly expired: number;
  readonly rebroadcast: number;
  readonly pending: number;
  readonly unresolved: number;
  readonly failures: readonly { readonly txid: string; readonly code: string; readonly message: string }[];
}

export async function runMonitor(db: Db, deps: OnchainDeps): Promise<MonitorReport> {
  const policy = policyOf(deps);
  const report = { examined: 0, confirmed: 0, failed: 0, expired: 0, rebroadcast: 0, pending: 0, unresolved: 0, failures: [] as { txid: string; code: string; message: string }[] };
  const live = await sql<{ id: string; send_id: string; txid: string; expiration: Date; last_broadcast_at: Date | null; signed_at: Date; aged: boolean; stale: boolean }>`
    select a.id, a.send_id, a.txid, a.expiration, a.last_broadcast_at, a.signed_at,
           a.signed_at <= inrp2p_now() - make_interval(mins => ${policy.unresolvedAfterMinutes}) as aged,
           (a.last_broadcast_at is null or a.last_broadcast_at <= inrp2p_now() - make_interval(secs => ${policy.rebroadcastSeconds})) as stale
      from chain_send_attempt a
     where a.status in ('SIGNED', 'BROADCAST')
     order by a.signed_at limit ${policy.batch}`.execute(db);
  for (const a of live.rows) {
    report.examined += 1;
    try {
      const outcome = await deps.network.outcome(a.txid);
      if (outcome.status === 'FINAL') {
        if (await settleFinal(db, deps, a.id, outcome)) report.confirmed += 1;
        else report.failed += 1;
        continue;
      }
      if (outcome.status === 'NOT_FOUND' && clockOf(deps) > a.expiration.getTime() + policy.expiryMarginSeconds * 1000) {
        const proof = await deps.network.proveExpired(a.txid, a.expiration.getTime(), policy.expiryMarginSeconds * 1000);
        if (proof.proved) {
          await expire(db, a.id, proof.by);
          report.expired += 1;
          continue;
        }
      }
      if ((outcome.status === 'NOT_FOUND' || outcome.status === 'UNKNOWN') && a.stale && clockOf(deps) < a.expiration.getTime()) {
        await broadcastAttempt(db, deps, a.id);
        report.rebroadcast += 1;
      }
      if (outcome.status === 'PENDING') report.pending += 1;
      if (a.aged && outcome.status !== 'PENDING') {
        await unresolved(db, a.send_id, a.txid, outcome);
        report.unresolved += 1;
      }
    } catch (e) {
      report.failures.push({ txid: a.txid, code: isDomainError(e) ? e.code : (pgErrorCode(e) ?? 'UNEXPECTED'), message: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
    }
  }
  return report;
}

/** Records a final outcome and settles what it paid. Returns true when the transfer succeeded. */
async function settleFinal(db: Db, deps: OnchainDeps, attemptId: string, outcome: Extract<CombinedOutcome, { status: 'FINAL' }>): Promise<boolean> {
  const policy = policyOf(deps);
  const f = outcome.facts;
  return step(db, 'chain_send.settle', { attemptId, success: f.success }, async (ctx) => {
    const attempt = await ctx.tx.selectFrom('chain_send_attempt').selectAll().where('id', '=', attemptId).forUpdate().executeTakeFirstOrThrow();
    if (attempt.status !== 'SIGNED' && attempt.status !== 'BROADCAST') return attempt.status === 'CONFIRMED';
    const send = await ctx.tx.selectFrom('chain_send').selectAll().where('id', '=', attempt.send_id).executeTakeFirstOrThrow();
    await ctx.tx
      .updateTable('chain_send_attempt')
      .set({
        status: f.success ? 'CONFIRMED' : 'FAILED', block_number: f.blockNumber, block_time: f.blockTime, fee_sun: f.feeSun, energy_used: f.energyUsed,
        energy_fee_sun: f.energyFeeSun, net_fee_sun: f.netFeeSun, result: f.result.slice(0, 60), decided_at: sql<Date>`inrp2p_now()`, decided_by: outcome.agreedBy.join(',').slice(0, 300),
      })
      .where('id', '=', attempt.id)
      .execute();

    if (!f.success) {
      // Nothing moved but TRX was burned: the send is decided again from what the address now holds — unless it has
      // failed often enough that a person should look first.
      const failed = send.failed_attempts + 1;
      const blocked = failed >= policy.maxFailedAttempts;
      await ctx.tx
        .updateTable('chain_send')
        .set({
          status: blocked ? 'BLOCKED' : 'PLANNED', failed_attempts: failed, updated_at: sql<Date>`inrp2p_now()`,
          blocked_reason: blocked ? `${failed} transactions failed on chain (last: ${f.result}); look before it is tried again` : null,
          last_error: `transaction ${attempt.txid} failed on chain: ${f.result}`.slice(0, 500), last_error_at: sql<Date>`inrp2p_now()`,
        })
        .where('id', '=', send.id)
        .execute();
      await appendAudit(ctx, { action: 'chain_send.failed_on_chain', entityType: 'chain_send', entityId: send.id, after: { txid: attempt.txid, result: f.result, burned_trx: formatTrx(f.feeSun), failed_attempts: failed, blocked } });
      if (blocked) await openExceptionInTx(ctx, { type: 'CHAIN_SEND_UNRESOLVED', subjectType: 'CHAIN_SEND', subjectId: send.id, tradeId: send.trade_id, details: { ref: send.ref, reason: `${failed} failed transactions`, last_result: f.result } });
      return false;
    }

    if (send.purpose === 'TOPUP') {
      await recordSpent(ctx, { funder: send.funder_trader_id, tradeId: send.trade_id!, attemptId: attempt.id, amountSun: send.amount_minor + f.feeSun, note: `top-up ${send.ref}: ${formatTrx(send.amount_minor)} TRX sent, ${formatTrx(f.feeSun)} TRX burned` });
    } else if (send.purpose === 'DEPOSIT_WITHDRAWAL') {
      await ctx.tx.insertInto('network_budget_entry').values({
        trader_id: send.funder_trader_id, kind: 'WITHDRAWAL', amount_sun: -(send.amount_minor + f.feeSun), withdrawal_id: send.withdrawal_id, chain_send_attempt_id: attempt.id,
        posting_key: `withdrawal:${send.withdrawal_id}`, note: `withdrawn to ${send.to_address}`, created_by: `SYSTEM:${ctx.commandName}`,
      }).execute();
      await ctx.tx.updateTable('network_deposit_withdrawal').set({ status: 'COMPLETED', closed_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.withdrawal_id!).execute();
      await enqueueOutbox(ctx, { type: 'trader.network_withdrawal_completed', aggregateType: 'trader_profile', aggregateId: send.funder_trader_id!, payload: { traderId: send.funder_trader_id, withdrawalId: send.withdrawal_id } });
    } else {
      await settleSignedSendInTx(ctx, settlementDepsOf(deps), send.id);
    }
    const s = await lockSend(ctx, send.id);
    await ctx.tx.updateTable('chain_send').set({ status: 'CONFIRMED', closed_at: sql<Date>`inrp2p_now()`, updated_at: sql<Date>`inrp2p_now()` }).where('id', '=', s.id).execute();
    await appendAudit(ctx, {
      action: 'chain_send.confirmed', entityType: 'chain_send', entityId: send.id,
      after: { txid: attempt.txid, block: f.blockNumber.toString(), burned_trx: formatTrx(f.feeSun), energy_used: f.energyUsed.toString(), agreed_by: outcome.agreedBy, purpose: send.purpose },
    });
    await enqueueOutbox(ctx, { type: 'chain_send.confirmed', aggregateType: 'chain_send', aggregateId: send.id, payload: { sendId: send.id, tradeId: send.trade_id, purpose: send.purpose } });
    return true;
  });
}

/** The attempt provably never landed: it is closed, and the send may be signed again. */
async function expire(db: Db, attemptId: string, by: readonly string[]): Promise<void> {
  await step(db, 'chain_send.expire', { attemptId }, async (ctx) => {
    const attempt = await ctx.tx.selectFrom('chain_send_attempt').select(['id', 'send_id', 'status', 'txid']).where('id', '=', attemptId).forUpdate().executeTakeFirstOrThrow();
    if (attempt.status !== 'SIGNED' && attempt.status !== 'BROADCAST') return;
    await ctx.tx.updateTable('chain_send_attempt').set({ status: 'EXPIRED', decided_at: sql<Date>`inrp2p_now()`, decided_by: by.join(',').slice(0, 300) }).where('id', '=', attempt.id).execute();
    const send = await lockSend(ctx, attempt.send_id);
    if (send.status === 'SENDING') {
      await ctx.tx.updateTable('chain_send').set({ status: 'PLANNED', updated_at: sql<Date>`inrp2p_now()`, last_error: `transaction ${attempt.txid} expired unseen`, last_error_at: sql<Date>`inrp2p_now()` }).where('id', '=', send.id).execute();
    }
    await appendAudit(ctx, { action: 'chain_send.attempt_expired', entityType: 'chain_send', entityId: attempt.send_id, after: { txid: attempt.txid, proved_by: by } });
  });
}

async function unresolved(db: Db, sendId: string, txid: string, outcome: CombinedOutcome): Promise<void> {
  const reason = outcome.status === 'CONFLICT' || outcome.status === 'UNKNOWN' ? outcome.reason : `the chain does not know ${txid} yet`;
  await step(db, 'chain_send.unresolved', { sendId, txid }, async (ctx: TxContext) => {
    const send = await ctx.tx.selectFrom('chain_send').select(['id', 'ref', 'trade_id']).where('id', '=', sendId).executeTakeFirst();
    if (!send) throw new DomainError('NOT_FOUND', 'send not found');
    await openExceptionInTx(ctx, { type: 'CHAIN_SEND_UNRESOLVED', subjectType: 'CHAIN_SEND', subjectId: send.id, tradeId: send.trade_id, details: { ref: send.ref, txid, reason } });
  });
}
