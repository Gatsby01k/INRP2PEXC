import { sql } from 'kysely';
import { DomainError, Money, requireText, requireUuid } from '@inrp2p/kernel';
import type { Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { type OperatorActor, assertSecondApprover, operatorCommand } from '@inrp2p/identity';
import { type RestoreFenceState, holdOutgoingPayments, newBusinessState, restoreFenceState } from '@inrp2p/trades';

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

/**
 * `operations.raise_restore_fence` — `operations:restore_fence` (OWNER or FINANCE, ⧗), with the reason and, when known,
 * the moment the records are known whole (a recovery target). The worker raises the fence by itself when the database's
 * cluster or timeline changes; this is the restore procedure's first step where the platform hides that, and the way to
 * hold payments whenever someone knows records were lost (RUNBOOKS `restore-fence`). New business is paused with it.
 */
export function raiseRestoreFence(actor: OperatorActor) {
  return operatorCommand(actor, 'operations:restore_fence', async (ctx, p: { reason: string; knownUntil?: string | null }): Promise<RestoreFenceState> => {
    const reason = requireText(p.reason, 'reason', 500);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'say why (at least 10 characters)');
    let knownUntil: Date | null = null;
    if (p.knownUntil) {
      knownUntil = new Date(requireText(p.knownUntil, 'knownUntil', 40));
      if (Number.isNaN(knownUntil.getTime())) throw new DomainError('INVALID_ARGUMENT', 'knownUntil must be a date and time');
    }
    const fence = await holdOutgoingPayments(ctx.tx, { by: actor.userId, reason, knownUntil });
    if (!fence) throw new DomainError('INVALID_TRANSITION', 'outgoing payments are already held');
    await appendAudit(ctx, {
      action: 'operations.restore_fence_raised', entityType: 'restore_fence', entityId: fence.id,
      after: { ref: fence.ref, reason, known_until: knownUntil?.toISOString() ?? null, paused_new_business: fence.pausedNewBusiness },
    });
    return restoreFenceState(ctx.tx);
  });
}

/**
 * `operations.request_restore_fence_lift` — `operations:restore_fence` (⧗): records what was reconciled — every payment
 * out since the records were last known whole, against the bank and the chain, and what was found and recorded. Someone
 * else approves it; until then payments stay held.
 */
export function requestRestoreFenceLift(actor: OperatorActor) {
  return operatorCommand(actor, 'operations:restore_fence', async (ctx, p: { reconciliation: string }): Promise<RestoreFenceState> => {
    const reconciliation = requireText(p.reconciliation, 'reconciliation', 4000);
    if (reconciliation.length < 20) throw new DomainError('INVALID_ARGUMENT', 'say what was compared and what was found (at least 20 characters)');
    const fence = await ctx.tx.selectFrom('restore_fence').select(['id', 'ref']).where('status', '=', 'RAISED').forUpdate().executeTakeFirst();
    if (!fence) throw new DomainError('INVALID_TRANSITION', 'no restore fence is raised');
    const pending = await ctx.tx.selectFrom('restore_fence_lift').select('id').where('fence_id', '=', fence.id).where('status', '=', 'REQUESTED').executeTakeFirst();
    if (pending) throw new DomainError('INVALID_TRANSITION', `lifting ${fence.ref} is already waiting for a second person`);
    const lift = await ctx.tx.insertInto('restore_fence_lift').values({ fence_id: fence.id, reconciliation, requested_by: actor.userId }).returning('id').executeTakeFirstOrThrow();
    await appendAudit(ctx, { action: 'operations.restore_fence_lift_requested', entityType: 'restore_fence', entityId: fence.id, after: { ref: fence.ref, lift_id: lift.id, reconciliation } });
    return restoreFenceState(ctx.tx);
  });
}

/**
 * `operations.decide_restore_fence_lift` — `operations:approve_restore_fence_lift` (OWNER or FINANCE, ⧗✱): approves the
 * reconciliation and releases outgoing payments — never by the person who recorded it, in the command and in the database
 * (IX101) — or declines it, which the requester may also do to withdraw it. New business stays paused until someone
 * resumes it on its own control.
 */
export function decideRestoreFenceLift(actor: OperatorActor) {
  return operatorCommand(actor, 'operations:approve_restore_fence_lift', async (ctx, p: { liftId: string; approve: boolean; note?: string | null }, decision): Promise<RestoreFenceState> => {
    if (typeof p.approve !== 'boolean') throw new DomainError('INVALID_ARGUMENT', 'say whether the lift is approved');
    const liftId = requireUuid(p.liftId, 'liftId');
    const peek = await ctx.tx.selectFrom('restore_fence_lift').select('fence_id').where('id', '=', liftId).executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', 'restore fence lift not found');
    const fence = await ctx.tx.selectFrom('restore_fence').select(['id', 'ref', 'status']).where('id', '=', peek.fence_id).forUpdate().executeTakeFirstOrThrow();
    const lift = await ctx.tx.selectFrom('restore_fence_lift').select(['id', 'status', 'requested_by']).where('id', '=', liftId).forUpdate().executeTakeFirstOrThrow();
    if (lift.status !== 'REQUESTED' || fence.status !== 'RAISED') throw new DomainError('INVALID_TRANSITION', `the lift of ${fence.ref} was already decided`);
    const note = p.note ? requireText(p.note, 'note', 500) : null;
    if (p.approve) {
      assertSecondApprover(decision, lift.requested_by, actor.userId);
      // Whatever the role table says, the person who reconciled does not release the payments.
      if (lift.requested_by === actor.userId) throw new DomainError('SECOND_APPROVER_REQUIRED', 'the lift must be approved by someone other than the person who reconciled');
    }
    await ctx.tx
      .updateTable('restore_fence_lift')
      .set({ status: p.approve ? 'APPROVED' : 'DECLINED', decided_by: actor.userId, decided_at: sql<Date>`inrp2p_now()`, decision_note: note })
      .where('id', '=', lift.id)
      .execute();
    if (p.approve) {
      await ctx.tx.updateTable('restore_fence').set({ status: 'LIFTED', lift_id: lift.id, lifted_by: actor.userId, lifted_at: sql<Date>`inrp2p_now()` }).where('id', '=', fence.id).execute();
    }
    await appendAudit(ctx, {
      action: p.approve ? 'operations.restore_fence_lifted' : 'operations.restore_fence_lift_declined', entityType: 'restore_fence', entityId: fence.id,
      before: { status: 'RAISED' }, after: { ref: fence.ref, lift_id: lift.id, status: p.approve ? 'LIFTED' : 'RAISED', requested_by: lift.requested_by, decided_by: actor.userId, note },
    });
    return restoreFenceState(ctx.tx);
  });
}
