import { sql } from 'kysely';
import { DomainError, Money, requireOneOf, requireText, requireUuid } from '@inrp2p/kernel';
import type { AdjustmentType, Executor } from '@inrp2p/db';
import { appendAudit } from '@inrp2p/audit';
import { enqueueOutbox } from '@inrp2p/outbox';
import { type OperatorActor, operatorCommand } from '@inrp2p/identity';
import { adjustmentJournal, postJournal } from '@inrp2p/ledger';
import { type TradeRow, effectiveObligations, legTotals, lockTrade, tradeEconomics } from '@inrp2p/trades';
import { resolveExceptionInTx } from './exceptions.ts';
import { type ObligationRow, lockObligation, obligationRemaining, refreshObligationStatus } from './obligations.ts';
import { advanceTrade } from './progress.ts';

export interface RequestAdjustmentPayload {
  readonly tradeId: string;
  readonly type: AdjustmentType;
  /** Signed decimal deltas on the frozen terms; the margin delta is derived, never supplied (FI-02). */
  readonly deltaBaseUsdt?: string;
  readonly deltaClientInr?: string;
  readonly deltaRouteInr?: string;
  readonly reason: string;
  readonly evidenceNote?: string | null;
  readonly exceptionId?: string | null;
}

const signedMinor = (value: string | undefined, currency: 'INR' | 'USDT'): bigint => {
  if (value === undefined || value === null || value === '') return 0n;
  const negative = value.trim().startsWith('-');
  const parsed = Money.parse(negative ? value.trim().slice(1) : value, currency);
  return negative ? -parsed.minor : parsed.minor;
};

interface AdjustmentDeltas {
  readonly base: bigint;
  readonly client: bigint;
  readonly route: bigint;
}

/**
 * What an adjustment may do to a trade (FI-12 together with FI-20, FI-21 and FI-61). The frozen economics never
 * change, but the effective terms do, and every invariant measured against them must still hold afterwards:
 *
 * - a cancelled trade has been reversed in full, so there is nothing left to adjust;
 * - a completed trade is settled with the client, so only the route side and the margin may still move — a change
 *   to what the client pays or receives would leave a COMPLETED trade owing or owed (FI-21);
 * - the payout obligation stays positive and never falls below the payouts already committed (FI-20), and what
 *   the client owes never falls below what already arrived — otherwise neither side could ever settle;
 * - neither route side falls below what the route already settled against it (FI-61), and a settled obligation
 *   is not re-opened (SETTLED is terminal, STATE_MACHINES §9).
 *
 * Deltas are checked against the effective terms **including every adjustment already posted**, so two
 * adjustments approved one after the other cannot add up to something neither would have been allowed to do.
 */
async function assertAdjustmentFits(
  ex: Executor,
  trade: TradeRow,
  direction: 'SELL_USDT' | 'BUY_USDT',
  obligation: Pick<ObligationRow, 'id' | 'status'>,
  d: AdjustmentDeltas,
): Promise<void> {
  if (trade.lifecycle_state === 'CANCELLED') throw new DomainError('INVALID_TRANSITION', 'the trade is cancelled; there is nothing left to adjust');
  const sell = direction === 'SELL_USDT';
  const payoutDelta = sell ? d.client : d.base;
  const receivableDelta = sell ? d.base : d.client;
  if (trade.lifecycle_state === 'COMPLETED' && (payoutDelta !== 0n || receivableDelta !== 0n)) {
    throw new DomainError('INVALID_AMOUNT', 'a completed trade is settled with the client; only the route side and the margin can still be corrected');
  }
  const { payout, receivable } = await effectiveObligations(ex, trade.id);
  const totals = await legTotals(ex, trade.id);
  const payoutAfter = payout.minor + payoutDelta;
  if (payoutAfter <= 0n || payoutAfter < totals.committed) {
    throw new DomainError('INVALID_AMOUNT', 'the adjusted payout obligation would be smaller than the payouts already committed', {
      payoutAfter: payoutAfter.toString(), committed: totals.committed.toString(),
    });
  }
  const receivableAfter = receivable.minor + receivableDelta;
  if (receivableAfter <= 0n || receivableAfter < totals.received) {
    throw new DomainError('INVALID_AMOUNT', 'the adjusted amount the client owes would be smaller than what the client already sent', {
      receivableAfter: receivableAfter.toString(), received: totals.received.toString(),
    });
  }
  const routeDeliversDelta = sell ? d.route : d.base;
  const exchangeDeliversDelta = sell ? d.base : d.route;
  if (obligation.status === 'SETTLED' && (routeDeliversDelta > 0n || exchangeDeliversDelta > 0n)) {
    throw new DomainError('INVALID_TRANSITION', 'the route obligation is already settled and cannot be re-opened by an adjustment');
  }
  const remaining = await obligationRemaining(ex, obligation.id);
  if (remaining.routeDelivers.minor + routeDeliversDelta < 0n || remaining.exchangeDelivers.minor + exchangeDeliversDelta < 0n) {
    throw new DomainError('INVALID_AMOUNT', 'the adjusted route obligation would be smaller than what was already settled with the route');
  }
}

