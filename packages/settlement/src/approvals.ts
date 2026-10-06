import { sql } from 'kysely';
import { DomainError, Money, requireText } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { newBusinessState } from '@inrp2p/trades';

/**
 * The payout second-person rule (SECURITY §4, production task C1): above a threshold — ₹2,500,000 per leg by default,
 * a USDT leg valued at its trade's frozen client rate — the person who marked a payout sent does not confirm it. The
 * threshold is a protected setting: OWNER only, with step-up, a reason, and an append-only history.
 */
export interface PayoutApprovalPolicy {
  readonly enabled: boolean;
  readonly threshold: string;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

export async function payoutApprovalPolicy(ex: Executor): Promise<PayoutApprovalPolicy> {
  const p = await ex.selectFrom('payout_approval_policy').selectAll().orderBy('set_at', 'desc').orderBy('id', 'desc').executeTakeFirstOrThrow();
  return { enabled: p.enabled, threshold: Money.ofMinor(p.threshold_inr_minor, 'INR').toDecimalString(), reason: p.reason, setBy: p.set_by, setAt: p.set_at.toISOString() };
}

/** Whether confirming this leg needs someone other than its sender — the same function the database enforces. */
export async function payoutNeedsSecondPerson(ex: Executor, leg: { trade_id: string; asset: string; amount_minor: bigint }): Promise<boolean> {
  const r = await sql<{ needs: boolean }>`select inrp2p_payout_needs_second_person(${leg.trade_id}::uuid, ${leg.asset}, ${leg.amount_minor}::bigint) as needs`.execute(ex);
  return r.rows[0]!.needs;
}

/**
 * `settings.payout_approval` — `settings:payout_approval` (OWNER, ⧗). Turns the rule on or off, or moves the threshold;
 * a single-person desk runs V1 by switching it off here, on the record (SECURITY §4).
 */
export function setPayoutApprovalPolicy(actor: OperatorActor) {
  return operatorCommand(actor, 'settings:payout_approval', async (ctx, p: { enabled: boolean; threshold: string; reason: string }) => {
    if (typeof p.enabled !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'say whether the rule is on');
    const threshold = Money.parse(p.threshold, 'INR');
    if (threshold.minor < 0n) throw new DomainError('INVALID_AMOUNT', 'the threshold cannot be negative');
    const reason = requireText(p.reason, 'reason', 500);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why (at least 10 characters)');
    const before = await payoutApprovalPolicy(ctx.tx);
    await ctx.tx
      .insertInto('payout_approval_policy')
      .values({ enabled: p.enabled, threshold_inr_minor: threshold.minor, reason, set_by: ctx.actor.id ?? 'SYSTEM' })
      .execute();
    await appendAudit(ctx, {
      action: 'settings.payout_approval_changed', entityType: 'payout_approval_policy', entityId: null,
      before: { enabled: before.enabled, threshold: before.threshold },
      after: { enabled: p.enabled, threshold: threshold.toDecimalString(), reason },
    });
    return payoutApprovalPolicy(ctx.tx);
  });
}

/**
 * `settings.pause_new_business` / `settings.resume_new_business` — `settings:new_business` (OWNER or FINANCE, ⧗), with
 * the reason (migration 0033, RUNBOOKS `pause-new-business`). Pausing stops new requests, quotes, acceptances and
 * trader offers, in the commands and in the database; it never touches what is already started, so every confirmed
 * movement keeps its obligation and settles as usual. Each change is a new row and an audit event.
 */
export function setNewBusiness(actor: OperatorActor) {
  return operatorCommand(actor, 'settings:new_business', async (ctx, p: { paused: boolean; reason: string }) => {
    if (typeof p.paused !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'say whether new business is paused');
    const reason = requireText(p.reason, 'reason', 500);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why (at least 10 characters)');
    const before = await newBusinessState(ctx.tx);
    if (before.paused === p.paused) throw new DomainError('INVALID_TRANSITION', p.paused ? 'new business is already paused' : 'new business is already open');
    await ctx.tx.insertInto('trading_control').values({ new_business: p.paused ? 'PAUSED' : 'OPEN', reason, set_by: actor.userId }).execute();
    await appendAudit(ctx, {
      action: p.paused ? 'settings.new_business_paused' : 'settings.new_business_resumed', entityType: 'trading_control', entityId: null,
      before: { paused: before.paused }, after: { paused: p.paused, reason },
    });
    return newBusinessState(ctx.tx);
  });
}