/**
 * `adjustment.request` — `adjustment:request`. A correction never edits the frozen economics (FI-12): it records
 * a signed delta that, once approved, changes the effective terms and posts its own compensating journal.
 */
export function requestAdjustment(actor: OperatorActor) {
  return operatorCommand(actor, 'adjustment:request', async (ctx, p: RequestAdjustmentPayload) => {
    const trade = await lockTrade(ctx.tx, p.tradeId);
    const econ = await tradeEconomics(ctx.tx, trade.id);
    const type = requireOneOf(p.type, 'type', ['AMOUNT_CORRECTION', 'RATE_CORRECTION', 'FEE', 'WRITE_OFF', 'REFUND'] as const);
    const reason = requireText(p.reason, 'reason', 2000);
    if (reason.length < 10) throw new DomainError('INVALID_ARGUMENT', 'an adjustment reason must explain what happened');
    const deltaBase = signedMinor(p.deltaBaseUsdt, 'USDT');
    const deltaClient = signedMinor(p.deltaClientInr, 'INR');
    const deltaRoute = signedMinor(p.deltaRouteInr, 'INR');
    const deltaMargin = econ.direction === 'SELL_USDT' ? deltaRoute - deltaClient : deltaClient - deltaRoute;
    if (deltaBase === 0n && deltaClient === 0n && deltaRoute === 0n) throw new DomainError('INVALID_AMOUNT', 'an adjustment must change something');
    // Early answer for the requester; approval checks again under its locks, against whatever happened since.
    const obligation = await ctx.tx.selectFrom('route_obligation').select(['id', 'status']).where('id', '=', econ.routeObligationId).executeTakeFirstOrThrow();
    await assertAdjustmentFits(ctx.tx, trade, econ.direction, obligation, { base: deltaBase, client: deltaClient, route: deltaRoute });

    const row = await ctx.tx
      .insertInto('financial_adjustment')
      .values({
        trade_id: trade.id,
        type,
        delta_base_minor: deltaBase,
        delta_quote_inr_minor: deltaClient,
        delta_route_inr_minor: deltaRoute,
        delta_margin_inr_minor: deltaMargin,
        reason,
        evidence_note: p.evidenceNote ? requireText(p.evidenceNote, 'evidenceNote', 2000) : null,
        exception_case_id: p.exceptionId ?? null,
        requested_by: ctx.actor.id ?? 'SYSTEM',
      })
      .returning(['id', 'ref'])
      .executeTakeFirstOrThrow();
    await appendAudit(ctx, {
      action: 'adjustment.requested', entityType: 'financial_adjustment', entityId: row.id,
      after: { ref: row.ref, trade_id: trade.id, type, delta_base: deltaBase.toString(), delta_client_inr: deltaClient.toString(), delta_route_inr: deltaRoute.toString(), delta_margin_inr: deltaMargin.toString(), reason },
    });
    await enqueueOutbox(ctx, { type: 'desk.adjustment_requested', aggregateType: 'financial_adjustment', aggregateId: row.id, payload: { adjustmentId: row.id, tradeId: trade.id } });
    return { adjustmentId: row.id, ref: row.ref, deltaMarginInr: Money.ofMinor(deltaMargin < 0n ? -deltaMargin : deltaMargin, 'INR').toDecimalString(), marginSign: deltaMargin < 0n ? '-' : '+' };
  });
}

/**
 * `adjustment.approve` — `adjustment:approve` (⧗✱, a second person). Posts `adj:{id}` and, from that moment,
 * the effective obligations include the delta (FI-12, FI-20, FI-21). A completed trade books a margin delta
 * straight to realized revenue (FI-43).
 */
export function approveAdjustment(actor: OperatorActor) {
  return operatorCommand(actor, 'adjustment:approve', async (ctx, p: { adjustmentId: string; notes?: string | null }) => {
    const a = await ctx.tx.selectFrom('financial_adjustment').selectAll().where('id', '=', requireUuid(p.adjustmentId, 'adjustmentId')).forUpdate().executeTakeFirst();
    if (!a) throw new DomainError('NOT_FOUND', 'adjustment not found');
    if (a.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `adjustment is ${a.status}`);
    const approver = ctx.actor.id ?? 'SYSTEM';
    if (approver === a.requested_by) throw new DomainError('SECOND_APPROVER_REQUIRED', 'an adjustment is approved by a different person than the one who requested it');
    // Lock order: trade → route obligation (ARCHITECTURE §4). Both are re-checked here, not trusted from the
    // request: payouts, receipts and route settlements may all have moved since the adjustment was asked for.
    const trade = await lockTrade(ctx.tx, a.trade_id);
    const econ = await tradeEconomics(ctx.tx, trade.id);
    const obligation = await lockObligation(ctx, econ.routeObligationId);
    await assertAdjustmentFits(ctx.tx, trade, econ.direction, obligation, { base: a.delta_base_minor, client: a.delta_quote_inr_minor, route: a.delta_route_inr_minor });

    const journal = await postJournal(
      ctx,
      adjustmentJournal(
        { baseMinor: a.delta_base_minor, clientInrMinor: a.delta_quote_inr_minor, routeInrMinor: a.delta_route_inr_minor, marginInrMinor: a.delta_margin_inr_minor },
        {
          adjustmentId: a.id,
          tradeId: trade.id,
          clientId: trade.client_id,
          routeId: econ.routeId,
          routeObligationId: obligation.id,
          direction: econ.direction,
          marginRealized: trade.lifecycle_state === 'COMPLETED',
        },
      ),
    );
    await ctx.tx
      .updateTable('financial_adjustment')
      .set({ status: 'POSTED', approved_by: approver, approved_at: sql<Date>`inrp2p_now()`, ledger_journal_id: journal.id })
      .where('id', '=', a.id)
      .execute();
    if (a.exception_case_id) {
      await resolveExceptionInTx(ctx, { exceptionId: a.exception_case_id, resolution: 'financial_adjustment', notes: requireText(p.notes ?? a.reason, 'notes', 2000), financialAdjustmentId: a.id });
    }
    await appendAudit(ctx, {
      action: 'adjustment.approved', entityType: 'financial_adjustment', entityId: a.id,
      before: { status: 'REQUESTED' }, after: { status: 'POSTED', approved_by: approver, journal: journal.postingKey },
    });
    // The effective terms moved without a movement, so whatever they now say is settled is settled now: an
    // obligation side brought down to what the route delivered, a trade brought down to what was received or paid.
    await refreshObligationStatus(ctx, obligation);
    await advanceTrade(ctx, trade.id);
    return { status: 'POSTED' as const, postingKey: journal.postingKey };
  });
}

/** `adjustment.reject` — `adjustment:approve`. The request is kept; nothing is posted. */
export function rejectAdjustment(actor: OperatorActor) {
  return operatorCommand(actor, 'adjustment:approve', async (ctx, p: { adjustmentId: string; reason: string }) => {
    const reason = requireText(p.reason, 'reason', 500);
    const a = await ctx.tx.selectFrom('financial_adjustment').select(['id', 'status', 'requested_by']).where('id', '=', requireUuid(p.adjustmentId, 'adjustmentId')).forUpdate().executeTakeFirst();
    if (!a) throw new DomainError('NOT_FOUND', 'adjustment not found');
    if (a.status !== 'REQUESTED') throw new DomainError('INVALID_TRANSITION', `adjustment is ${a.status}`);
    if ((ctx.actor.id ?? 'SYSTEM') === a.requested_by) throw new DomainError('SECOND_APPROVER_REQUIRED', 'the requester cannot decide their own adjustment');
    await ctx.tx
      .updateTable('financial_adjustment')
      .set({ status: 'REJECTED', rejected_by: ctx.actor.id ?? 'SYSTEM', rejected_at: sql<Date>`inrp2p_now()`, reject_reason: reason })
      .where('id', '=', a.id)
      .execute();
    await appendAudit(ctx, { action: 'adjustment.rejected', entityType: 'financial_adjustment', entityId: a.id, before: { status: 'REQUESTED' }, after: { status: 'REJECTED', reason } });
    return { status: 'REJECTED' as const };
  });
}

/** Effective terms for the desk: frozen economics ⊕ posted adjustments, with the deltas listed. */
export async function effectiveTerms(ex: Executor, tradeId: string) {
  const econ = await tradeEconomics(ex, tradeId);
  const rows = await ex
    .selectFrom('financial_adjustment')
    .select(['ref', 'type', 'delta_base_minor', 'delta_quote_inr_minor', 'delta_route_inr_minor', 'delta_margin_inr_minor'])
    .where('trade_id', '=', tradeId)
    .where('status', '=', 'POSTED')
    .orderBy('requested_at')
    .execute();
  const sum = (pick: (r: (typeof rows)[number]) => bigint) => rows.reduce((acc, r) => acc + pick(r), 0n);
  return {
    base: Money.ofMinor(econ.base.minor + sum((r) => r.delta_base_minor), 'USDT'),
    clientInr: Money.ofMinor(econ.clientInr.minor + sum((r) => r.delta_quote_inr_minor), 'INR'),
    routeInr: Money.ofMinor(econ.routeInr.minor + sum((r) => r.delta_route_inr_minor), 'INR'),
    grossMargin: Money.ofMinor(econ.grossMargin.minor + sum((r) => r.delta_margin_inr_minor), 'INR'),
    adjustments: rows.map((r) => ({ ref: r.ref, type: r.type })),
  };
}
